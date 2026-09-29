import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { gatherWorkspaceSnapshot } from "../../src/workspace-context.js";

/* The per-turn workspace state reported every diagnostic VS Code held, including those for a
   scratch file the agent had already deleted, and listed that file as open. The agent then
   read the stale errors as current and went back to fix or verify a file that was gone. */

describe("workspace state and deleted files", () => {
  let dir: string;
  const workspace = vscode.workspace as unknown as { textDocuments?: unknown[] };
  const runtime = { handleMessage: async () => ({ result: { ok: false, message: "not a git repository" } }) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-state-"));
    fs.writeFileSync(path.join(dir, "kept.ts"), "export {}");
    vscode.workspace.workspaceFolders = [{ name: "workspace", index: 0, uri: vscode.Uri.file(dir) }];
    vscode.languages.__clearDiagnostics();
  });

  afterEach(() => {
    vscode.languages.__clearDiagnostics();
    vscode.workspace.workspaceFolders = undefined;
    workspace.textDocuments = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts only diagnostics for files that still exist, and lists only those as open", async () => {
    const kept = vscode.Uri.file(path.join(dir, "kept.ts"));
    const gone = vscode.Uri.file(path.join(dir, "scratch.mjs"));
    workspace.textDocuments = [
      { uri: kept, isUntitled: false, isDirty: false },
      { uri: gone, isUntitled: false, isDirty: false },
    ];
    const error = (message: string) => ({ message, severity: vscode.DiagnosticSeverity.Error, range: new vscode.Range(0, 0, 0, 1) });
    vscode.languages.__setDiagnostics(kept, [error("real problem")]);
    vscode.languages.__setDiagnostics(gone, [error("stale problem"), error("another stale one")]);

    const snapshot = await gatherWorkspaceSnapshot(dir, runtime as never);

    expect(snapshot.diagnosticSummary).toBe("1 error(s), 0 warning(s) in workspace");
    expect(snapshot.diagnosticDetails).toContain("real problem");
    expect(snapshot.diagnosticDetails).not.toContain("stale");
    expect(snapshot.openFiles).toEqual(["kept.ts"]);
  });
});
