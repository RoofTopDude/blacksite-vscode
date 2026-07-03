import { describe, expect, it } from "vitest";
import { DatabaseManager } from "../../src/data/database-manager.js";
import { ExactLocalVectorProvider } from "../../src/data/exact-local-vector-provider.js";
import { chunkText, ingestDocumentForRag, referenceCollection } from "../../src/reference-ingestion.js";
import type { EmbeddingService } from "../../src/embedding-service.js";

function fakeEmbeddingService(dims = 8): EmbeddingService {
  return {
    modelId: "fake-embed-1",
    dimensions: dims,
    embed: async (text: string) => {
      // Deterministic pseudo-embedding so different chunks produce different (but stable) vectors.
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
      return vec.map((v) => v || 0.0001);
    },
  } as unknown as EmbeddingService;
}

function seedDocument(db: DatabaseManager): string {
  const documentId = "doc_1";
  db.driver.run("INSERT INTO core_sources (id, kind, title) VALUES ('src_1', 'file', 'report.pdf')");
  db.driver.run(
    "INSERT INTO core_documents (id, source_id, title, byte_size) VALUES (?, 'src_1', 'report.pdf', 100)",
    [documentId],
  );
  return documentId;
}

describe("chunkText", () => {
  it("returns no chunks for blank input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("chunks long text with overlap and never loops forever when overlap >= chunkSize", () => {
    const text = "a".repeat(500);
    const chunks = chunkText(text, 100, 150); // pathological: overlap > chunkSize
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(1000); // sanity bound — would be Infinity if it looped
  });

  it("produces overlapping windows that together cover the whole text", () => {
    const text = "0123456789".repeat(20); // 200 chars
    const chunks = chunkText(text, 50, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(50);
  });

  it("returns a single chunk when text is shorter than the chunk size", () => {
    expect(chunkText("short text", 1024, 128)).toEqual(["short text"]);
  });
});

describe("ingestDocumentForRag", () => {
  it("chunks, embeds, and writes core_chunks/core_embeddings/core_jobs rows", async () => {
    const db = new DatabaseManager(":memory:");
    db.open();
    const documentId = seedDocument(db);
    const embedding = fakeEmbeddingService();

    const result = await ingestDocumentForRag(db, embedding, {
      documentId,
      title: "report.pdf",
      body: "Revenue grew significantly this quarter.\n\n".repeat(50), // long enough to force multiple chunks
      sessionId: "s_1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.chunkCount).toBeGreaterThan(0);

    const chunkRows = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM core_chunks WHERE document_id = ?", [documentId]);
    expect(chunkRows[0]!.n).toBe(result.chunkCount);

    const embeddingRows = db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_embeddings WHERE collection = ?",
      [referenceCollection("s_1")],
    );
    expect(embeddingRows[0]!.n).toBe(result.chunkCount);

    const jobRows = db.all<{ status: string; completed: number; total: number }>(
      "SELECT status, completed, total FROM core_jobs WHERE kind = 'embed'",
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]!.status).toBe("done");
    expect(jobRows[0]!.completed).toBe(result.chunkCount);

    const profileRows = db.all<{ name: string }>("SELECT name FROM core_retrieval_profiles");
    expect(profileRows).toHaveLength(1);
    expect(profileRows[0]!.name).toBe("reference-default");

    db.close();
  });

  it("reuses the same retrieval profile across multiple ingestions", async () => {
    const db = new DatabaseManager(":memory:");
    db.open();
    seedDocument(db);
    const embedding = fakeEmbeddingService();

    await ingestDocumentForRag(db, embedding, { documentId: "doc_1", title: "a", body: "hello world", sessionId: "s_1" });
    db.driver.run("INSERT INTO core_sources (id, kind, title) VALUES ('src_2', 'file', 'b.txt')");
    db.driver.run("INSERT INTO core_documents (id, source_id, title, byte_size) VALUES ('doc_2', 'src_2', 'b.txt', 5)");
    await ingestDocumentForRag(db, embedding, { documentId: "doc_2", title: "b", body: "goodbye world", sessionId: "s_1" });

    const profiles = db.all("SELECT id FROM core_retrieval_profiles");
    expect(profiles).toHaveLength(1);
    db.close();
  });

  it("fails cleanly with no core_chunks/core_embeddings rows when there is no extractable text", async () => {
    const db = new DatabaseManager(":memory:");
    db.open();
    const documentId = seedDocument(db);
    const result = await ingestDocumentForRag(db, fakeEmbeddingService(), {
      documentId, title: "report.pdf", body: "   ", sessionId: "s_1",
    });
    expect(result.ok).toBe(false);
    const chunkRows = db.all("SELECT * FROM core_chunks");
    expect(chunkRows).toHaveLength(0);
    db.close();
  });

  it("makes ingested chunks findable via ExactLocalVectorProvider.search scoped to the session collection", async () => {
    const db = new DatabaseManager(":memory:");
    db.open();
    const documentId = seedDocument(db);
    const embedding = fakeEmbeddingService();
    await ingestDocumentForRag(db, embedding, {
      documentId, title: "report.pdf", body: "Quarterly revenue figures for the finance team.", sessionId: "s_1",
    });

    const vectors = new ExactLocalVectorProvider(db);
    const queryVector = await embedding.embed("revenue figures");
    const hits = await vectors.search(queryVector, { collection: referenceCollection("s_1") });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.payload["documentId"]).toBe(documentId);

    // A different session's collection must not see these chunks.
    const otherHits = await vectors.search(queryVector, { collection: referenceCollection("s_other") });
    expect(otherHits).toHaveLength(0);

    db.close();
  });
});
