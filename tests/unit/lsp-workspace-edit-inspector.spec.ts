import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { inspectWorkspaceEdit } from "../../src/lsp/workspace-edit-inspector.js";

describe("inspectWorkspaceEdit", () => {
  it("reports text, create, rename, touched URI, and destructive metadata", () => {
    const source = vscode.Uri.file("C:/workspace/source.ts");
    const created = vscode.Uri.file("C:/workspace/created.ts");
    const renamed = vscode.Uri.file("C:/workspace/renamed.ts");
    const textEdit = { range: new vscode.Range(0, 0, 0, 1), newText: "x" };
    const edit = {
      size: 3,
      entries: () => [[source, [textEdit]]],
      _allEntries: [
        [source, [textEdit]],
        [created, [{ _newUri: created, _options: { overwrite: true } }]],
        [source, [{ _oldUri: source, _newUri: renamed }]],
      ],
    } as unknown as vscode.WorkspaceEdit;

    const inspection = inspectWorkspaceEdit(edit);
    expect(inspection).toMatchObject({ textEdits: 1, snippetEdits: 0, opaqueResourceOperations: 0, destructive: true });
    expect(inspection.resourceOperations).toEqual([
      expect.objectContaining({ kind: "create", to: created, overwrite: true, destructive: true }),
      expect.objectContaining({ kind: "rename", from: source, to: renamed, destructive: false }),
    ]);
    expect(inspection.touchedUris.map((uri) => uri.toString())).toEqual([
      source.toString(),
      created.toString(),
      renamed.toString(),
    ]);
  });

  it("fails closed with an opaque resource count when internals are unavailable", () => {
    const edit = { size: 2, entries: () => [] } as unknown as vscode.WorkspaceEdit;
    expect(inspectWorkspaceEdit(edit)).toMatchObject({
      resourceOperations: [],
      opaqueResourceOperations: 2,
      destructive: true,
    });
  });

  it("recognizes recursive deletes", () => {
    const target = vscode.Uri.file("C:/workspace/generated");
    const edit = {
      size: 1,
      entries: () => [],
      _allEntries: [[target, [{ _oldUri: target, _options: { recursive: true } }]]],
    } as unknown as vscode.WorkspaceEdit;
    expect(inspectWorkspaceEdit(edit).resourceOperations[0]).toMatchObject({
      kind: "delete",
      from: target,
      recursive: true,
      destructive: true,
    });
  });

  it("accepts VS Code's iterable _allEntries representation", () => {
    const target = vscode.Uri.file("C:/workspace/generated.ts");
    const resource = { _newUri: target };
    const edit = {
      size: 1,
      entries: () => [],
      _allEntries: new Map([[target, resource]]).entries(),
    } as unknown as vscode.WorkspaceEdit;
    expect(inspectWorkspaceEdit(edit).resourceOperations[0]).toMatchObject({ kind: "create", to: target });
  });

  it("counts snippet edits as text resources rather than opaque file operations", () => {
    const target = vscode.Uri.file("C:/workspace/snippet.ts");
    const edit = {
      size: 1,
      entries: () => [],
      _allEntries: [[target, [{ range: new vscode.Range(0, 0, 0, 0), snippet: { value: "${1:value}" } }]]],
    } as unknown as vscode.WorkspaceEdit;
    expect(inspectWorkspaceEdit(edit)).toMatchObject({ snippetEdits: 1, opaqueResourceOperations: 0 });
    expect(inspectWorkspaceEdit(edit).touchedUris).toEqual([target]);
  });
});
