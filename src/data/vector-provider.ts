// Pluggable vector backend abstraction.
//
// The product never bets on one vector engine (BLA-80): the default is `exact_local`
// (vectors persisted in SQLite, exact cosine search), with `pgvector_container` as an
// optional advanced backend. The UI and retrieval flows talk only to this interface,
// so switching backends does not touch the Data surface.

export type VectorBackendMode = "exact_local" | "pgvector_container" | "qdrant_container";

export interface VectorRecord {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
  /** Logical collection — lets one store hold several embedding spaces. */
  collection?: string;
  /** Optional chunk linkage for retrieval traces. */
  chunkId?: string;
  model?: string;
}

export interface VectorSearchHit {
  id: string;
  score: number;
  collection: string;
  payload: Record<string, unknown>;
  chunkId?: string;
}

export interface VectorSearchOptions {
  topK?: number;
  collection?: string;
  /** Optional predicate over the stored payload. */
  filter?: (payload: Record<string, unknown>) => boolean;
}

export interface VectorStats {
  backend: VectorBackendMode;
  total: number;
  collections: Array<{ name: string; count: number; dims: number; model?: string }>;
}

export interface VectorProvider {
  readonly mode: VectorBackendMode;
  upsert(record: VectorRecord): Promise<void>;
  upsertBatch(records: VectorRecord[]): Promise<void>;
  delete(id: string): Promise<boolean>;
  search(query: number[], options?: VectorSearchOptions): Promise<VectorSearchHit[]>;
  stats(): Promise<VectorStats>;
  /** Drop and recompute backend-side indexes/structures. No-op for exact search. */
  rebuild(): Promise<void>;
}

// ── Shared vector math ───────────────────────────────────────────────────────

export function l2norm(vector: number[]): number {
  let sum = 0;
  for (const x of vector) sum += x * x;
  return Math.sqrt(sum) || 1;
}

export function normalize(vector: number[]): number[] {
  const n = l2norm(vector);
  return vector.map((x) => x / n);
}

/** Cosine similarity for already-normalised vectors reduces to a dot product. */
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
