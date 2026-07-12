import * as vscode from "vscode";
import * as path from "path";
import type { WorkspaceEditApplier } from "./workspace-edit-applier.js";
import { collectForUris } from "./post-edit-diagnostics.js";
import type { ChangedDiagnostics } from "./post-edit-diagnostics.js";
import { applyJsonOperation, detectIndent, serializeJson, type JsonOperation, type JsonValue } from "./json-pointer.js";

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

export interface JsonEditInput {
  path: string;
  operations: JsonOperation[];
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

export type JsonEditResult =
  | { ok: true; path: string; operations: number; diagnostics?: ChangedDiagnostics; autoApproveAll?: boolean }
  | { ok: false; error: string };

export interface EditProvider {
  applyEdit(input: EditInput, opts: { autoApprove: boolean }): Promise<EditResult>;
  applyBatchEdits(input: EditBatchInput, opts: { autoApprove: boolean }): Promise<EditBatchResult>;
  applyJsonEdit(input: JsonEditInput, opts: { autoApprove: boolean }): Promise<JsonEditResult>;
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
    const { old: oldString, count: occurrences } = resolveOldString(original, input.oldString);
    if (occurrences === 0) {
      return { ok: false, error: `oldString was not found in ${rel} (also tried a whitespace-tolerant match). Read the file and copy the exact text (including whitespace).` };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return { ok: false, error: `oldString matches ${occurrences} locations in ${rel}. Add surrounding context to make it unique, or set replaceAll:true.` };
    }

    const updated = input.replaceAll
      ? original.split(oldString).join(input.newString)
      : replaceFirst(original, oldString, input.newString);
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
        const { old: oldString, count: occurrences } = resolveOldString(text, edit.oldString);
        if (occurrences === 0) {
          return { ok: false, error: `oldString was not found in ${rel} (also tried a whitespace-tolerant match). Read the file and copy the exact text (including whitespace).` };
        }
        if (occurrences > 1 && !edit.replaceAll) {
          return { ok: false, error: `oldString matches ${occurrences} locations in ${rel}. Add surrounding context or set replaceAll:true.` };
        }
        text = edit.replaceAll
          ? text.split(oldString).join(edit.newString)
          : replaceFirst(text, oldString, edit.newString);
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

  /** Structural JSON edit: mutates the parsed document via JSON Pointer operations instead
   *  of matching exact text, so reformatting/reordering/whitespace differences can't fail
   *  the edit the way an oldString mismatch can. Only handles plain JSON — JSON-with-comments
   *  (e.g. some tsconfig.json files) fails to parse and the caller is told to use file_edit. */
  async applyJsonEdit(input: JsonEditInput, opts: { autoApprove: boolean }): Promise<JsonEditResult> {
    const rel = input.path;
    if (!rel) return { ok: false, error: "path is required." };
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (operations.length === 0) return { ok: false, error: "At least one operation is required." };

    const uri = this._resolve(rel);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${rel}. Use file_write to create a new file.` };
    }

    const original = doc.getText();
    let root: JsonValue;
    try {
      root = JSON.parse(original) as JsonValue;
    } catch (err) {
      return {
        ok: false,
        error: `${rel} is not valid JSON (${err instanceof Error ? err.message : String(err)}). json_edit only supports plain JSON — for JSON-with-comments or other formats, use file_edit instead.`,
      };
    }

    for (const [i, operation] of operations.entries()) {
      if (!operation || typeof operation !== "object") return { ok: false, error: `operations[${i}] must be an object.` };
      const op = operation.op;
      if (op !== "set" && op !== "merge" && op !== "remove") {
        return { ok: false, error: `operations[${i}].op must be set, merge, or remove.` };
      }
      if (typeof operation.pointer !== "string") return { ok: false, error: `operations[${i}].pointer is required.` };
      const result = applyJsonOperation(root, operation);
      if (!result.ok) return { ok: false, error: `operations[${i}]: ${result.error}` };
    }

    const indent = detectIndent(original);
    const trailingNewline = original.endsWith("\n");
    const updated = serializeJson(root, indent, trailingNewline);
    if (updated === original) return { ok: false, error: "The operations produce no change — nothing to apply." };

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), updated);

    const res = await this._applier.apply(edit, {
      summary: `${operations.length} JSON operation(s) in ${rel}`,
      autoApprove: opts.autoApprove,
    });
    if (!res.applied) return { ok: false, error: "User rejected the edit." };

    const diagnostics = await collectForUris([uri], this._workspaceRoot);
    return { ok: true, path: rel, operations: operations.length, diagnostics, autoApproveAll: res.autoApproveAll || undefined };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * When an exact `oldString` match fails, try to locate the intended region with a
 * whitespace-tolerant, line-aligned comparison. The common cause of "oldString was
 * not found" in the execution logs was cosmetic: tabs vs spaces, trailing
 * whitespace, or a missing/extra final newline — the surrounding code is otherwise
 * identical. Returns the exact slice of `original` to replace, but only when a
 * single region matches, so an ambiguous edit can never be applied to the wrong place.
 */
export function findWhitespaceTolerantMatch(original: string, oldString: string): string | null {
  const origLines = original.split("\n");
  const needleLines = oldString.replace(/\n+$/, "").split("\n");
  if (needleLines.length === 0 || (needleLines.length === 1 && needleLines[0] === "")) return null;

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const needleNorm = needleLines.map(norm);

  // Character offset where each original line begins (line i spans [lineStart[i], …]).
  const lineStart: number[] = [];
  let off = 0;
  for (const line of origLines) { lineStart.push(off); off += line.length + 1; }

  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + needleLines.length <= origLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (norm(origLines[i + j]!) !== needleNorm[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const last = i + needleLines.length - 1;
    matches.push({ start: lineStart[i]!, end: lineStart[last]! + origLines[last]!.length });
    if (matches.length > 1) return null; // ambiguous — refuse rather than risk a wrong edit
  }
  if (matches.length !== 1) return null;
  return original.slice(matches[0]!.start, matches[0]!.end);
}

/**
 * Resolve the actual text in `text` that an edit's `oldString` should replace,
 * preferring an exact match and falling back to a whitespace-tolerant one.
 */
function resolveOldString(text: string, oldString: string): { old: string; count: number } {
  const exact = countOccurrences(text, oldString);
  if (exact > 0) return { old: oldString, count: exact };
  const flexible = findWhitespaceTolerantMatch(text, oldString);
  if (flexible) return { old: flexible, count: countOccurrences(text, flexible) };
  return { old: oldString, count: 0 };
}

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
