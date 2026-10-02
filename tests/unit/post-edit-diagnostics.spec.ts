import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { collectDiagnosticSnapshot, startDiagnosticPublishTracker } from "../../src/post-edit-diagnostics.js";

/* Whether a quiet wait means "current" or "timed out". The language server usually publishes
   moments after an edit, so by the time the agent asks, nothing new arrives; the publish history
   is what tells a settled file from a stale one, and a file nobody ever checked from both. */

type MockWorkspace = typeof vscode.workspace & {
  textDocuments?: Array<{ uri: vscode.Uri; version: number; isDirty?: boolean }>;
  openTextDocument: (uri: vscode.Uri) => Promise<unknown>;
};
type MockLanguages = typeof vscode.languages & {
  __fireDiagnostics(uris: vscode.Uri[]): void;
  __clearDiagnostics(): void;
};

const workspace = vscode.workspace as MockWorkspace;
const languages = vscode.languages as MockLanguages;
const originalOpen = workspace.openTextDocument;
const ROOT = path.join(os.tmpdir(), "blacksite-diag-root");
const uriOf = (relative: string): vscode.Uri => vscode.Uri.file(path.join(ROOT, relative));

let tracker: { dispose(): void } | undefined;
const versions = new Map<string, number>();

function open(relative: string, version: number): vscode.Uri {
  const uri = uriOf(relative);
  versions.set(uri.toString(), version);
  workspace.textDocuments = [...versions].map(([key, value]) => ({ uri: vscode.Uri.parse(key), version: value }));
  return uri;
}

function snapshot(uris: vscode.Uri[]) {
  return collectDiagnosticSnapshot(ROOT, { uris, waitForChange: true, scope: "file", timeoutMs: 40, quietMs: 5 });
}

beforeEach(() => {
  versions.clear();
  workspace.textDocuments = [];
  workspace.openTextDocument = async (uri: vscode.Uri) => ({ uri, version: versions.get(uri.toString()) ?? 1 });
  languages.__clearDiagnostics();
});

afterEach(() => {
  tracker?.dispose();
  tracker = undefined;
  workspace.openTextDocument = originalOpen;
  delete workspace.textDocuments;
});

describe("diagnostic freshness", () => {
  it("reads a settled file as current when its last publish matches the open version", async () => {
    tracker = startDiagnosticPublishTracker();
    const uri = open("src/app.py", 3);
    languages.__fireDiagnostics([uri]);

    const result = await snapshot([uri]);

    expect(result.status).toBe("ready");
    expect(Object.values(result.freshness.files ?? {})).toEqual(["ready"]);
  });

  it("says no checker covers a file nothing has ever published for", async () => {
    tracker = startDiagnosticPublishTracker();
    const uri = open("docs/guide.md", 1);

    const result = await snapshot([uri]);

    expect(result.status).toBe("no_checker");
  });

  it("times out when the last publish describes older content", async () => {
    tracker = startDiagnosticPublishTracker();
    const uri = open("src/app.py", 2);
    languages.__fireDiagnostics([uri]);
    open("src/app.py", 3);

    const result = await snapshot([uri]);

    expect(result.status).toBe("timed_out");
  });

  it("counts a publish during the wait as current", async () => {
    tracker = startDiagnosticPublishTracker();
    const uri = open("src/app.py", 4);
    setTimeout(() => languages.__fireDiagnostics([uri]), 5);

    const result = await snapshot([uri]);

    expect(result.status).toBe("ready");
    expect(result.freshness.observedDiagnosticChange).toBe(true);
  });

  it("reports each file of a batch, and is ready when the rest have no checker", async () => {
    tracker = startDiagnosticPublishTracker();
    const code = open("src/app.py", 1);
    const yaml = open("deploy/values.yaml", 1);
    languages.__fireDiagnostics([code]);

    const result = await snapshot([code, yaml]);

    expect(result.status).toBe("ready");
    expect(Object.values(result.freshness.files ?? {}).sort()).toEqual(["no_checker", "ready"]);
  });

  it("reads a publish made while the file was closed as current if the file has not changed since", async () => {
    tracker = startDiagnosticPublishTracker();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-diag-"));
    try {
      const file = path.join(dir, "closed.py");
      fs.writeFileSync(file, "x = 1\n");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(file, old, old);
      const uri = vscode.Uri.file(file);
      languages.__fireDiagnostics([uri]);

      const result = await collectDiagnosticSnapshot(dir, { uris: [uri], waitForChange: true, scope: "file", timeoutMs: 40, quietMs: 5 });

      expect(result.status).toBe("ready");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the old reading when the tracker is not running", async () => {
    const uri = open("src/app.py", 1);

    const result = await snapshot([uri]);

    expect(result.status).toBe("timed_out");
    expect(result.freshness.files).toBeUndefined();
  });
});
