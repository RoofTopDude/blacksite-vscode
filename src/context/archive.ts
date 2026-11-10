/**
 * The archive: the full text of every tool result, addressable by its tool call id.
 *
 * Before this, a result was kept only when it overflowed the inline limit, and only the newest 30
 * of those (the old ToolOutputStore). A result that fit was in history or nowhere, so nothing could
 * be set aside without losing it. The archive is what makes rule 3 of the design stance true: any
 * result can be read back with tool_output_page / tool_output_search, whether it was truncated,
 * stubbed by the emergency path, or (later) aged out by policy.
 *
 * Two tiers. The newest results stay in memory up to `memoryBytes`, so paging a recent result costs
 * nothing. With a directory, every result is also written to disk and survives eviction from memory
 * and a reload of the window; `maxDiskBytes` and `maxEntries` bound the directory, oldest first.
 * Without a directory (tests, a host with no storage) memory is the only tier, and the memory cap is
 * the eviction line.
 *
 * Writes are asynchronous and best-effort: a failed write leaves the entry in memory until it is
 * evicted, and an entry that never reached disk is simply gone after that, as before this existed.
 * Reads from disk are synchronous; they happen only when the agent pages back into old output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface ArchiveEntryMeta {
  id: string;
  toolName?: string;
  chars: number;
  createdAt: number;
}

/** File system operations the archive uses. Injectable so tests can fail writes on purpose. */
export interface ArchiveDisk {
  mkdir(dir: string): void;
  write(file: string, text: string): Promise<void>;
  read(file: string): string | undefined;
  remove(file: string): void;
  removeDir(dir: string): void;
  listDirs(dir: string): Array<{ name: string; mtimeMs: number }>;
}

export const nodeArchiveDisk: ArchiveDisk = {
  mkdir: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
  write: (file, text) => fs.promises.writeFile(file, text, "utf8"),
  read: (file) => {
    try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
  },
  remove: (file) => { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } },
  removeDir: (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  listDirs: (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, mtimeMs: fs.statSync(path.join(dir, entry.name)).mtimeMs }));
    } catch {
      return [];
    }
  },
};

export interface ContextArchiveOptions {
  /** Directory for this session's entries. Absent: memory only. */
  dir?: string;
  /** Memory tier ceiling, in characters. */
  memoryChars?: number;
  /** Disk tier ceiling, in characters. */
  maxDiskChars?: number;
  /** Entry count ceiling across both tiers. */
  maxEntries?: number;
  disk?: ArchiveDisk;
}

export const ARCHIVE_MEMORY_CHARS = 16 * 1024 * 1024;
export const ARCHIVE_MAX_DISK_CHARS = 64 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 5_000;
/** Session directories untouched for this long are removed when a new archive opens beside them. */
export const ARCHIVE_STALE_DIR_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many session directories are kept, the current one included. With the per-session
 *  cap this bounds the archive root at about 1.3 GB in the worst case; typical sessions are far smaller. */
export const ARCHIVE_MAX_SESSIONS = 20;

/** A file name for an id: readable, safe on every platform, and collision-free. */
export function archiveFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 10);
  return `${safe}-${hash}.txt`;
}

interface Entry extends ArchiveEntryMeta {
  /** Present while the entry is in the memory tier. */
  text?: string;
  /** True once the disk write finished. */
  onDisk: boolean;
  /** Memory is the only copy: the disk write failed, or the entry was never to be written. */
  writeFailed?: boolean;
}

export class ContextArchive {
  private readonly _entries = new Map<string, Entry>();
  private readonly _dir?: string;
  private readonly _disk: ArchiveDisk;
  private readonly _memoryChars: number;
  private readonly _maxDiskChars: number;
  private readonly _maxEntries: number;
  private _memoryUsed = 0;
  private _diskUsed = 0;
  private _diskReady = false;
  private readonly _pending = new Set<Promise<void>>();

  constructor(options: ContextArchiveOptions = {}) {
    this._dir = options.dir;
    this._disk = options.disk ?? nodeArchiveDisk;
    this._memoryChars = options.memoryChars ?? ARCHIVE_MEMORY_CHARS;
    this._maxDiskChars = options.maxDiskChars ?? ARCHIVE_MAX_DISK_CHARS;
    this._maxEntries = Math.max(1, options.maxEntries ?? ARCHIVE_MAX_ENTRIES);
  }

  /** Whether entries outlive the memory tier. */
  get persistent(): boolean {
    return !!this._dir;
  }

  /** Entries currently retrievable from the index (either tier). */
  get size(): number {
    return this._entries.size;
  }

  get memoryChars(): number {
    return this._memoryUsed;
  }

  get maxEntries(): number {
    return this._maxEntries;
  }

  has(id: string): boolean {
    return this._entries.has(id);
  }

  meta(id: string): ArchiveEntryMeta | undefined {
    const entry = this._entries.get(id);
    return entry ? { id: entry.id, toolName: entry.toolName, chars: entry.chars, createdAt: entry.createdAt } : undefined;
  }

