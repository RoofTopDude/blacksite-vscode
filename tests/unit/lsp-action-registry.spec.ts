import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { ActionRegistry } from "../../src/lsp/action-registry.js";

describe("ActionRegistry", () => {
  it("binds an action handle to its document version", () => {
    const registry = new ActionRegistry();
    const uri = vscode.Uri.file("C:/workspace/file.ts");
    const [summary] = registry.register([{ title: "Fix", command: "fix.run" }], uri, 3);
    expect(summary?.actionId).toBeTruthy();
    expect(registry.resolve(summary!.actionId, uri, 4)).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  });

  it("refuses disabled actions", () => {
    const registry = new ActionRegistry();
    const uri = vscode.Uri.file("C:/workspace/file.ts");
    const action = { title: "Unavailable", disabled: { reason: "Needs configuration" } } as vscode.CodeAction;
    const [summary] = registry.register([action], uri, 1);
    expect(registry.resolve(summary!.actionId, uri, 1)).toMatchObject({ ok: false, error: expect.stringContaining("Needs configuration") });
  });

  it("expires stale handles", () => {
    const registry = new ActionRegistry(1);
    const uri = vscode.Uri.file("C:/workspace/file.ts");
    const [summary] = registry.register([{ title: "Fix", command: "fix.run" }], uri, 1);
    registry.prune(Date.now() + 10);
    expect(registry.resolve(summary!.actionId, uri, 1)).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
  });

  it("gives duplicate titles distinct handles and describes edit-plus-command actions", () => {
    const registry = new ActionRegistry();
    const uri = vscode.Uri.file("C:/workspace/file.ts");
    const edit = { size: 1 } as vscode.WorkspaceEdit;
    const summaries = registry.register([
      { title: "Fix", edit, command: { title: "Finish", command: "fix.finish" }, isPreferred: true } as vscode.CodeAction,
      { title: "Fix", command: "fix.other" },
    ], uri, 5);
    expect(summaries[0]).toMatchObject({ title: "Fix", hasEdit: true, hasCommand: true, isPreferred: true, documentVersion: 5 });
    expect(summaries[0]?.actionId).not.toBe(summaries[1]?.actionId);
  });
});
