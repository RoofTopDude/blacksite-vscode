import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReferenceStore } from "../../src/reference-store.js";
import { ReferenceToolService } from "../../src/reference-tools.js";
import { DatabaseManager } from "../../src/data/database-manager.js";
import type { EmbeddingService } from "../../src/embedding-service.js";

const CTX = { sessionId: "s_1" };

let root: string;
let store: ReferenceStore;
let service: ReferenceToolService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-reftools-"));
  store = new ReferenceStore(root);
  store.ensureInitialized();
  service = new ReferenceToolService(store);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function attach(name: string, content: string | Buffer): void {
  const src = path.join(root, `src-${name}`);
  fs.writeFileSync(src, content);
  store.copyAttachment(CTX.sessionId, src, name);
}

describe("ReferenceToolService", () => {
  it("list/context_read/context_write still work through the service", async () => {
    attach("notes.txt", "hello");
    const list = await service.dispatch("list", {}, CTX);
    expect(list.ok).toBe(true);
    expect((list.attachments as Array<{ name: string }>).map((a) => a.name)).toEqual(["notes.txt"]);
    expect(list.attachments).toMatchObject([
      {
        name: "notes.txt",
        type: ".txt",
        size: 5,
        byteSize: 5,
        extractionStatus: "uncataloged",
      },
    ]);

    await service.dispatch("context_write", { entry: "finding one" }, CTX);
    const read = await service.dispatch("context_read", {}, CTX);
    expect(read.content).toContain("finding one");
  });

  it("reference_list reports document metadata when an attachment is cataloged", async () => {
    attach("notes.txt", "hello");
    const attachment = store.listAttachments(CTX.sessionId)[0]!;
    const db = new DatabaseManager(":memory:");
    db.open();
    db.driver.run(
      "INSERT INTO core_sources (id, kind, uri, title) VALUES ('src_1', 'file', ?, 'notes.txt')",
      [attachment.path],
    );
    db.driver.run(
      "INSERT INTO core_documents (id, source_id, title, body, mime, byte_size, hash) VALUES ('doc_1', 'src_1', 'notes.txt', 'hello', 'text/plain', 5, ?)",
      [attachment.hash],
    );

    const ragService = new ReferenceToolService(store, { database: db, buildEmbeddingService: () => fakeEmbeddingService() });
    const list = await ragService.dispatch("list", {}, CTX);
    expect(list.ok).toBe(true);
    expect(list.attachments).toMatchObject([
      {
        id: "doc_1",
        name: "notes.txt",
        type: "text/plain",
        size: 5,
        byteSize: 5,
        extractionStatus: "extracted",
      },
    ]);

    db.close();
  });

  it("reference_read extracts text from an attached text file", async () => {
    attach("report.txt", "line one\nline two");
    const result = await service.dispatch("read", { name: "report.txt" }, CTX);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("line one\nline two");
  });

  it("reference_read returns a clear error for an unknown attachment name", async () => {
    const result = await service.dispatch("read", { name: "missing.txt" }, CTX);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("missing.txt");
  });

  it("reference_query_spreadsheet runs a jq filter over CSV rows", async () => {
    attach("data.csv", "name,qty\nWidget,3\nGadget,7\n");
    const result = await service.dispatch(
      "query_spreadsheet",
      { name: "data.csv", filter: ".[] | select(.qty | tonumber > 5) | .name" },
      CTX,
    );
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Gadget");
    expect(result.columns).toEqual(["name", "qty"]);
  });

  it("reference_query_spreadsheet rejects an unsupported format", async () => {
    attach("notes.txt", "hello");
    const result = await service.dispatch(
      "query_spreadsheet",
      { name: "notes.txt", filter: "." },
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("not a supported spreadsheet format");
  });

  it("reference_query_spreadsheet surfaces a clear error for an invalid jq filter", async () => {
    attach("data.csv", "a,b\n1,2\n");
    const result = await service.dispatch(
      "query_spreadsheet",
      { name: "data.csv", filter: "not valid jq {{{" },
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Invalid jq filter");
  });

  it("reference_zoom_image crops and upscales a region of an attached image", async () => {
    const { Jimp } = await import("jimp");
    const source = new Jimp({ width: 100, height: 100, color: 0x00ff00ff });
    const buffer = Buffer.from(await source.getBuffer("image/png"));
    attach("photo.png", buffer);

    const result = await service.dispatch(
      "zoom_image",
      { name: "photo.png", x: 10, y: 10, width: 20, height: 20 },
      CTX,
    );
    expect(result.ok).toBe(true);
    expect(result.mediaDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.zoomedWidth).toBe(40);
    expect(result.zoomedHeight).toBe(40);
  });

  it("reference_zoom_image clamps an out-of-bounds crop region instead of throwing", async () => {
    const { Jimp } = await import("jimp");
    const source = new Jimp({ width: 50, height: 50, color: 0xff00ffff });
    const buffer = Buffer.from(await source.getBuffer("image/png"));
    attach("photo2.png", buffer);

    const result = await service.dispatch(
      "zoom_image",
      { name: "photo2.png", x: 40, y: 40, width: 1000, height: 1000 },
      CTX,
    );
    expect(result.ok).toBe(true);
    const region = result.region as { x: number; y: number; width: number; height: number };
    expect(region.x + region.width).toBeLessThanOrEqual(50);
    expect(region.y + region.height).toBeLessThanOrEqual(50);
  });
});

function fakeEmbeddingService(dims = 8): EmbeddingService {
  return {
    modelId: "fake-embed-1",
    dimensions: dims,
    embed: async (text: string) => {
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
      return vec.map((v) => v || 0.0001);
    },
  } as unknown as EmbeddingService;
}

describe("ReferenceToolService — reference_vector_search", () => {
  it("reports unavailable when no rag support is configured", async () => {
    const result = await service.dispatch("vector_search", { query: "revenue" }, CTX);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("isn't available");
  });

  it("requires a non-empty query", async () => {
    const db = new DatabaseManager(":memory:");
    db.open();
    const ragService = new ReferenceToolService(store, { database: db, buildEmbeddingService: () => fakeEmbeddingService() });
    const result = await ragService.dispatch("vector_search", { query: "" }, CTX);
    expect(result.ok).toBe(false);
    db.close();
  });

  it("returns hits scoped to the session's ingested chunks", async () => {
    const db = new DatabaseManager(":memory:");
    db.open();
    db.driver.run("INSERT INTO core_sources (id, kind, title) VALUES ('src_1', 'file', 'report.pdf')");
    db.driver.run("INSERT INTO core_documents (id, source_id, title, byte_size) VALUES ('doc_1', 'src_1', 'report.pdf', 10)");

    const { ingestDocumentForRag } = await import("../../src/reference-ingestion.js");
    const embedding = fakeEmbeddingService();
    await ingestDocumentForRag(db, embedding, {
      documentId: "doc_1", title: "report.pdf", body: "Quarterly revenue grew across all regions.", sessionId: CTX.sessionId,
    });

    const ragService = new ReferenceToolService(store, { database: db, buildEmbeddingService: () => embedding });
    const result = await ragService.dispatch("vector_search", { query: "revenue growth" }, CTX);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.hits)).toBe(true);
    expect((result.hits as unknown[]).length).toBeGreaterThan(0);

    // A different conversation's session must not see these results.
    const otherResult = await ragService.dispatch("vector_search", { query: "revenue growth" }, { sessionId: "s_other" });
    expect(otherResult.ok).toBe(true);
    expect(otherResult.hits).toEqual([]);

    db.close();
  });
});
