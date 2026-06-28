import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

interface StoredEntry {
  id: string;
  vec: number[];
  payload: Record<string, unknown>;
  ts: number;
}

interface StorageFile {
  v: 1;
  entries: StoredEntry[];
}

// ── Math helpers ───────────────────────────────────────────────────────────────

function l2norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s) || 1;
}

function normalizeVec(v: number[]): number[] {
  const n = l2norm(v);
  return v.map((x) => x / n);
}

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

// ── VectorStore ────────────────────────────────────────────────────────────────

export class VectorStore {
  private entries: StoredEntry[] = [];
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 30_000,
  ) {}

  load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as StorageFile;
      if (data.v === 1 && Array.isArray(data.entries)) {
        this.entries = data.entries;
      }
    } catch { /* new store */ }
  }

  save(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const data: StorageFile = { v: 1, entries: this.entries };
      fs.writeFileSync(this.filePath, JSON.stringify(data), "utf8");
      this.dirty = false;
    } catch { /* non-fatal */ }
  }

  private _scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 3_000);
  }

  upsert(id: string, vector: number[], payload: Record<string, unknown>): void {
    const vec = normalizeVec(vector);
    const existing = this.entries.findIndex((e) => e.id === id);
    const entry: StoredEntry = { id, vec, payload, ts: Date.now() };
    if (existing >= 0) {
      this.entries[existing] = entry;
    } else {
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) {
        // Evict oldest entries across the whole store
        this.entries.sort((a, b) => a.ts - b.ts);
        this.entries = this.entries.slice(this.entries.length - this.maxEntries);
      }
    }
    this.dirty = true;
    this._scheduleSave();
  }

  search(
    vector: number[],
    topK: number,
    filter?: (payload: Record<string, unknown>) => boolean,
  ): VectorSearchResult[] {
    const q = normalizeVec(vector);
    const scored: Array<{ score: number; entry: StoredEntry }> = [];
    for (const entry of this.entries) {
      if (filter && !filter(entry.payload)) continue;
      scored.push({ score: dotProduct(q, entry.vec), entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ score, entry }) => ({
      id: entry.id,
      score,
      payload: entry.payload,
    }));
  }

  delete(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this.dirty = true;
    this._scheduleSave();
    return true;
  }

  collectionSize(col: string): number {
    return this.entries.filter((e) => e.payload["_col"] === col).length;
  }

  get size(): number { return this.entries.length; }

  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
  }
}
