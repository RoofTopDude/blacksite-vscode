// Default vector backend: exact cosine search over vectors persisted in SQLite.
//
// Zero external dependencies — vectors live in `core_embeddings` as L2-normalised
// JSON arrays, and search is an exact dot-product scan. This is the correct default
// for single-user, local, small-to-medium corpora; the `pgvector_container` provider
// is the scaling escape hatch when ANN indexing is actually needed.

import type { DatabaseManager } from "./database-manager.js";
import {
  dot,
  normalize,
  type VectorBackendMode,
  type VectorProvider,
  type VectorRecord,
  type VectorSearchHit,
  type VectorSearchOptions,
  type VectorStats,
} from "./vector-provider.js";

interface EmbeddingRow extends Record<string, unknown> {
  id: string;
  chunk_id: string | null;
  collection: string;
  model: string | null;
  dims: number;
  vector: string;
  payload: string | null;
}

function newId(): string {
  return `emb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class ExactLocalVectorProvider implements VectorProvider {
  readonly mode: VectorBackendMode = "exact_local";

  constructor(private readonly db: DatabaseManager) {}

  async upsert(record: VectorRecord): Promise<void> {
    await this.upsertBatch([record]);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.enqueueWrite((driver) => {
      driver.transaction(() => {
        for (const record of records) {
          const normalized = normalize(record.vector);
          const id = record.id || newId();
          const collection = record.collection ?? "default";
          const payload = record.payload ? JSON.stringify(record.payload) : null;
          driver.run(
            `INSERT INTO core_embeddings (id, chunk_id, collection, model, dims, vector, norm, payload)
             VALUES (:id, :chunk_id, :collection, :model, :dims, :vector, 1, :payload)
             ON CONFLICT(id) DO UPDATE SET
               chunk_id = excluded.chunk_id,
               collection = excluded.collection,
               model = excluded.model,
               dims = excluded.dims,
               vector = excluded.vector,
               payload = excluded.payload`,
            {
              id,
              chunk_id: record.chunkId ?? null,
              collection,
              model: record.model ?? null,
              dims: normalized.length,
              vector: JSON.stringify(normalized),
              payload,
            },
          );
        }
      });
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.db.enqueueWrite((driver) => {
      const result = driver.run("DELETE FROM core_embeddings WHERE id = ?", [id]);
      return result.changes > 0;
    });
  }

  async search(query: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const topK = Math.max(1, options.topK ?? 10);
    const q = normalize(query);
    const rows = options.collection
      ? this.db.all<EmbeddingRow>("SELECT * FROM core_embeddings WHERE collection = ?", [options.collection])
      : this.db.all<EmbeddingRow>("SELECT * FROM core_embeddings");

    const scored: VectorSearchHit[] = [];
    for (const row of rows) {
      let vector: number[];
      try {
        vector = JSON.parse(row.vector) as number[];
      } catch {
        continue;
      }
      // Skip rows embedded at a different dimensionality — dot() truncates to the
      // shorter length, which would otherwise produce a meaningless partial score
      // that still sorts alongside genuinely comparable hits.
      if (vector.length !== q.length) continue;
      const payload = parsePayload(row.payload);
      if (options.filter && !options.filter(payload)) continue;
      scored.push({
        id: row.id,
        score: dot(q, vector),
        collection: row.collection,
        payload,
        chunkId: row.chunk_id ?? undefined,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async stats(): Promise<VectorStats> {
    const rows = this.db.all<{ collection: string; count: number; dims: number; model: string | null }>(
      `SELECT collection, COUNT(*) AS count, MAX(dims) AS dims, MAX(model) AS model
       FROM core_embeddings GROUP BY collection ORDER BY collection`,
    );
    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    return {
      backend: this.mode,
      total,
      collections: rows.map((row) => ({
        name: row.collection,
        count: Number(row.count),
        dims: Number(row.dims),
        model: row.model ?? undefined,
      })),
    };
  }

  async rebuild(): Promise<void> {
    // Exact search holds no derived index — nothing to rebuild. Provided so callers
    // can treat every backend uniformly.
  }
}
