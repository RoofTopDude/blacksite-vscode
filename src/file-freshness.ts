/* Per-session record of which files the agent has read and which it has since
   changed, so a call about to act on an out-of-date picture of a file can be
   told so.

   ── What was already safe, and what wasn't ──────────────────────────────────
   The mechanics mostly hold on their own: file_edit matches `oldString` against
   the live buffer (diff-edit-service.ts), every mutation is saved to disk
   before the tool returns (workspace-edit-applier.ts `_save`), and file_read
   always reads bytes off disk rather than a cache. So an agent that re-reads a
   file it edited genuinely sees its own change, and an edit built on a stale
   copy FAILS rather than corrupting anything.

   What was missing is the agent knowing *why* — and one real hole:

     - file_write in overwrite mode is the only file operation with no content
       check at all. Rewriting a file wholesale from a copy taken before this
       session's own earlier edit silently discards that edit. That is the one
       genuine data-loss path in the file toolset.
     - code_insert addresses a position rather than content, so a line anchor
       chosen before an edit can land somewhere else entirely.
     - A failed `oldString` match on a file the session already changed is
       almost always exactly that. Saying so turns "retry and hope" into
       "re-read, then edit".

   ── What is deliberately NOT warned about ───────────────────────────────────
   Sequential exact-match edits — file_edit, file_edit_batch, json_edit,
   code_replace — are silent on the happy path. Making several edits to one
   file is the normal way to work, each one verifies its own anchor text
   against the live buffer, and a notice on every edit would train the reader
   to skip the notice that actually matters. Signal only survives if it is
   rare. */

import { activityToTraces } from "./graph/trace-extract.js";

/** A file the session changed and has not re-read since. */
export interface StaleFile {
  /** Workspace-relative path as the agent last referred to it. */
  path: string;
  /** The tool that made the change, so the message can name the real cause. */
  tool: string;
}

interface FileRecord {
  display: string;
  /** Monotonic sequence of the last successful read; 0 = never read. */
  readSeq: number;
  /** Monotonic sequence of the last successful change; 0 = never changed. */
  writeSeq: number;
  writeTool: string;
}

/** Whole-file overwrite: no anchor text, so a stale copy is silently destructive. */
const OVERWRITE_TOOLS = new Set(["file_write"]);

/** Position-addressed rather than content-addressed: stale line/anchor numbers
    land the edit in the wrong place instead of failing. */
const POSITIONAL_TOOLS = new Set(["code_insert"]);

/** Content-anchored edits, whose own failure is the signal. Listed so the
    failure-path explanation knows which errors are worth explaining. */
const ANCHORED_TOOLS = new Set([
  "file_edit", "file_edit_batch", "json_edit", "code_replace", "code_replace_batch",
]);

export class FileFreshnessLedger {
  private _seq = 0;
  private readonly _files = new Map<string, FileRecord>();

  constructor(private readonly _workspaceRoot: string = "") {}

  /**
   * Collapse the many ways one file gets named into a single key.
   *
   * Absolute and workspace-relative forms have to land on the same entry or the
   * ledger silently misses: file_read reports an absolute `path` while file_edit
   * reports the relative one it was given. Compared case-insensitively because
   * Windows and macOS treat paths that way, so "src/App.ts" and "src/app.ts"
   * are the same file to the filesystem and must be to us.
   */
  private _key(raw: string): string {
    return this._relative(raw).toLowerCase();
  }

