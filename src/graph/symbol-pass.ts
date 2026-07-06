/* Pure scheduler for the background symbol sweep (Phase 4 / W5). Drives the
   corpus through an LSP symbol-indexing pass on an idle time budget: only files
   whose content signature changed get (re)indexed, work is spread across ticks
   so a language server is never hammered, and the whole thing is cancellable on
   user activity. No vscode/fs here — the host injects the clock, the per-file
   signature, and the actual LSP indexing (see graph/symbol-indexer.ts), so this
   coordination logic stays deterministic and unit-testable. */

export interface AbortLike {
  readonly aborted: boolean;
}

export interface SymbolPassDeps {
  /** Milliseconds since some epoch; injected so tests control the budget clock. */
  now(): number;
  /** A change signature for a file (e.g. size:mtime, or a content hash), or
      undefined when the file is gone/unreadable. Unchanged signature ⇒ already
      indexed ⇒ skipped. */
  signatureOf(path: string): string | undefined;
  /** Compute and store one file's symbol edges. Host-provided; may reject —
      the caller records the file as done anyway so a persistently failing file
      doesn't wedge the queue (it retries when its signature next changes). */
  indexFile(path: string): Promise<void>;
  /** Cooperative cancellation checked between files. */
  signal?: AbortLike;
}

export interface SymbolPassOptions {
  /** Wall-clock budget per runTick() call. */
  budgetMs: number;
}

export class SymbolPass {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  /** path → signature it was last indexed at. */
  private readonly indexed = new Map<string, string>();

  constructor(
    private readonly deps: SymbolPassDeps,
    private readonly options: SymbolPassOptions,
  ) {}

  /** Point the sweep at the current corpus. Files new or changed since they were
      last indexed get queued; files no longer present are forgotten so their
      stale edges can be dropped by the host. Returns the forgotten paths. */
  setFiles(files: readonly string[]): string[] {
    const present = new Set(files);
    const removed: string[] = [];
    for (const path of [...this.indexed.keys()]) {
      if (!present.has(path)) {
        this.indexed.delete(path);
        removed.push(path);
      }
    }
    for (const path of files) this.enqueueIfStale(path);
    return removed;
  }

  private enqueueIfStale(path: string): void {
    if (this.queued.has(path)) return;
    const signature = this.deps.signatureOf(path);
    if (signature === undefined) return; // unreadable/gone — nothing to index
    if (this.indexed.get(path) === signature) return; // unchanged since last index
    this.queued.add(path);
    this.queue.push(path);
  }

  hasWork(): boolean {
    return this.queue.length > 0;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  /** Index queued files until the time budget is spent, the queue drains, or the
      signal aborts. Returns how many files were indexed this tick. Re-checks the
      signature at processing time (a file may have changed again or vanished
      while it sat in the queue) and records each processed file so it isn't
      touched again until it changes. */
  async runTick(): Promise<number> {
    const deadline = this.deps.now() + this.options.budgetMs;
    let processed = 0;
    while (this.queue.length > 0) {
      if (this.deps.signal?.aborted) break;
      if (this.deps.now() >= deadline) break;
      const path = this.queue.shift()!;
      this.queued.delete(path);
      const signature = this.deps.signatureOf(path);
      if (signature === undefined) continue; // vanished since queued
      if (this.indexed.get(path) === signature) continue; // already current
      try {
        await this.deps.indexFile(path);
      } catch {
        /* Record it done regardless — a failing file must not wedge the queue;
           it retries when its signature next changes. */
      }
      this.indexed.set(path, signature);
      processed += 1;
    }
    return processed;
  }
}
