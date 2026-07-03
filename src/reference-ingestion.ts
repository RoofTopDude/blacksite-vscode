// Optional RAG ingestion for attached files — activates the previously-dormant
// core_chunks/core_embeddings/core_retrieval_profiles/core_jobs schema (see
// data/schema/v1.sql). Gated entirely on the caller confirming a real embedding key
// resolves first (see chat-provider.ts's _hasEmbeddingKey) — this module never runs
// against the local sparse fallback, to avoid silently populating low-quality vectors.
// reference_read stays fully functional with or without this ever running.

import * as crypto from "crypto";
import type { DatabaseManager } from "./data/database-manager.js";
import { ExactLocalVectorProvider } from "./data/exact-local-vector-provider.js";
import type { EmbeddingService } from "./embedding-service.js";

const DEFAULT_CHUNK_SIZE = 1024;
const DEFAULT_CHUNK_OVERLAP = 128;
const RETRIEVAL_PROFILE_NAME = "reference-default";

/** Vector collection scoping search to one conversation's attachments. */
export function referenceCollection(sessionId: string): string {
  return `reference:${sessionId}`;
}

/** Fixed-size overlapping character chunks. Step is clamped to >=1 so overlap >= chunkSize can never loop forever. */
export function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const step = Math.max(1, chunkSize - Math.max(0, overlap));
  const chunks: string[] = [];
  for (let start = 0; start < trimmed.length; start += step) {
    const chunk = trimmed.slice(start, start + chunkSize).trim();
    if (chunk) chunks.push(chunk);
    if (start + chunkSize >= trimmed.length) break;
  }
  return chunks;
}

function ensureDefaultRetrievalProfile(db: DatabaseManager, embedding: EmbeddingService): Promise<string> {
  const existing = db.get<{ id: string }>(
    "SELECT id FROM core_retrieval_profiles WHERE name = ? LIMIT 1",
    [RETRIEVAL_PROFILE_NAME],
  );
  if (existing) return Promise.resolve(existing.id);
  const id = crypto.randomUUID();
  return db.enqueueWrite((driver) => {
    driver.run(
      `INSERT INTO core_retrieval_profiles (id, name, embedding_model, dims, chunk_size, chunk_overlap, vector_backend)
       VALUES (?, ?, ?, ?, ?, ?, 'exact_local')`,
      [id, RETRIEVAL_PROFILE_NAME, embedding.modelId, embedding.dimensions, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP],
    );
    return id;
  });
}

export interface IngestDocumentInput {
  documentId: string;
  title: string;
  body: string;
  sessionId: string;
}

export type IngestResult = { ok: true; chunkCount: number } | { ok: false; error: string };

/** Chunks + embeds an already-cataloged document (a core_documents row) into core_chunks/core_embeddings, tracked via a core_jobs row. */
export async function ingestDocumentForRag(
  db: DatabaseManager,
  embedding: EmbeddingService,
  input: IngestDocumentInput,
): Promise<IngestResult> {
  const chunks = chunkText(input.body);
  if (chunks.length === 0) return { ok: false, error: "No chunkable text extracted from this document." };

  const profileId = await ensureDefaultRetrievalProfile(db, embedding);
  const jobId = crypto.randomUUID();
  const chunkIds = chunks.map(() => crypto.randomUUID());

  await db.enqueueWrite((driver) => {
    driver.transaction(() => {
      driver.run(
        "INSERT INTO core_jobs (id, kind, status, total, payload, started_at) VALUES (?, 'embed', 'running', ?, ?, datetime('now'))",
        [jobId, chunks.length, JSON.stringify({ documentId: input.documentId, profileId, title: input.title })],
      );
      chunks.forEach((content, i) => {
        driver.run(
          "INSERT INTO core_chunks (id, document_id, ordinal, content, token_count) VALUES (?, ?, ?, ?, ?)",
          [chunkIds[i]!, input.documentId, i, content, Math.ceil(content.length / 4)],
        );
      });
    });
  });

  try {
    const vectors: number[][] = [];
    for (const content of chunks) vectors.push(await embedding.embed(content));

    const vectorProvider = new ExactLocalVectorProvider(db);
    await vectorProvider.upsertBatch(vectors.map((vector, i) => ({
      id: crypto.randomUUID(),
      vector,
      collection: referenceCollection(input.sessionId),
      chunkId: chunkIds[i],
      model: embedding.modelId,
      payload: { documentId: input.documentId, title: input.title, ordinal: i },
    })));

    await db.enqueueWrite((driver) => {
      driver.run(
        "UPDATE core_jobs SET status = 'done', completed = ?, progress = 1, finished_at = datetime('now') WHERE id = ?",
        [chunks.length, jobId],
      );
    });
    return { ok: true, chunkCount: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.enqueueWrite((driver) => {
      driver.run(
        "UPDATE core_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?",
        [message, jobId],
      );
    }).catch(() => undefined);
    return { ok: false, error: message };
  }
}