  private _relative(raw: string): string {
    const normalized = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!normalized) return "";
    const root = this._workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return normalized.slice(root.length + 1);
    }
    return normalized;
  }

  /** Paths a call touches, split by whether it reads or changes them. */
  private _touched(toolName: string, input: Record<string, unknown> | undefined): { reads: string[]; writes: string[] } {
    const reads: string[] = [];
    const writes: string[] = [];
    for (const trace of activityToTraces(toolName, input)) {
      /* "shell"/"nav" kinds are neither: a shell command's cwd says nothing
         about whether the agent's copy of a file is current. */
      if (trace.kind === "read") reads.push(trace.path);
      else if (trace.kind === "write" || trace.kind === "edit") writes.push(trace.path);
    }
    return { reads, writes };
  }

  /**
   * Files this call is about to touch that the session has changed and not
   * re-read since. Must be consulted *before* {@link record} folds this call in.
   */
  staleTargets(toolName: string, input: Record<string, unknown> | undefined): StaleFile[] {
    const { reads, writes } = this._touched(toolName, input);
    const out: StaleFile[] = [];
    for (const path of [...writes, ...reads]) {
      const record = this._files.get(this._key(path));
      if (!record || record.writeSeq === 0) continue;
      if (record.readSeq > record.writeSeq) continue; // re-read since the change
      out.push({ path: record.display, tool: record.writeTool });
    }
    return out;
  }

  /** True when the session has changed this file at all, re-read or not. */
  changedThisSession(path: string): boolean {
    return (this._files.get(this._key(path))?.writeSeq ?? 0) > 0;
  }

  /** Fold a completed call into the ledger. Only successful calls count — a
   *  failed write changed nothing, and a failed read refreshed nothing. */
  record(toolName: string, input: Record<string, unknown> | undefined, ok: boolean): void {
    if (!ok) return;
    const { reads, writes } = this._touched(toolName, input);
    for (const path of reads) this._mark(path, "read", toolName);
    for (const path of writes) this._mark(path, "write", toolName);
  }

  /** Record a change the parent session didn't make itself — a subagent lane's
   *  edit still invalidates whatever the parent is holding. Keyed off the tool
   *  result, since relayed lane events carry no input. */
  recordWriteFromResult(toolName: string, result: unknown): void {
    for (const path of writtenPathsFromResult(toolName, result)) this._mark(path, "write", toolName);
  }

  private _mark(rawPath: string, kind: "read" | "write", toolName: string): void {
    const display = this._relative(rawPath);
    if (!display) return;
    const key = this._key(rawPath);
    this._seq += 1;
    const record = this._files.get(key) ?? { display, readSeq: 0, writeSeq: 0, writeTool: "" };
    record.display = display;
    if (kind === "read") record.readSeq = this._seq;
    else { record.writeSeq = this._seq; record.writeTool = toolName; }
    this._files.set(key, record);
  }
}

/** Files a *result* says were changed. Mirrors the shapes the file tools
 *  actually return: file_write reports an absolute `path` plus `relativePath`,
 *  file_edit reports the relative path it was handed, and the batch tools
 *  report per-file rows. */
export function writtenPathsFromResult(toolName: string, result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  if (record.ok !== true) return [];
  const pick = (row: Record<string, unknown>): string | undefined => {
    const relative = row.relativePath;
    if (typeof relative === "string" && relative) return relative;
    const path = row.path;
    return typeof path === "string" && path ? path : undefined;
  };
  if (toolName === "file_edit_batch" || toolName === "code_replace_batch") {
    const rows = Array.isArray(record.results) ? record.results as unknown[] : [];
    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map(pick)
      .filter((value): value is string => !!value);
  }
  if (!MUTATING_TOOLS.has(toolName)) return [];
  const single = pick(record);
  return single ? [single] : [];
}

const MUTATING_TOOLS = new Set([
  "file_edit", "file_write", "json_edit", "code_insert", "code_replace", "file_move", "file_delete",
]);

/**
 * The warning to attach to a tool result, or undefined when there is nothing
 * worth saying.
 *
 * `stale` is the pre-call state — files this session changed and never re-read.
 */
export function freshnessWarning(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ok: boolean,
  stale: readonly StaleFile[],
  errorText: string,
): string | undefined {
  if (stale.length === 0) return undefined;
  const list = stale.map((file) => `${file.path} (changed by ${file.tool})`).join(", ");

  if (!ok) {
    /* An anchor that no longer matches, on a file this session just rewrote, is
       the textbook stale-copy failure — name it instead of leaving the model to
       guess at whitespace. */
    if (ANCHORED_TOOLS.has(toolName) && /not found|matches \d+ location/i.test(errorText)) {
      return `This session already changed ${list} and has not re-read it since, so the text you anchored on may no longer exist. Call file_read on it and build the edit from the current content.`;
    }
    return undefined;
  }

  if (OVERWRITE_TOOLS.has(toolName) && String(input?.mode ?? "overwrite") === "overwrite") {
    return `This session already changed ${list} and had not re-read it since. A whole-file write replaces that content outright, so any earlier change not present in what you just wrote is now gone. Re-read the file and confirm it looks the way you intend.`;
  }
  if (POSITIONAL_TOOLS.has(toolName)) {
    return `This session already changed ${list} and has not re-read it since. This edit is positional, so line numbers and anchors taken from the earlier content may point somewhere else now — re-read the file and verify the insertion landed where you meant it to.`;
  }
  return undefined;
}
