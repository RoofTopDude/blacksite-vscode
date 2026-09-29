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

import { createHash } from "crypto";
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

/** Eviction tombstones kept so a rewind can name the files it can no longer restore. Each is a
 *  sequence number and a few paths, so a generous cap costs almost nothing. */
const MAX_TOMBSTONES = 2_000;

/**
 * What a before-snapshot actually knows. `before: null` alone was ambiguous — "the file did not
 * exist" and "the file was binary, too large or a directory" both read as null — which was harmless
 * for a diff viewer and fatal for a restore: restoring "did not exist" means deleting the file.
 */
type BeforeState = "text" | "absent" | "unrestorable";

interface FileSnapshot {
  /** Content immediately before the call, or null when the file did not exist. */
  before: string | null;
  beforeState: BeforeState;
  /** Why the content could not be kept, when beforeState is "unrestorable". */
  unrestorableReason?: string;
  /** For an unrestorable file: a fingerprint (content hash, or its kind) taken before the call,
   *  and whether it differed afterwards. An unrestorable file the call never changed is nothing
   *  a rewind needs to mention; one it did change must be named. Undefined until the after-pass. */
  unrestorableFingerprint?: string;
  unrestorableChanged?: boolean;
  /** The exact bytes, kept only when decoding as UTF-8 would not reproduce them (a file in another
   *  encoding). A restore writes these; everything else round-trips through `before`. */
  beforeBytes?: Uint8Array;
  /** Content immediately after, or null when the call removed it. Undefined until the
   *  after-pass runs (a call that never completed — cancelled mid-flight — stays undefined). */
  after?: string | null;
  summary?: ToolDiffSummary;
}

interface JournalEntry {
  toolCallId: string;
  toolName: string;
  at: number;
  /** Monotonic across the journal's life. A rewind point is the sequence number current when its
   *  turn began: every entry above it belongs to that turn or a later one. */
  seq: number;
  /** Keyed by the workspace-relative path the snapshot was taken under. */
  files: Map<string, FileSnapshot>;
  bytes: number;
}

/** What restoring the workspace to a rewind point would do, computed before anything changes so it
 *  can be shown to the user first. */
export interface RestorePlan {
  /** Files that can be put back: their content before the point, or deletion for a file created
   *  after it. `modifiedSince` marks a file that no longer matches the last recorded change —
   *  something else (the user, a command) edited it since, and restoring discards that too. */
  files: Array<{ path: string; action: "restore" | "delete"; content?: string; bytes?: Uint8Array; modifiedSince: boolean }>;
  /** Files changed after the point whose earlier content was never kept. */
  unrestorable: Array<{ path: string; reason: string }>;
}

export interface RestoreOutcome {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
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
 * The before-state of a file, distinguishing "absent" from "present but not keepable". Reads first
 * (the common case, and the only operation some hosts model) and stats only when the read fails.
 */
async function readSnapshotState(
  uri: vscode.Uri,
): Promise<{ state: "text"; text: string; bytes?: Uint8Array } | { state: "absent" } | { state: "unrestorable"; reason: string; fingerprint: string }> {
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === uri.scheme && doc.uri.fsPath === uri.fsPath,
  );
  if (open) return { state: "text", text: open.getText() };
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const directory = (stat.type & vscode.FileType.Directory) !== 0;
      return { state: "unrestorable", reason: directory ? "it is a directory" : "it could not be read", fingerprint: directory ? "directory" : "unreadable" };
    } catch {
      return { state: "absent" };
    }
  }
  const hash = (): string => createHash("sha1").update(bytes).digest("hex");
  if (bytes.byteLength > MAX_FILE_BYTES) return { state: "unrestorable", reason: "it is too large to keep a copy of", fingerprint: hash() };
  const text = Buffer.from(bytes).toString("utf8");
  if (!isDiffableText(text)) return { state: "unrestorable", reason: "it is a binary file", fingerprint: hash() };
  const lossless = Buffer.from(text, "utf8").equals(Buffer.from(bytes));
  return lossless ? { state: "text", text } : { state: "text", text, bytes: Uint8Array.from(bytes) };
}

/** Write restored content: through the editor when the file is open (so no buffer goes stale and
 *  the document keeps its encoding), straight to disk otherwise. */
