import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { WorkspaceEditApplier, type EditApprovalProvider } from "../../src/workspace-edit-applier.js";

const root = "C:/workspace";

describe("WorkspaceEditApplier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace.workspaceFolders = undefined;
  });

  it("requires approval for a resource-only edit even with autoApprove", async () => {
    const created = vscode.Uri.file(`${root}/created.ts`);
    const edit = resourceEdit({ size: 1, allEntries: [[created, [{ _newUri: created }]]] });
    const approval = vi.fn<EditApprovalProvider>(async () => "apply");
    const applyEdit = vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(true);
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue({ uri: created, version: 1, isDirty: false } as never);
    const applier = createApplier(approval);

    const result = await applier.apply(edit, { summary: "Create generated file", autoApprove: true });

    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ resourceOperations: 1 }));
    expect(applyEdit).toHaveBeenCalledWith(edit);
    expect(result).toMatchObject({ applied: true, resourceOperations: 1, saved: true });
    expect(result.resourceOperationDetails[0]).toMatchObject({ kind: "create", to: created });
    applier.dispose();
  });

  it("blocks resource targets outside the workspace before approval or apply", async () => {
    const outside = vscode.Uri.file("C:/other/created.ts");
    const edit = resourceEdit({ size: 1, allEntries: [[outside, [{ _newUri: outside }]]] });
    const approval = vi.fn<EditApprovalProvider>(async () => "apply");
    const applyEdit = vi.spyOn(vscode.workspace, "applyEdit");
    const applier = createApplier(approval);

    const result = await applier.apply(edit, { summary: "Unsafe create", autoApprove: false });

    expect(result).toMatchObject({ applied: false, reason: "outside_workspace" });
    expect(approval).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
    applier.dispose();
  });

  it("returns a conflict when the prepared document version is stale", async () => {
    const uri = vscode.Uri.file(`${root}/source.ts`);
    const textEdit = { range: new vscode.Range(0, 0, 0, 1), newText: "x" };
    const edit = {
      size: 1,
      entries: () => [[uri, [textEdit]]],
      _allEntries: [[uri, [textEdit]]],
    } as unknown as vscode.WorkspaceEdit;
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue({ uri, version: 2, isDirty: false } as never);
    const applyEdit = vi.spyOn(vscode.workspace, "applyEdit");
    const applier = createApplier(async () => "apply");

    const result = await applier.apply(edit, {
      summary: "Stale edit",
      autoApprove: true,
      expectedVersions: new Map([[uri.toString(), 1]]),
    });

    expect(result).toMatchObject({ applied: false, reason: "conflict" });
    expect(applyEdit).not.toHaveBeenCalled();
    applier.dispose();
  });

  it("returns a per-file line impact for previewable text edits", async () => {
    const uri = vscode.Uri.file(`${root}/source.ts`);
    const textEdit = { range: new vscode.Range(0, 0, 1, 2), newText: "new\nlines" };
    const edit = {
      size: 1,
      entries: () => [[uri, [textEdit]]],
      _allEntries: [[uri, [textEdit]]],
    } as unknown as vscode.WorkspaceEdit;
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue({ uri, version: 1, isDirty: false } as never);
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(true);
    const applier = createApplier(async () => "apply");

    const result = await applier.apply(edit, { summary: "Replace lines", autoApprove: true });

    expect(result).toMatchObject({
      applied: true,
      changes: [{ path: "source.ts", additions: 2, deletions: 2 }],
    });
    applier.dispose();
  });

  it("requires approval for snippet edits that the public entries API cannot preview", async () => {
    const uri = vscode.Uri.file(`${root}/snippet.ts`);
    const edit = {
      size: 1,
      entries: () => [],
      _allEntries: [[uri, [{ range: new vscode.Range(0, 0, 0, 0), snippet: { value: "${1:value}" } }]]],
    } as unknown as vscode.WorkspaceEdit;
    const approval = vi.fn<EditApprovalProvider>(async () => "apply");
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(true);
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue({ uri, version: 1, isDirty: false } as never);
    const applier = createApplier(approval);

    const result = await applier.apply(edit, { summary: "Snippet edit", autoApprove: true });

    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ snippetEdits: 1 }));
    expect(result).toMatchObject({ applied: true, edits: 1, resourceOperations: 0 });
    applier.dispose();
  });
});

function createApplier(approval: EditApprovalProvider): WorkspaceEditApplier {
  vscode.workspace.workspaceFolders = [{ name: "workspace", index: 0, uri: vscode.Uri.file(root) }];
  const applier = new WorkspaceEditApplier(root);
  applier.setApprovalProvider(approval);
  return applier;
}

function resourceEdit(opts: { size: number; allEntries: unknown[] }): vscode.WorkspaceEdit {
  return {
    size: opts.size,
    entries: () => [],
    _allEntries: opts.allEntries,
  } as unknown as vscode.WorkspaceEdit;
}
