import * as vscode from "vscode";
import type { WorkspaceEditApplier } from "./workspace-edit-applier.js";
import { captureDiagnosticBaseline, collectForUris } from "./post-edit-diagnostics.js";
import type { ChangedDiagnostics } from "./post-edit-diagnostics.js";
import { applyJsonOperation, detectIndent, serializeJson, type JsonOperation, type JsonValue } from "./json-pointer.js";
import { stripLineNumberGutter } from "./line-gutter.js";
import { MutationCoordinator } from "./lsp/mutation-coordinator.js";
import { WorkspaceIdentity } from "./lsp/workspace-identity.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  /** When set, the edit only applies if oldString matches exactly this many locations — and
      then replaces all of them. Lets a refactor assert its blast radius ("this should hit
      exactly 3 places") instead of discovering afterwards that it silently hit 7. */
  expectedReplacements?: number;
}

export interface EditBatchInput {
  edits: EditInput[];
}

export interface JsonEditInput {
  path: string;
  operations: JsonOperation[];
}

export type EditResult =
  | { ok: true; path: string; replacements: number; diagnostics?: ChangedDiagnostics; autoApproveAll?: boolean; notice?: string }
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
    notice?: string;
  }
  | { ok: false; error: string };

export type JsonEditResult =
  | { ok: true; path: string; operations: number; diagnostics?: ChangedDiagnostics; autoApproveAll?: boolean }
  | { ok: false; error: string };

export interface MoveInput {
  source: string;
  destination: string;
  overwrite?: boolean;
}

export type MoveResult =
  | { ok: true; source: string; destination: string; diagnostics?: ChangedDiagnostics; notice?: string }
  | { ok: false; error: string };

export interface EditProvider {
  applyEdit(input: EditInput, opts: { autoApprove: boolean }): Promise<EditResult>;
  applyBatchEdits(input: EditBatchInput, opts: { autoApprove: boolean }): Promise<EditBatchResult>;
  applyJsonEdit(input: JsonEditInput, opts: { autoApprove: boolean }): Promise<JsonEditResult>;
  /** Optional: rename/move a file through VS Code's WorkspaceEdit so language servers can
      update imports via the will-rename participants (which plain fs.rename bypasses). */
  movePath?(input: MoveInput, opts: { autoApprove: boolean }): Promise<MoveResult>;
}

// ── DiffEditService ──────────────────────────────────────────────────────────
// Surgical exact-string edits. Validation lives here; the diff preview, approval,
// and application are delegated to the shared WorkspaceEditApplier.

export class DiffEditService implements EditProvider {
  private readonly _mutations: MutationCoordinator;
  private readonly _identity: WorkspaceIdentity;

  constructor(
    private readonly _workspaceRoot: string,
    private readonly _applier: WorkspaceEditApplier,
  ) {
    this._mutations = MutationCoordinator.forWorkspace(_workspaceRoot);
    this._identity = new WorkspaceIdentity(_workspaceRoot);
  }

  private _resolve(p: string) {
    return this._identity.resolve(p);
  }

  async applyEdit(input: EditInput, opts: { autoApprove: boolean }): Promise<EditResult> {
    return this._mutations.run(() => this._applyEdit(input, opts));
  }

