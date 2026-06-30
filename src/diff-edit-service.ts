import * as vscode from "vscode";
import * as path from "path";
import type { WorkspaceEditApplier } from "./workspace-edit-applier.js";
import { collectForUris } from "./post-edit-diagnostics.js";
import type { ChangedDiagnostics } from "./post-edit-diagnostics.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditBatchInput {
  edits: EditInput[];
}

export type EditResult =
  | { ok: true; path: string; replacements: number; diagnostics?: ChangedDiagnostics; autoApproveAll?: boolean }
  | { ok: false; error: string };

export type EditBatchResult =
  | {
    ok: true;
    files: number;
    edits: number;
    replacements: number;
    results: Array<{ path: string; replacements: number }>;
    diagnostics?: ChangedDiagnostics;
    autoApproveAll?: boolean;
  }
  | { ok: false; error: string };

export interface EditProvider {
  applyEdit(input: EditInput, opts: { autoApprove: boolean }): Promise<EditResult>;
  applyBatchEdits(input: EditBatchInput, opts: { autoApprove: boolean }): Promise<EditBatchResult>;
}

// ── DiffEditService ──────────────────────────────────────────────────────────
// Surgical exact-string edits. Validation lives here; the diff preview, approval,
// and application are delegated to the shared WorkspaceEditApplier.

export class DiffEditService implements EditProvider {
  constructor(
    private readonly _workspaceRoot: string,
    private readonly _applier: WorkspaceEditApplier,
  ) {}

  private _resolve(p: string): vscode.Uri {
    const abs = path.isAbsolute(p) ? p : path.join(this._workspaceRoot, p);
    return vscode.Uri.file(abs);
  }

  async applyEdit(input: EditInput, opts: { autoApprove: boolean }): Promise<EditResult> {
    const rel = input.path;
    if (!rel) return { ok: false, error: "path is required." };
    if (!input.oldString) return { ok: false, error: "oldString must not be empty — use file_write to create or overwrite a file." };
    if (input.oldString === input.newString) return { ok: false, error: "oldString and newString are identical — nothing to change." };

    const uri = this._resolve(rel);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${rel}. Use file_write to create a new file.` };
    }

    const original = doc.getText();
    const occurrences = countOccurrences(original, input.oldString);
    if (occurrences === 0) {
      return { ok: false, error: `oldString was not found in ${rel}. Read the file and copy the exact text (including whitespace).` };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return { ok: false, error: `oldString matches ${occurrences} locations in ${rel}. Add surrounding context to make it unique, or set replaceAll:true.` };
    }

    const updated = input.replaceAll
      ? original.split(input.oldString).join(input.newString)
      : replaceFirst(original, input.oldString, input.newString);
    const replacements = input.replaceAll ? occurrences : 1;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), updated);

    const res = await this._applier.apply(edit, { summary: `${replacements} edit(s) in ${rel}`, autoApprove: opts.autoApprove });
    if (!res.applied) return { ok: false, error: "User rejected the edit." };

    const diagnostics = await collectForUris([uri], this._workspaceRoot);
    return { ok: true, path: rel, replacements, diagnostics, autoApproveAll: res.autoApproveAll || undefined };
  }

  async applyBatchEdits(input: EditBatchInput, opts: { autoApprove: boolean }): Promise<EditBatchResult> {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { ok: false, error: "At least one edit is required." };
    }

    const grouped = new Map<string, EditInput[]>();
    for (const edit of input.edits) {
      const rel = String(edit.path ?? "").trim();
      if (!rel) return { ok: false, error: "Each edit requires a path." };
      if (edit.oldString === edit.newString) {
        return { ok: false, error: `oldString and newString are identical in ${rel}.` };
      }
      const bucket = grouped.get(rel) ?? [];
      bucket.push({
        path: rel,
        oldString: String(edit.oldString ?? ""),
        newString: String(edit.newString ?? ""),
        replaceAll: edit.replaceAll === true,
      });
      grouped.set(rel, bucket);
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    const fileResults: Array<{ path: string; replacements: number }> = [];
    let totalReplacements = 0;
    const touchedUris: vscode.Uri[] = [];

    for (const [rel, edits] of grouped.entries()) {
      const uri = this._resolve(rel);
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        return { ok: false, error: `Could not open ${rel}. Use file_write to create new files.` };
      }

      let text = doc.getText();
      let replacementsForFile = 0;
      for (const edit of edits) {
        const occurrences = countOccurrences(text, edit.oldString);
        if (occurrences === 0) {
          return { ok: false, error: `oldString was not found in ${rel}. Read the file and copy the exact text (including whitespace).` };
        }
        if (occurrences > 1 && !edit.replaceAll) {
          return { ok: false, error: `oldString matches ${occurrences} locations in ${rel}. Add surrounding context or set replaceAll:true.` };
        }
        text = edit.replaceAll
          ? text.split(edit.oldString).join(edit.newString)
          : replaceFirst(text, edit.oldString, edit.newString);
        const replacements = edit.replaceAll ? occurrences : 1;
        replacementsForFile += replacements;
        totalReplacements += replacements;
      }

      workspaceEdit.replace(
        uri,
        new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        text,
      );
      touchedUris.push(uri);
      fileResults.push({ path: rel, replacements: replacementsForFile });
    }

    const res = await this._applier.apply(workspaceEdit, {
      summary: `${totalReplacements} edit(s) across ${fileResults.length} file(s)`,
      autoApprove: opts.autoApprove,
    });
    if (!res.applied) return { ok: false, error: "User rejected the edit batch." };

    const diagnostics = await collectForUris(touchedUris, this._workspaceRoot);
    return {
      ok: true,
      files: fileResults.length,
      edits: input.edits.length,
      replacements: totalReplacements,
      results: fileResults,
      diagnostics,
      autoApproveAll: res.autoApproveAll || undefined,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}