  /**
   * Store `text` under `id`. A second put for the same id replaces the first. `persist: false`
   * keeps it in memory only: for results whose content must not reach disk unredacted.
   */
  put(id: string, text: string, toolName?: string, options: { persist?: boolean } = {}): void {
    if (!id) return;
    this._drop(id);
    const persist = options.persist !== false;
    const entry: Entry = { id, toolName, chars: text.length, createdAt: Date.now(), text, onDisk: false, ...(persist ? {} : { writeFailed: true }) };
    this._entries.set(id, entry);
    this._memoryUsed += text.length;
    if (persist) this._writeToDisk(entry, text);
    this._enforceLimits();
  }

  /** The full text for `id`, from memory, then disk. A miss in the index still tries disk: an entry
   *  written before a reload is on disk under the same name even though this index never saw it. */
  get(id: string): string | undefined {
    const entry = this._entries.get(id);
    if (entry?.text !== undefined) return entry.text;
    if (!this._dir) return undefined;
    return this._disk.read(path.join(this._dir, archiveFileName(id)));
  }

  /** Remove every entry, from both tiers. */
  clear(): void {
    this._entries.clear();
    this._memoryUsed = 0;
    this._diskUsed = 0;
    if (this._dir && this._diskReady) {
      this._disk.removeDir(this._dir);
      this._diskReady = false;
    }
  }

  /** Settles once every write started so far has finished. For tests and orderly shutdown. */
  async flush(): Promise<void> {
    while (this._pending.size > 0) await Promise.allSettled([...this._pending]);
  }

  /**
   * Remove sibling session directories that are untouched for `maxAgeMs`, or beyond the newest
   * `keepNewest`. The per-session cap alone does not bound the root: every chat is a session.
   * Best effort; never throws.
   */
  static pruneStale(
    root: string,
    keep: string,
    maxAgeMs = ARCHIVE_STALE_DIR_MS,
    disk: ArchiveDisk = nodeArchiveDisk,
    now = Date.now(),
    keepNewest = ARCHIVE_MAX_SESSIONS,
  ): number {
    let removed = 0;
    const others = disk.listDirs(root)
      .filter((dir) => dir.name !== keep)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    others.forEach((dir, index) => {
      // The current session counts towards the newest, so the others get one fewer slot.
      if (index < keepNewest - 1 && now - dir.mtimeMs < maxAgeMs) return;
      disk.removeDir(path.join(root, dir.name));
      removed += 1;
    });
    return removed;
  }

  private _drop(id: string): void {
    const entry = this._entries.get(id);
    if (!entry) return;
    this._entries.delete(id);
    if (entry.text !== undefined) this._memoryUsed -= entry.chars;
    if (entry.onDisk) {
      this._diskUsed -= entry.chars;
      if (this._dir) this._disk.remove(path.join(this._dir, archiveFileName(id)));
    }
  }

  private _writeToDisk(entry: Entry, text: string): void {
    if (!this._dir) return;
    try {
      if (!this._diskReady) {
        this._disk.mkdir(this._dir);
        this._diskReady = true;
      }
    } catch {
      return;
    }
    const write = this._disk.write(path.join(this._dir, archiveFileName(entry.id)), text)
      .then(() => {
        // Evicted while the write was in flight: remove the file it left behind. Replaced: the
        // newer entry owns the file name now.
        if (this._entries.get(entry.id) !== entry) {
          if (!this._entries.has(entry.id) && this._dir) this._disk.remove(path.join(this._dir, archiveFileName(entry.id)));
          return;
        }
        entry.onDisk = true;
        this._diskUsed += entry.chars;
        this._enforceLimits();
      })
      .catch(() => {
        // Memory is its only copy now, and it is evicted from there like a memory-only entry.
        entry.writeFailed = true;
        if (this._entries.get(entry.id) === entry) this._enforceLimits();
      })
      .finally(() => { this._pending.delete(write); });
    this._pending.add(write);
  }

  private _enforceLimits(): void {
    // Entry count and disk size: drop the oldest entirely.
    for (const entry of this._entries.values()) {
      if (this._entries.size <= this._maxEntries && this._diskUsed <= this._maxDiskChars) break;
      this._drop(entry.id);
    }
    // Memory: release the oldest texts first, never the newest (the put that caused this).
    if (this._memoryUsed <= this._memoryChars) return;
    const entries = [...this._entries.values()];
    for (let i = 0; i < entries.length - 1 && this._memoryUsed > this._memoryChars; i++) {
      const entry = entries[i]!;
      if (entry.text === undefined) continue;
      if (entry.onDisk) {
        // Still retrievable from disk.
        entry.text = undefined;
        this._memoryUsed -= entry.chars;
      } else if (!this._dir || entry.writeFailed) {
        // Memory was its only copy.
        this._drop(entry.id);
      }
      // Otherwise its write is in flight; it is released when the write lands.
    }
  }
}
