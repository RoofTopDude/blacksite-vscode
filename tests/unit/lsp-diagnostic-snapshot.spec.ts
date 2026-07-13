import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { captureDiagnosticBaseline, collectDiagnosticSnapshot } from "../../src/post-edit-diagnostics.js";

const root = "C:/workspace";

describe("DiagnosticSnapshot", () => {
  beforeEach(() => {
    vscode.workspace.workspaceFolders = [{ name: "workspace", index: 0, uri: vscode.Uri.file(root) }];
    vscode.languages.__clearDiagnostics();
  });

  afterEach(() => {
    vscode.languages.__clearDiagnostics();
    vscode.workspace.workspaceFolders = undefined;
  });

  it("keeps filtered counts distinct from all severities and marks workspace cache coverage partial", async () => {
    const a = vscode.Uri.file(`${root}/a.ts`);
    const b = vscode.Uri.file(`${root}/b.ts`);
    vscode.languages.__setDiagnostics(a, [diagnostic("warning", "lint", 1)]);
    vscode.languages.__setDiagnostics(b, [diagnostic("error", "error", 0), diagnostic("hint", "hint", 3)]);

    const snapshot = await collectDiagnosticSnapshot(root, { severity: "warning", limit: 10 });

    expect(snapshot).toMatchObject({
      status: "partial",
      scope: "published_workspace",
      counts: { error: 1, warning: 1, info: 0, hint: 0 },
      allCounts: { error: 1, warning: 1, info: 0, hint: 1 },
      coverage: { diagnosticUris: 2 },
    });
    expect(snapshot.problems.map((problem) => problem.severity)).toEqual(["error", "warning"]);
  });

  it("returns introduced, resolved, and persisting diagnostics from a baseline", async () => {
    const uri = vscode.Uri.file(`${root}/file.ts`);
    vscode.languages.__setDiagnostics(uri, [diagnostic("old warning", "lint", 1), diagnostic("stays", "lint", 1, 1)]);
    const baseline = await captureDiagnosticBaseline([uri], root);
    vscode.languages.__setDiagnostics(uri, [diagnostic("new error", "ts", 0), diagnostic("stays", "lint", 1, 1)]);

    const snapshot = await collectDiagnosticSnapshot(root, {
      uris: [uri],
      baseline,
      waitForChange: false,
      scope: "file",
    });

    expect(snapshot.status).toBe("unknown");
    expect(snapshot.delta?.introduced.map((problem) => problem.message)).toEqual(["new error"]);
    expect(snapshot.delta?.resolved.map((problem) => problem.message)).toEqual(["old warning"]);
    expect(snapshot.delta?.persisting.map((problem) => problem.message)).toEqual(["stays"]);
  });

  it("preserves code targets, tags, ranges, and workspace-safe related information", async () => {
    const uri = vscode.Uri.file(`${root}/file.ts`);
    const related = vscode.Uri.file(`${root}/related.ts`);
    const codeTarget = vscode.Uri.parse("https://example.invalid/diagnostic/123");
    vscode.languages.__setDiagnostics(uri, [{
      ...diagnostic("deprecated", "ts", 1),
      code: { value: 123, target: codeTarget },
      tags: [vscode.DiagnosticTag.Deprecated],
      relatedInformation: [{
        location: { uri: related, range: new vscode.Range(3, 4, 3, 8) },
        message: "declared here",
      }],
    }]);

    const snapshot = await collectDiagnosticSnapshot(root, { uris: [uri], waitForChange: false, scope: "file" });

    expect(snapshot.problems[0]).toMatchObject({
      line: 3,
      column: 1,
      endLine: 3,
      endColumn: 3,
      code: "123",
      codeTarget: codeTarget.toString(),
      tags: ["deprecated"],
      relatedInformation: [{ path: "related.ts", line: 4, column: 5, message: "declared here" }],
    });
  });
});

function diagnostic(message: string, source: string, severity: number, line = 2): Record<string, unknown> {
  return {
    message,
    source,
    severity,
    range: new vscode.Range(line, 0, line, 2),
  };
}