  private async _applyEdit(input: EditInput, opts: { autoApprove: boolean }): Promise<EditResult> {
    const rel = input.path;
    if (!rel) return { ok: false, error: "path is required." };
    if (!input.oldString) return { ok: false, error: "oldString must not be empty — use file_write to create or overwrite a file." };
    if (input.oldString === input.newString) return { ok: false, error: "oldString and newString are identical — nothing to change." };

    const resolution = this._resolve(rel);
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const uri = resolution.value.uri;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${rel}. Use file_write to create a new file.` };
    }

    const original = doc.getText();
    const outcome = applyOneEdit(original, input, rel, dominantEol(original));
    if (!outcome.ok) return outcome;
    const { text: updated, replacements, deguttered } = outcome;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), updated);
    const baseline = await captureDiagnosticBaseline([uri], this._workspaceRoot);

    const res = await this._applier.apply(edit, {
      summary: `${replacements} edit(s) in ${rel}`,
      autoApprove: opts.autoApprove,
      expectedVersions: new Map([[uri.toString(), doc.version]]),
    });
    if (!res.applied) return { ok: false, error: editFailure(res.reason) };

    const diagnostics = await collectForUris([uri], this._workspaceRoot, { baseline });
    return {
      ok: true, path: rel, replacements, diagnostics,
      autoApproveAll: res.autoApproveAll || undefined,
      ...(deguttered ? { notice: GUTTER_NOTICE } : {}),
    };
  }

  async applyBatchEdits(input: EditBatchInput, opts: { autoApprove: boolean }): Promise<EditBatchResult> {
    return this._mutations.run(() => this._applyBatchEdits(input, opts));
  }

  private async _applyBatchEdits(input: EditBatchInput, opts: { autoApprove: boolean }): Promise<EditBatchResult> {
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
        expectedReplacements: edit.expectedReplacements,
      });
      grouped.set(rel, bucket);
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    const fileResults: Array<{ path: string; replacements: number }> = [];
    let totalReplacements = 0;
    const touchedUris: vscode.Uri[] = [];
    const expectedVersions = new Map<string, number>();
    let anyDeguttered = false;

    for (const [rel, edits] of grouped.entries()) {
      const resolution = this._resolve(rel);
      if (!resolution.ok) return { ok: false, error: resolution.error };
      const uri = resolution.value.uri;
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        return { ok: false, error: `Could not open ${rel}. Use file_write to create new files.` };
      }

      let text = doc.getText();
      const fileEol = dominantEol(text);
      let replacementsForFile = 0;
      for (const edit of edits) {
        const outcome = applyOneEdit(text, edit, rel, fileEol);
        if (!outcome.ok) return outcome;
        if (outcome.deguttered) anyDeguttered = true;
        text = outcome.text;
        replacementsForFile += outcome.replacements;
        totalReplacements += outcome.replacements;
      }

      workspaceEdit.replace(
        uri,
        new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        text,
      );
      touchedUris.push(uri);
      expectedVersions.set(uri.toString(), doc.version);
      fileResults.push({ path: rel, replacements: replacementsForFile });
    }

    const baseline = await captureDiagnosticBaseline(touchedUris, this._workspaceRoot);
    const res = await this._applier.apply(workspaceEdit, {
      summary: `${totalReplacements} edit(s) across ${fileResults.length} file(s)`,
      autoApprove: opts.autoApprove,
      expectedVersions,
    });
    if (!res.applied) return { ok: false, error: editFailure(res.reason) };

    const diagnostics = await collectForUris(touchedUris, this._workspaceRoot, { baseline });
    return {
      ok: true,
      files: fileResults.length,
      edits: input.edits.length,
      replacements: totalReplacements,
      results: fileResults,
      diagnostics,
      autoApproveAll: res.autoApproveAll || undefined,
      ...(anyDeguttered ? { notice: GUTTER_NOTICE } : {}),
    };
  }

  /**
   * Rename/move a file or directory through a WorkspaceEdit resource operation rather than
   * fs.rename. That routing is the whole point: VS Code fires the will-rename participants,
   * so language servers (TS "update imports on file move", etc.) can rewrite import paths of
   * every referencing file — a raw filesystem move silently breaks all of them. The applier
   * treats resource operations as explicitly-approved even under autoApprove.
   */
  async movePath(input: MoveInput, opts: { autoApprove: boolean }): Promise<MoveResult> {
    return this._mutations.run(() => this._movePath(input, opts));
  }

  private async _movePath(input: MoveInput, opts: { autoApprove: boolean }): Promise<MoveResult> {
    const source = String(input.source ?? "").trim();
    const destination = String(input.destination ?? "").trim();
    if (!source || !destination) return { ok: false, error: "source and destination are required." };

    const sourceResolution = this._resolve(source);
    if (!sourceResolution.ok) return { ok: false, error: sourceResolution.error };
    const destinationResolution = this._resolve(destination);
    if (!destinationResolution.ok) return { ok: false, error: destinationResolution.error };
    const fromUri = sourceResolution.value.uri;
    const toUri = destinationResolution.value.uri;
    if (fromUri.toString() === toUri.toString()) return { ok: false, error: "source and destination are the same path." };

    try {
      await vscode.workspace.fs.stat(fromUri);
    } catch {
      return { ok: false, error: `Source does not exist: ${source}` };
    }
    if (input.overwrite !== true) {
      try {
        await vscode.workspace.fs.stat(toUri);
        return { ok: false, error: `Destination already exists: ${destination}. Pass overwrite:true to replace it.` };
      } catch { /* destination is free — proceed */ }
    }

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(fromUri, toUri, { overwrite: input.overwrite === true });
    const res = await this._applier.apply(edit, {
      summary: `Move ${source} → ${destination}`,
      autoApprove: opts.autoApprove,
    });
    if (!res.applied) return { ok: false, error: editFailure(res.reason) };

    // Import updates land in the *referencing* files via will-rename participants; the moved
    // file itself is where broken self-imports would surface. Both are worth checking.
    const diagnostics = await collectForUris([toUri], this._workspaceRoot, {});
    return {
      ok: true,
      source,
      destination,
      diagnostics,
      notice: "Moved via VS Code's rename pipeline — language servers were given the chance to update imports in referencing files. Verify with a diagnostics or search pass if imports matter here.",
    };
  }

  /** Structural JSON edit: mutates the parsed document via JSON Pointer operations instead
   *  of matching exact text, so reformatting/reordering/whitespace differences can't fail
   *  the edit the way an oldString mismatch can. Only handles plain JSON — JSON-with-comments
   *  (e.g. some tsconfig.json files) fails to parse and the caller is told to use file_edit. */
  async applyJsonEdit(input: JsonEditInput, opts: { autoApprove: boolean }): Promise<JsonEditResult> {
    return this._mutations.run(() => this._applyJsonEdit(input, opts));
  }

  private async _applyJsonEdit(input: JsonEditInput, opts: { autoApprove: boolean }): Promise<JsonEditResult> {
    const rel = input.path;
    if (!rel) return { ok: false, error: "path is required." };
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (operations.length === 0) return { ok: false, error: "At least one operation is required." };

    const resolution = this._resolve(rel);
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const uri = resolution.value.uri;
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
    const baseline = await captureDiagnosticBaseline([uri], this._workspaceRoot);

    const res = await this._applier.apply(edit, {
      summary: `${operations.length} JSON operation(s) in ${rel}`,
      autoApprove: opts.autoApprove,
      expectedVersions: new Map([[uri.toString(), doc.version]]),
    });
    if (!res.applied) return { ok: false, error: editFailure(res.reason) };

    const diagnostics = await collectForUris([uri], this._workspaceRoot, { baseline });
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
    // In a CRLF file, split("\n") leaves each line's trailing \r in place. Excluding it from
    // the matched slice keeps the final \r\n pair intact outside the replacement, so applying
    // a replacement can never strand a bare \n where \r\n belongs.
    const lastLine = origLines[last]!;
    const end = lineStart[last]! + lastLine.length - (lastLine.endsWith("\r") ? 1 : 0);
    matches.push({ start: lineStart[i]!, end });
    if (matches.length > 1) return null; // ambiguous — refuse rather than risk a wrong edit
  }
  if (matches.length !== 1) return null;
  return original.slice(matches[0]!.start, matches[0]!.end);
}

/**
 * The file's dominant line ending. Files without newlines (or an even split) report "\n".
 */
export function dominantEol(text: string): "\n" | "\r\n" {
  // countOccurrences (indexOf loop) rather than String.match(/…/g), which allocates an array
  // holding every newline in the file just to read .length — measurable on multi-MB files.
  const crlf = countOccurrences(text, "\r\n");
  const bareLf = countOccurrences(text, "\n") - crlf;
  return crlf > bareLf ? "\r\n" : "\n";
}

/** Rewrite every line ending in `text` to `eol` (idempotent for already-conforming text). */
export function normalizeEol(text: string, eol: "\n" | "\r\n"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Opposite-line-ending forms of a needle. file_read strips \r from returned content, so an
 * oldString copied from a read of a CRLF file arrives with bare \n and can never exact-match
 * the document text — every multi-line edit on a CRLF file used to fall through to the
 * line-aligned whitespace-tolerant path, which cannot handle fragments starting or ending
 * mid-line. Trying the needle in both EOL conventions keeps the match exact: the matched
 * slice is still the file's own bytes.
 */
function eolVariants(needle: string): string[] {
  if (!needle.includes("\n")) return [];
  const variants: string[] = [];
  const lf = needle.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  if (crlf !== needle) variants.push(crlf);
  if (lf !== needle) variants.push(lf);
  return variants;
}

/**
 * Resolve the actual text in `text` that an edit's `oldString` should replace, preferring an
 * exact match and falling back — in order — to an EOL-converted match, a de-guttered match,
 * a whitespace-tolerant one, and finally the combinations.
 *
 * `deguttered` reports whether the resolution only worked after stripping a line-number gutter
 * off `oldString`. That answer matters beyond this function: if the model numbered `oldString`,
 * it almost certainly numbered `newString` too, and writing "  42\tconst x" into the file would
 * be a silent corruption far worse than the failed match we just recovered from. See applyEdit.
 *
 * Crucially, a de-guttered candidate is only ever adopted when it is *found in the file*. That
 * makes a false positive inert: text that merely looks like a gutter (an object literal with
 * numeric keys, say) yields a candidate that matches nothing and is discarded, so it can never
 * redirect an edit to the wrong place.
 */
export function resolveOldString(text: string, oldString: string): { old: string; count: number; deguttered: boolean } {
  // One probe covering a needle and its opposite-EOL forms, so the plain and de-guttered
  // passes below can't drift from each other.
  const tryExact = (needle: string, deguttered: boolean): { old: string; count: number; deguttered: boolean } | undefined => {
    for (const candidate of [needle, ...eolVariants(needle)]) {
      const count = countOccurrences(text, candidate);
      if (count > 0) return { old: candidate, count, deguttered };
    }
    return undefined;
  };

  const exact = tryExact(oldString, false);
  if (exact) return exact;

  const degutteredOld = stripLineNumberGutter(oldString);
  if (degutteredOld) {
    const stripped = tryExact(degutteredOld, true);
    if (stripped) return stripped;
  }

  const flexible = findWhitespaceTolerantMatch(text, oldString);
  if (flexible) return { old: flexible, count: countOccurrences(text, flexible), deguttered: false };

  if (degutteredOld) {
    const flexibleStripped = findWhitespaceTolerantMatch(text, degutteredOld);
    if (flexibleStripped) return { old: flexibleStripped, count: countOccurrences(text, flexibleStripped), deguttered: true };
  }

  return { old: oldString, count: 0, deguttered: false };
}

/**
 * The replacement text to actually write. When `oldString` only matched after its line-number
 * gutter was stripped, `newString` is assumed to carry the same gutter and is stripped too —
 * otherwise the edit would succeed while writing line numbers into the source file. Gated on
 * `deguttered` rather than applied unconditionally, so a `newString` that legitimately contains
 * consecutively-numbered lines is left alone whenever `oldString` matched the file as-is.
 *
 * When `targetEol` is provided, the replacement's line endings are rewritten to the file's own
 * convention — model output is near-universally \n, and splicing bare \n into a CRLF file
 * would otherwise leave it with mixed line endings.
 */
export function resolveNewString(newString: string, deguttered: boolean, targetEol?: "\n" | "\r\n"): string {
  let out = newString;
  if (deguttered) out = stripLineNumberGutter(out) ?? out;
  if (targetEol && out.includes("\n")) out = normalizeEol(out, targetEol);
  return out;
}

function editFailure(reason: "rejected" | "conflict" | "apply_failed" | "outside_workspace" | undefined): string {
  if (reason === "conflict") return "The document changed while the edit was awaiting approval. Read it again and retry against the current version.";
  if (reason === "outside_workspace") return "The edit targeted a URI outside the open workspace and was blocked.";
  if (reason === "apply_failed") return "VS Code could not apply or persist the edit.";
  return "User rejected the edit.";
}

const GUTTER_NOTICE =
  "Your oldString carried line-number prefixes, which are not part of the file — they were stripped so the edit could apply. "
  + "Send the file's raw text next time: file_read returns unnumbered content by default, and a file_search hit's `text` excludes the \"path:line:\" prefix.";

/** undefined when unset, "invalid" for anything but a positive integer. */
function normalizeExpectedReplacements(value: number | undefined): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return "invalid";
  return value;
}

type OneEditOutcome =
  | { ok: true; text: string; replacements: number; deguttered: boolean }
  | { ok: false; error: string };

/**
 * Validate and apply a single exact-string edit against `text`. This is the ONE copy of the
 * matching/authorization semantics — applyEdit and applyBatchEdits both call it, so file_edit
 * and file_edit_batch can never drift into behaving differently on the same input.
 */
function applyOneEdit(text: string, edit: EditInput, rel: string, fileEol: "\n" | "\r\n"): OneEditOutcome {
  const { old: oldString, count: occurrences, deguttered } = resolveOldString(text, edit.oldString);
  if (occurrences === 0) {
    return { ok: false, error: `oldString was not found in ${rel} (also tried EOL-converted, whitespace-tolerant, and line-number-stripped matches). Read the file and copy the exact text (including whitespace, and without any line-number prefixes).` };
  }
  const expected = normalizeExpectedReplacements(edit.expectedReplacements);
  if (expected === "invalid") return { ok: false, error: `expectedReplacements must be a positive integer (edit in ${rel}).` };
  if (expected !== undefined && occurrences !== expected) {
    return { ok: false, error: `oldString matches ${occurrences} location(s) in ${rel}, but expectedReplacements is ${expected}. Re-check the file — it may differ from what you expect.` };
  }
  // An exact expectedReplacements match authorizes replacing all of them, same as replaceAll.
  const replaceAll = edit.replaceAll === true || (expected !== undefined && expected > 1);
  if (occurrences > 1 && !replaceAll) {
    return { ok: false, error: `oldString matches ${occurrences} locations in ${rel}. Add surrounding context to make it unique, set replaceAll:true, or assert the count with expectedReplacements.` };
  }
  const newString = resolveNewString(edit.newString, deguttered, fileEol);
  return {
    ok: true,
    text: replaceAll ? text.split(oldString).join(newString) : replaceFirst(text, oldString, newString),
    replacements: replaceAll ? occurrences : 1,
    deguttered,
  };
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
