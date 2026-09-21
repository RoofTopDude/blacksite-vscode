/* Reviewable diffs for every file an agent tool call changes.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The transcript already said *that* a file changed ("Applying · src/foo.ts +12 −3"). Reading
 * what actually changed meant opening the file and reconstructing the edit from the tool's
 * input JSON — which is exactly the review step a user is most likely to skip, and the one
 * where a wrong edit gets caught. This journal keeps the file's bytes from immediately before
 * each tool call so any change can be reopened as a real VS Code diff, minutes later, straight
 * from the row that reported it.
 *
 * ── How the snapshots are taken ─────────────────────────────────────────────
 * Path-keyed, from the tool *input*, immediately before dispatch (see diffTargetPaths). Not
 * from the result: by the time a result names the files it changed, the previous content is
 * already gone. The pairing is per tool-call id, so a diff is attributed to the row that
 * caused it even when several lanes are editing concurrently.
 *
 * ── Bounds ──────────────────────────────────────────────────────────────────
 * A long session can touch thousands of files, and the webview is never reclaimed, so the
 * journal is explicitly capped (MAX_ENTRIES / MAX_FILE_BYTES / MAX_TOTAL_BYTES) and evicts
 * oldest-first. A file too large to snapshot, or binary, simply gets no diff — the row still
 * reports the change and still opens the file. Losing a diff is a missing convenience; a
 * host that quietly accumulates hundreds of megabytes of file content is a bug.
 */

import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceIdentity } from "./lsp/workspace-identity.js";
import { diffTargetPaths, isDiffableText, summarizeSnapshotPair, type ToolDiffSummary } from "./edit-diff-stats.js";

export type { ToolDiffSummary };

export const DIFF_SCHEME = "blacksite-diff";

/** Per-file snapshot cap. Above it the file is left unsnapshotted rather than paged into
 *  memory twice — an agent edit to a 4 MB generated file is not a diff anyone reads. */
const MAX_FILE_BYTES = 1_500_000;
/** Tool calls retained. Each holds before+after text for its files. */
const MAX_ENTRIES = 250;
/** Total retained snapshot bytes across the journal, evicted oldest-first. */
const MAX_TOTAL_BYTES = 32_000_000;

interface FileSnapshot {
  /** Content immediately before the call, or null when the file did not exist. */
  before: string | null;
  /** Content immediately after, or null when the call removed it. Undefined until the
   *  after-pass runs (a call that never completed — cancelled mid-flight — stays undefined). */
  after?: string | null;
  summary?: ToolDiffSummary;
}

interface JournalEntry {
  toolCallId: string;
  toolName: string;
  at: number;
  /** Keyed by the workspace-relative path the snapshot was taken under. */
  files: Map<string, FileSnapshot>;
  bytes: number;
}

/** Reads the *editor's* view of a file when one is open, the disk otherwise.
 *  An open dirty buffer is the content an edit will actually be applied to, so
 *  snapshotting disk there would diff against text the user never had. */
async function readCurrentText(uri: vscode.Uri): Promise<string | null> {
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === uri.scheme && doc.uri.fsPath === uri.fsPath,
  );
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_FILE_BYTES) return null;
    const text = Buffer.from(bytes).toString("utf8");
    return isDiffableText(text) ? text : null;
  } catch {
    return null; // missing (a file about to be created), unreadable, or a directory
  }
}

/**
 * Serves the recorded "before" and "after" text as read-only virtual documents.
 *
 * The published path carries the real workspace-relative path so the diff editor picks up the
 * file's language for syntax highlighting and shows a recognizable tab label; the entry key
 * and side ride in the query, which VS Code preserves through document identity.
 */
class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly _lookup: (toolCallId: string, side: string, relPath: string) => string | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const toolCallId = params.get("call") ?? "";
    const side = params.get("side") ?? "before";
    return this._lookup(toolCallId, side, uri.path.replace(/^\/+/, "")) ?? "";
  }
}

export class EditDiffJournal implements vscode.Disposable {
  private readonly _entries = new Map<string, JournalEntry>();
  private readonly _identity: WorkspaceIdentity;
  private readonly _registration: vscode.Disposable;
  private _bytes = 0;

