/* Which Execution Runs touched which files — the "Activity" tab of the Map
   inspector ("runs that touched this file/area") and the outline's "touched in
   the last run" badges.

   Runs do not persist a touched-files set, and changing the run schema for it
   would be invasive, so footprints are derived from the same bounded event
   windows run playback already reads (RunPlaybackProvider.getMapEventWindow),
   built lazily the first time anything asks, and cached per run. A finished
   run is immutable, so its footprint is computed once and kept in
   .blacksite/map/run-footprints.json; a run still in progress is recomputed
   on each request. */

import * as fs from "fs";
import * as path from "path";

export interface RunSummaryLike {
  id: string;
  title: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
}

export interface RunEventLike {
  id: string;
  path: string;
  kind: string;
  at: number;
}

export interface RunEventSource {
  listRunSummaries(limit: number): readonly RunSummaryLike[] | Promise<readonly RunSummaryLike[]>;
  getMapEventWindow(runId: string, fromElapsedMs: number, toElapsedMs: number, limit: number): readonly RunEventLike[] | Promise<readonly RunEventLike[]>;
}

export interface RunFootprint {
  runId: string;
  title: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  /** path → [event count, first elapsed ms, kinds]. */
  files: Record<string, [number, number, string[]]>;
}

export interface RunTouch {
  runId: string;
  title: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  /** Matching files in the run, most-touched first (capped). */
  files: Array<{ path: string; count: number; kinds: string[] }>;
  /** Earliest elapsed ms any matching file was touched — where "Replay on map" seeks. */
  firstAt: number;
  events: number;
}

const WINDOW_LIMIT = 2000;
const MAX_PAGES_PER_RUN = 25;
const MAX_FILES_PER_FOOTPRINT = 2000;
const MAX_RUNS = 100;
const CACHE_VERSION = 1;
/* TerminalRunStatus (runs/run-model.ts): a run in one of these never changes again. */
const FINISHED = new Set(["succeeded", "partial", "failed", "cancelled", "timed_out"]);

/** Fold events into a footprint. Pure. */
export function footprintFromEvents(summary: RunSummaryLike, events: readonly RunEventLike[]): RunFootprint {
  const files = new Map<string, [number, number, Set<string>]>();
  for (const event of events) {
    if (!event.path) continue;
    const entry = files.get(event.path) ?? [0, event.at, new Set<string>()];
    entry[0] += 1;
    entry[1] = Math.min(entry[1], event.at);
    entry[2].add(event.kind);
    files.set(event.path, entry);
  }
  const ranked = [...files.entries()].sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0])).slice(0, MAX_FILES_PER_FOOTPRINT);
  return {
    runId: summary.id,
    title: summary.title,
    status: summary.status,
    ...(summary.startedAt ? { startedAt: summary.startedAt } : {}),
    ...(summary.endedAt ? { endedAt: summary.endedAt } : {}),
    files: Object.fromEntries(ranked.map(([file, [count, first, kinds]]) => [file, [count, first, [...kinds].sort()]])),
  };
}

/** Runs whose footprint touches any file `matches` accepts, newest first. Pure. */
export function runsTouching(footprints: readonly RunFootprint[], matches: (path: string) => boolean, limit = 20): RunTouch[] {
  const out: RunTouch[] = [];
  for (const footprint of footprints) {
    const files: RunTouch["files"] = [];
    let firstAt = Number.POSITIVE_INFINITY;
    let events = 0;
    for (const [file, [count, first, kinds]] of Object.entries(footprint.files)) {
      if (!matches(file)) continue;
      files.push({ path: file, count, kinds });
      firstAt = Math.min(firstAt, first);
      events += count;
    }
    if (files.length === 0) continue;
    files.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    out.push({
      runId: footprint.runId,
      title: footprint.title,
      status: footprint.status,
      ...(footprint.startedAt ? { startedAt: footprint.startedAt } : {}),
      ...(footprint.endedAt ? { endedAt: footprint.endedAt } : {}),
      files: files.slice(0, 12),
      firstAt: Number.isFinite(firstAt) ? firstAt : 0,
      events,
    });
  }
  out.sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "") || a.runId.localeCompare(b.runId));
  return out.slice(0, limit);
}

function durationMs(summary: RunSummaryLike): number {
  const start = summary.startedAt ? Date.parse(summary.startedAt) : Number.NaN;
  const end = summary.endedAt ? Date.parse(summary.endedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 24 * 60 * 60 * 1000;
}

export class RunFootprintIndex {
  private _cache = new Map<string, RunFootprint>();
  private _loaded = false;
  private _building: Promise<RunFootprint[]> | null = null;

  constructor(
    private readonly _source: RunEventSource,
    private readonly _cachePath: string | null,
  ) {}

  /** Drop in-progress footprints so the next request rebuilds them. */
  invalidate(): void {
    for (const [id, footprint] of this._cache) {
      if (!FINISHED.has(footprint.status.toLowerCase())) this._cache.delete(id);
    }
  }

  async footprints(): Promise<RunFootprint[]> {
    if (this._building) return this._building;
    this._building = this._build().finally(() => { this._building = null; });
    return this._building;
  }

  private async _build(): Promise<RunFootprint[]> {
    this._load();
    const summaries = await this._source.listRunSummaries(MAX_RUNS);
    const out: RunFootprint[] = [];
    let wrote = false;
    for (const summary of summaries) {
      const cached = this._cache.get(summary.id);
      if (cached && cached.status === summary.status && FINISHED.has(summary.status.toLowerCase())) {
        out.push(cached);
        continue;
      }
      const events: RunEventLike[] = [];
      const to = durationMs(summary);
      let from = 0;
      for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
        let window: readonly RunEventLike[] = [];
        try {
          window = await this._source.getMapEventWindow(summary.id, from, to, WINDOW_LIMIT);
        } catch {
          break;
        }
        events.push(...window);
        if (window.length < WINDOW_LIMIT) break;
        const last = window[window.length - 1]!.at;
        /* A page full of one millisecond cannot advance; stop rather than loop. */
        if (last <= from) break;
        from = last;
      }
      const footprint = footprintFromEvents(summary, events);
      this._cache.set(summary.id, footprint);
      out.push(footprint);
      if (FINISHED.has(summary.status.toLowerCase())) wrote = true;
    }
    if (wrote) this._save();
    return out;
  }

  private _load(): void {
    if (this._loaded || !this._cachePath) return;
    this._loaded = true;
    try {
      const doc = JSON.parse(fs.readFileSync(this._cachePath, "utf8")) as { version?: unknown; runs?: unknown };
      if (doc.version !== CACHE_VERSION || !Array.isArray(doc.runs)) return;
      for (const footprint of doc.runs as RunFootprint[]) {
        if (footprint && typeof footprint.runId === "string") this._cache.set(footprint.runId, footprint);
      }
    } catch { /* no cache yet */ }
  }

  private _save(): void {
    if (!this._cachePath) return;
    const finished = [...this._cache.values()].filter((footprint) => FINISHED.has(footprint.status.toLowerCase()));
    try {
      fs.mkdirSync(path.dirname(this._cachePath), { recursive: true });
      fs.writeFileSync(this._cachePath, JSON.stringify({ version: CACHE_VERSION, runs: finished.slice(-MAX_RUNS * 2) }), "utf8");
    } catch { /* best-effort derived cache */ }
  }
}