async function writeRestoredFile(uri: vscode.Uri, text: string, bytes: Uint8Array | undefined): Promise<void> {
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === uri.scheme && doc.uri.fsPath === uri.fsPath,
  );
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("the editor refused the change");
    await open.save();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath))).then(undefined, () => undefined);
  await vscode.workspace.fs.writeFile(uri, bytes ?? Buffer.from(text, "utf8"));
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
  private _seq = 0;
  /** Paths whose snapshots were evicted, by the sequence number of the entry that held them. */
  private _tombstones: Array<{ seq: number; paths: string[] }> = [];

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
    this._tombstones = [];
  }

  /** The latest sequence number handed out. A rewind point records this when its turn begins. */
  get sequence(): number {
    return this._seq;
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
        const snapshot = await this._snapshotBefore(resolved.uri);
        files.set(resolved.rel, snapshot);
        bytes += snapshot.before?.length ?? 0;
      }
      if (!files.size) return;
      this._drop(toolCallId); // a retried call must not double-count its predecessor's bytes
      this._entries.set(toolCallId, { toolCallId, toolName, at: Date.now(), seq: ++this._seq, files, bytes });
      this._bytes += bytes;
      this._evict(toolCallId);
    } catch { /* see the doc comment: a journal failure is never the tool call's problem */ }
  }

  /**
   * Snapshot more files for a call already in flight — the ones a language-server edit (rename,
   * code action, format) reports only once it is approved, which the input alone never names.
   * Files the call already snapshotted are left as they are. Never throws.
   */
  async captureFiles(toolCallId: string, toolName: string, relPaths: readonly string[]): Promise<void> {
    try {
      let entry = this._entries.get(toolCallId);
      for (const target of relPaths) {
        const resolved = this._resolve(target);
        if (!resolved || entry?.files.has(resolved.rel) || (entry && this._match(entry, resolved.rel))) continue;
        const snapshot = await this._snapshotBefore(resolved.uri);
        if (!entry) {
          entry = { toolCallId, toolName, at: Date.now(), seq: ++this._seq, files: new Map(), bytes: 0 };
          this._entries.set(toolCallId, entry);
        }
        entry.files.set(resolved.rel, snapshot);
        entry.bytes += snapshot.before?.length ?? 0;
        this._bytes += snapshot.before?.length ?? 0;
      }
      if (entry) this._evict(toolCallId);
    } catch { /* an enrichment, never the edit's problem */ }
  }

  private async _snapshotBefore(uri: vscode.Uri): Promise<FileSnapshot> {
    const read = await readSnapshotState(uri);
    if (read.state === "text") return { before: read.text, beforeState: "text", ...(read.bytes ? { beforeBytes: read.bytes } : {}) };
    if (read.state === "absent") return { before: null, beforeState: "absent" };
    return { before: null, beforeState: "unrestorable", unrestorableReason: read.reason, unrestorableFingerprint: read.fingerprint };
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
        // Another lane's captureBefore can evict (or a retry can replace) this entry while the
        // read is in flight. Its bytes were already subtracted when it was dropped, so counting
        // this read would inflate the total for good — and an inflated total makes every later
        // eviction pass empty the whole journal. A diff for an evicted entry could not be
        // opened anyway, so report none.
        if (this._entries.get(toolCallId) !== entry) return [];
        snapshot.after = after;
        this._bytes += after?.length ?? 0;
        entry.bytes += after?.length ?? 0;
        if (snapshot.beforeState === "unrestorable") {
          const now = await readSnapshotState(resolved.uri);
          snapshot.unrestorableChanged = !(now.state === "unrestorable" && now.fingerprint === snapshot.unrestorableFingerprint);
          if (this._entries.get(toolCallId) !== entry) return [];
        }
        // No earlier text means no honest diff: a null before here is "not kept", not "created".
        const summary = snapshot.beforeState === "unrestorable" ? null : summarizeSnapshotPair(rel, snapshot.before, after);
        if (!summary) continue;
        snapshot.summary = summary;
        summaries.push(summary);
      }
      // A failed call that changed nothing carries no diff and no reason to stay resident.
      const changedUnrestorable = [...entry.files.values()].some((file) => file.unrestorableChanged);
      if (!summaries.length && !changedUnrestorable) this._drop(toolCallId);
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

  private _drop(toolCallId: string, evicted = false): void {
    const entry = this._entries.get(toolCallId);
    if (!entry) return;
    this._bytes -= entry.bytes;
    this._entries.delete(toolCallId);
    // Evicted, not superseded: remember which files lost their earlier content, so a rewind past
    // this point says so instead of silently restoring less than it claims.
    if (evicted) {
      this._tombstones.push({ seq: entry.seq, paths: [...entry.files.keys()] });
      if (this._tombstones.length > MAX_TOMBSTONES) this._tombstones.splice(0, this._tombstones.length - MAX_TOMBSTONES);
    }
  }

  /** Oldest-first eviction. `keep` is never evicted — a call that just snapshotted a very
   *  large file must not immediately throw away its own record. */
  private _evict(keep?: string): void {
    if (this._bytes < 0) this._bytes = 0;
    while (this._entries.size > MAX_ENTRIES || this._bytes > MAX_TOTAL_BYTES) {
      const oldest = [...this._entries.keys()].find((key) => key !== keep);
      if (!oldest) return;
      this._drop(oldest, true);
    }
  }

  /**
   * What restoring the workspace to `sinceSeq` would do: for every file a recorded call changed
   * after that point, its content before the first of those calls (or deletion, when the first of
   * them created it). Reads current content to flag files something else changed since.
   */
  async planRestore(sinceSeq: number): Promise<RestorePlan> {
    const entries = [...this._entries.values()].filter((entry) => entry.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
    const first = new Map<string, { path: string; snapshot: FileSnapshot }>();
    const last = new Map<string, FileSnapshot>();
    for (const entry of entries) {
      for (const [rel, snapshot] of entry.files) {
        const key = normalizeKey(rel);
        if (!first.has(key)) first.set(key, { path: rel, snapshot });
        last.set(key, snapshot);
      }
    }
    const plan: RestorePlan = { files: [], unrestorable: [] };
    for (const [key, { path: rel, snapshot }] of first) {
      if (snapshot.beforeState === "unrestorable") {
        // A later call in the range may have changed it even if the first did not.
        const changed = entries.some((entry) => {
          const later = entry.files.get(rel) ?? [...entry.files.entries()].find(([k]) => normalizeKey(k) === key)?.[1];
          return later?.beforeState === "unrestorable" && later.unrestorableChanged !== false;
        });
        if (changed) plan.unrestorable.push({ path: rel, reason: snapshot.unrestorableReason ?? "its earlier content was not kept" });
        continue;
      }
      const resolved = this._resolve(rel);
      if (!resolved) continue;
      const current = await readCurrentText(resolved.uri);
      const target = snapshot.beforeState === "absent" ? null : snapshot.before;
      if (current === target) continue; // already as it was
      const lastAfter = last.get(key)?.after;
      const modifiedSince = lastAfter !== undefined && current !== lastAfter;
      plan.files.push(target === null
        ? { path: rel, action: "delete", modifiedSince }
        : { path: rel, action: "restore", content: target, ...(snapshot.beforeBytes ? { bytes: snapshot.beforeBytes } : {}), modifiedSince });
    }
    const covered = new Set([...first.keys()]);
    for (const tomb of this._tombstones) {
      if (tomb.seq <= sinceSeq) continue;
      for (const rel of tomb.paths) {
        const key = normalizeKey(rel);
        if (covered.has(key)) continue;
        covered.add(key);
        plan.unrestorable.push({ path: rel, reason: "its earlier content was dropped from the edit history (the history keeps the most recent 250 changes)" });
      }
    }
    return plan;
  }

  /**
   * Carry out a restore plan. Open documents are edited in place and saved, so the editor never
   * holds a stale buffer; closed files are written directly. Files the plan deletes go to the
   * trash where the platform has one. A directory is never deleted: it may hold files nobody
   * recorded. The restore is itself journalled, so a later rewind still sees accurate history.
   */
  async applyRestore(plan: RestorePlan): Promise<RestoreOutcome> {
    const outcome: RestoreOutcome = { restored: [], deleted: [], failed: [] };
    const files = new Map<string, FileSnapshot>();
    let bytes = 0;
    for (const item of plan.files) {
      const resolved = this._resolve(item.path);
      if (!resolved) { outcome.failed.push({ path: item.path, error: "outside the workspace" }); continue; }
      try {
        const before = await readCurrentText(resolved.uri);
        if (item.action === "delete") {
          const stat = await vscode.workspace.fs.stat(resolved.uri).then((s) => s, () => null);
          if (!stat) { outcome.deleted.push(item.path); continue; }
          if (stat.type & vscode.FileType.Directory) {
            outcome.failed.push({ path: item.path, error: "a directory; left in place" });
            continue;
          }
          await vscode.workspace.fs.delete(resolved.uri, { useTrash: true })
            .then(undefined, () => vscode.workspace.fs.delete(resolved.uri, { useTrash: false }));
          outcome.deleted.push(item.path);
          files.set(resolved.rel, { before, beforeState: before === null ? "absent" : "text", after: null });
        } else {
          await writeRestoredFile(resolved.uri, item.content ?? "", item.bytes);
          outcome.restored.push(item.path);
          files.set(resolved.rel, { before, beforeState: before === null ? "absent" : "text", after: item.content ?? "" });
        }
        bytes += (before?.length ?? 0) + (item.content?.length ?? 0);
      } catch (error) {
        outcome.failed.push({ path: item.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (files.size) {
      const id = `rewind_${Date.now().toString(36)}`;
      this._entries.set(id, { toolCallId: id, toolName: "rewind", at: Date.now(), seq: ++this._seq, files, bytes });
      this._bytes += bytes;
      this._evict(id);
    }
    return outcome;
  }
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}