  constructor(workspaceRoot: string) {
    this._identity = new WorkspaceIdentity(workspaceRoot);
    this._registration = vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      new SnapshotContentProvider((call, side, relPath) => this._snapshotText(call, side, relPath)),
    );
  }

  dispose(): void {
    this._registration.dispose();
    this._entries.clear();
    this._bytes = 0;
  }

  /** Drop everything. Called when the conversation is cleared or replaced — the rows those
   *  diffs belonged to are gone from the transcript, so holding their content is pure waste. */
  clear(): void {
    this._entries.clear();
    this._bytes = 0;
  }

  /**
   * Snapshot every file this call is about to write, before it runs.
   *
   * Never throws and never rejects: a snapshot is an enrichment, and a journal failure must
   * not be able to stop the tool call it was trying to document.
   */
  async captureBefore(toolCallId: string, toolName: string, input: Record<string, unknown> | undefined): Promise<void> {
    try {
      const targets = diffTargetPaths(toolName, input);
      if (!targets.length) return;
      const files = new Map<string, FileSnapshot>();
      let bytes = 0;
      for (const target of targets) {
        const resolved = this._resolve(target);
        if (!resolved) continue;
        const before = await readCurrentText(resolved.uri);
        if (before !== null && before.length > MAX_FILE_BYTES) continue;
        files.set(resolved.rel, { before });
        bytes += before?.length ?? 0;
      }
      if (!files.size) return;
      this._drop(toolCallId); // a retried call must not double-count its predecessor's bytes
      this._entries.set(toolCallId, { toolCallId, toolName, at: Date.now(), files, bytes });
      this._bytes += bytes;
      this._evict(toolCallId);
    } catch { /* see the doc comment: a journal failure is never the tool call's problem */ }
  }

  /**
   * Re-read the snapshotted files and return the ones that actually changed.
   *
   * Pairing here — rather than trusting the tool's own reported path list — is what makes the
   * result honest: a rejected approval, a failed `oldString` match, or a batch where only one
   * of three files moved all end up reporting exactly the files whose bytes differ.
   */
  async captureAfter(toolCallId: string, ok: boolean): Promise<ToolDiffSummary[]> {
    try {
      const entry = this._entries.get(toolCallId);
      if (!entry) return [];
      const summaries: ToolDiffSummary[] = [];
      for (const [rel, snapshot] of entry.files) {
        const resolved = this._resolve(rel);
        if (!resolved) continue;
        const after = await readCurrentText(resolved.uri);
        snapshot.after = after;
        this._bytes += after?.length ?? 0;
        entry.bytes += after?.length ?? 0;
        const summary = summarizeSnapshotPair(rel, snapshot.before, after);
        if (!summary) continue;
        snapshot.summary = summary;
        summaries.push(summary);
      }
      // A failed call that changed nothing carries no diff and no reason to stay resident.
      if (!summaries.length) this._drop(toolCallId);
      else if (!ok) {
        /* Kept deliberately: a call that reports failure but left bytes behind (a partially
           applied batch, an edit that applied and then failed to save) is precisely the case
           a reviewer needs to see. */
      }
      this._evict();
      return summaries;
    } catch {
      return [];
    }
  }

  /** True when this call has a diff on record for `relPath` (or for anything, when omitted). */
  has(toolCallId: string, relPath?: string): boolean {
    const entry = this._entries.get(toolCallId);
    if (!entry) return false;
    if (!relPath) return [...entry.files.values()].some((file) => file.summary);
    return !!this._match(entry, relPath)?.summary;
  }

  /** Every recorded change for a call, in snapshot order. */
  summaries(toolCallId: string): ToolDiffSummary[] {
    const entry = this._entries.get(toolCallId);
    if (!entry) return [];
    return [...entry.files.values()].flatMap((file) => file.summary ? [file.summary] : []);
  }

  /**
   * Open one recorded change as a VS Code diff.
   *
   * The right-hand side is the *live file* whenever the file on disk still matches what the
   * call left behind — so the reviewer can fix what they see without leaving the diff. It falls
   * back to the recorded "after" text once something else has touched the file, because showing
   * later unrelated edits inside a diff labelled with this tool call would be a lie.
   */
  async openDiff(toolCallId: string, relPath?: string): Promise<boolean> {
    const entry = this._entries.get(toolCallId);
    if (!entry) return false;
    const snapshot = relPath
      ? this._match(entry, relPath)
      : [...entry.files.values()].find((file) => file.summary);
    if (!snapshot?.summary) return false;
    return this._show(entry, snapshot, snapshot.summary);
  }

  /** Open every recorded change for a call, so a multi-file edit is reviewed as a set.
   *  Returns how many diffs opened. */
  async openAllDiffs(toolCallId: string): Promise<number> {
    const entry = this._entries.get(toolCallId);
    if (!entry) return 0;
    let opened = 0;
    for (const snapshot of entry.files.values()) {
      if (!snapshot.summary) continue;
      if (await this._show(entry, snapshot, snapshot.summary)) opened++;
    }
    return opened;
  }

  private async _show(entry: JournalEntry, snapshot: FileSnapshot, summary: ToolDiffSummary): Promise<boolean> {
    const resolved = this._resolve(summary.path);
    if (!resolved) return false;
    const base = path.basename(summary.path);

    const left = snapshot.before === null
      ? this._snapshotUri(entry.toolCallId, "empty", summary.path)
      : this._snapshotUri(entry.toolCallId, "before", summary.path);

    let right: vscode.Uri;
    let rightLabel: string;
    if (snapshot.after === null) {
      right = this._snapshotUri(entry.toolCallId, "empty", summary.path);
      rightLabel = "deleted";
    } else {
      const current = await readCurrentText(resolved.uri);
      const live = current !== null && current === snapshot.after;
      right = live ? resolved.uri : this._snapshotUri(entry.toolCallId, "after", summary.path);
      rightLabel = live ? "now" : "after (file has changed since)";
    }

    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (summary.line > 0) {
      const position = new vscode.Position(Math.max(summary.line - 1, 0), 0);
      options.selection = new vscode.Range(position, position);
    }
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${base} — ${entry.toolName} ↔ ${rightLabel}`,
        options,
      );
      return true;
    } catch {
      return false;
    }
  }

  private _snapshotUri(toolCallId: string, side: "before" | "after" | "empty", relPath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${relPath.replace(/^\/+/, "")}`,
      query: new URLSearchParams({ call: toolCallId, side }).toString(),
    });
  }

  private _snapshotText(toolCallId: string, side: string, relPath: string): string | undefined {
    if (side === "empty") return "";
    const entry = this._entries.get(toolCallId);
    if (!entry) return undefined;
    const snapshot = this._match(entry, relPath);
    if (!snapshot) return undefined;
    const text = side === "after" ? snapshot.after : snapshot.before;
    return text ?? "";
  }

  /** Paths arrive from the webview as the transcript rendered them, which may differ in
   *  separator or case from the key the snapshot was stored under. */
  private _match(entry: JournalEntry, relPath: string): FileSnapshot | undefined {
    const direct = entry.files.get(relPath);
    if (direct) return direct;
    const wanted = normalizeKey(relPath);
    for (const [key, snapshot] of entry.files) {
      if (normalizeKey(key) === wanted) return snapshot;
    }
    return undefined;
  }

  private _resolve(target: string): { uri: vscode.Uri; rel: string } | null {
    const resolution = this._identity.resolve(target);
    if (!resolution.ok) return null;
    return { uri: resolution.value.uri, rel: resolution.value.path };
  }

  private _drop(toolCallId: string): void {
    const entry = this._entries.get(toolCallId);
    if (!entry) return;
    this._bytes -= entry.bytes;
    this._entries.delete(toolCallId);
  }

  /** Oldest-first eviction. `keep` is never evicted — a call that just snapshotted a very
   *  large file must not immediately throw away its own record. */
  private _evict(keep?: string): void {
    if (this._bytes < 0) this._bytes = 0;
    while (this._entries.size > MAX_ENTRIES || this._bytes > MAX_TOTAL_BYTES) {
      const oldest = [...this._entries.keys()].find((key) => key !== keep);
      if (!oldest) return;
      this._drop(oldest);
    }
  }
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}
