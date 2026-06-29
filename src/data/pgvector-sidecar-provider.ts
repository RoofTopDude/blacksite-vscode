// VectorProvider backed by a PostgreSQL + pgvector sidecar.
//
// Optional advanced mode (BLA-80/81): swapped in for the default exact-local provider
// when the user opts into the container backend. The Postgres client (`pg`) is loaded
// lazily and is NOT a hard dependency — if it is absent, `createPgVectorProvider`
// returns `null` and the surface stays on embedded exact search. A minimal `PgClient`
// can also be injected directly, which keeps this unit-testable without a database.

import {
  normalize,
  type VectorBackendMode,
  type VectorProvider,
  type VectorRecord,
  type VectorSearchHit,
  type VectorSearchOptions,
  type VectorStats,
} from "./vector-provider.js";

export interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

function toVectorLiteral(vector: number[]): string {
  // pgvector accepts the textual form: '[0.1,0.2,...]'
  return `[${vector.join(",")}]`;
}

export class PgVectorSidecarProvider implements VectorProvider {
  readonly mode: VectorBackendMode = "pgvector_container";

  constructor(private readonly client: PgClient) {}

  async upsert(record: VectorRecord): Promise<void> {
    await this.upsertBatch([record]);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      const vector = toVectorLiteral(normalize(record.vector));
      await this.client.query(
        `INSERT INTO embeddings (id, collection, payload, vector)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET collection = EXCLUDED.collection, payload = EXCLUDED.payload, vector = EXCLUDED.vector`,
        [record.id, record.collection ?? "default", record.payload ? JSON.stringify(record.payload) : null, vector],
      );
    }
  }

  async delete(id: string): Promise<boolean> {
    await this.client.query("DELETE FROM embeddings WHERE id = $1", [id]);
    return true;
  }

  async search(query: number[], options: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    const topK = Math.max(1, options.topK ?? 10);
    const vector = toVectorLiteral(normalize(query));
    // `<=>` is pgvector's cosine distance; similarity = 1 - distance.
    const where = options.collection ? "WHERE collection = $2" : "";
    const params: unknown[] = options.collection ? [vector, options.collection, topK] : [vector, topK];
    const limitParam = options.collection ? "$3" : "$2";
    const result = await this.client.query(
      `SELECT id, collection, payload, 1 - (vector <=> $1) AS score
       FROM embeddings ${where}
       ORDER BY vector <=> $1 ASC
       LIMIT ${limitParam}`,
      params,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      score: Number(row.score ?? 0),
      collection: String(row.collection ?? "default"),
      payload: parsePayload(row.payload),
      chunkId: undefined,
    }));
  }

  async stats(): Promise<VectorStats> {
    const result = await this.client.query(
      "SELECT collection, COUNT(*)::int AS count FROM embeddings GROUP BY collection ORDER BY collection",
    );
    const collections = result.rows.map((row) => ({
      name: String(row.collection ?? "default"),
      count: Number(row.count ?? 0),
      dims: 0,
    }));
    return {
      backend: this.mode,
      total: collections.reduce((sum, c) => sum + c.count, 0),
      collections,
    };
  }

  async rebuild(): Promise<void> {
    // Rebuild the ANN index. IVFFlat needs data present before indexing.
    await this.client.query(
      "CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists = 100)",
    );
  }
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

export interface CreatePgVectorResult {
  ok: boolean;
  provider?: PgVectorSidecarProvider;
  client?: PgClient;
  reason?: string;
}

/**
 * Lazily load `pg` and connect. Returns `{ ok: false }` (never throws) when the client
 * is not installed or the connection fails, so the caller can stay on exact-local.
 */
export async function createPgVectorProvider(connectionString: string): Promise<CreatePgVectorResult> {
  type PgModule = { Client: new (config: { connectionString: string }) => unknown };
  let pgModule: PgModule | null = null;
  try {
    const req = (typeof require === "function" ? require : null) as ((id: string) => unknown) | null;
    pgModule = req ? (req("pg") as PgModule) : null;
  } catch {
    pgModule = null;
  }
  if (!pgModule?.Client) {
    return { ok: false, reason: "The 'pg' client is not installed. Install it to enable the pgvector sidecar." };
  }

  try {
    const raw = new pgModule.Client({ connectionString }) as {
      connect(): Promise<void>;
      query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
      end(): Promise<void>;
    };
    await raw.connect();
    const client: PgClient = { query: (sql, params) => raw.query(sql, params), end: () => raw.end() };
    return { ok: true, provider: new PgVectorSidecarProvider(client), client };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
