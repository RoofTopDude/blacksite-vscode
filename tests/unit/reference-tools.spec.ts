import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReferenceStore } from "../../src/reference-store.js";
import { ReferenceToolService } from "../../src/reference-tools.js";
import { DatabaseManager } from "../../src/data/database-manager.js";
import type { EmbeddingService } from "../../src/embedding-service.js";
import { minimalPdfBytes } from "./helpers/minimal-pdf.js";

const CTX = { sessionId: "s_1" };

/* jimp is a heavy dependency (~11s to import cold on a loaded machine). Importing it
   inside a test body spends that against the 5s per-test budget, which made the zoom
   tests fail under full-suite parallelism while passing in isolation. Resolve it once
   here instead, where the hook gets a budget sized for a cold import. */
let Jimp: typeof import("jimp").Jimp;

beforeAll(async () => {
  ({ Jimp } = await import("jimp"));
}, 60_000);

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

  it("reference_read navigates PDFs by explicit page range without a database", async () => {
    attach("manual.pdf", Buffer.from(minimalPdfBytes(["Opening", "Target Chapter", "Appendix"])));
    const result = await service.dispatch("read", { name: "manual.pdf", startPage: 2, endPage: 2 }, CTX);
    expect(result.ok).toBe(true);
    expect(result.pageCount).toBe(3);
    expect(result.range).toEqual({ startPage: 2, endPage: 2 });
    expect(result.pages).toMatchObject([{ pageNumber: 2, content: expect.stringContaining("Target Chapter") }]);
    expect(result.nextPage).toBe(3);
  });

  it("reference_search returns page-numbered PDF snippets without embeddings", async () => {
    attach("manual.pdf", Buffer.from(minimalPdfBytes(["Overview", "Needle evidence", "Other needle detail"])));
    const result = await service.dispatch("search", { name: "manual.pdf", query: "needle" }, CTX);
    expect(result.ok).toBe(true);
    expect(result.totalMatches).toBe(2);
    expect(result.matches).toMatchObject([
      { pageNumber: 2, snippet: expect.stringContaining("Needle evidence") },
      { pageNumber: 3, snippet: expect.stringContaining("needle detail") },
    ]);
  });

  it("reference_read addresses a PDF already in the workspace", async () => {
    const file = path.join(root, "docs", "architecture.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(minimalPdfBytes(["Introduction", "Workspace evidence"])));
    service = new ReferenceToolService(store, undefined, [root]);

    const result = await service.dispatch("read", { path: "docs/architecture.pdf", startPage: 2 }, CTX);
    expect(result).toMatchObject({
      ok: true,
      name: "architecture.pdf",
      source: "workspace",
      path: "docs/architecture.pdf",
      range: { startPage: 2, endPage: 2 },
      pages: [{ pageNumber: 2, content: expect.stringContaining("Workspace evidence") }],
    });
  });

  it("reference_search addresses a workspace PDF without attachment indexing", async () => {
    const file = path.join(root, "docs", "manual.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(minimalPdfBytes(["Overview", "Project needle evidence"])));
    service = new ReferenceToolService(store, undefined, [root]);

    const result = await service.dispatch("search", { path: "docs/manual.pdf", query: "needle" }, CTX);
    expect(result).toMatchObject({
      ok: true,
      name: "manual.pdf",
      source: "workspace",
      path: "docs/manual.pdf",
      totalMatches: 1,
      matches: [{ pageNumber: 2, snippet: expect.stringContaining("needle evidence") }],
    });
  });

  it("refuses workspace PDF paths that escape the project", async () => {
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.pdf`);
    fs.writeFileSync(outside, Buffer.from(minimalPdfBytes(["Not in this workspace"])));
    service = new ReferenceToolService(store, undefined, [root]);
    try {
      const result = await service.dispatch("read", { path: outside }, CTX);
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("outside the open workspace");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("does not follow a workspace PDF symlink outside the project", async () => {
    const outside = path.join(path.dirname(root), `outside-link-${path.basename(root)}.pdf`);
    const link = path.join(root, "linked-outside.pdf");
    fs.writeFileSync(outside, Buffer.from(minimalPdfBytes(["Outside through a link"])));
    try {
      try {
        fs.symlinkSync(outside, link, "file");
      } catch {
        // Some Windows configurations deny unprivileged symlink creation; the ordinary
        // outside-path test above still covers the lexical boundary on those hosts.
        return;
      }
      service = new ReferenceToolService(store, undefined, [root]);
      const result = await service.dispatch("read", { path: "linked-outside.pdf" }, CTX);
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("resolves outside the open workspace");
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { force: true });
    }
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

  it("reference_zoom_image can inspect an entire image before coordinates are known", async () => {
    const source = new Jimp({ width: 30, height: 20, color: 0x00ff00ff });
    attach("whole-image.png", Buffer.from(await source.getBuffer("image/png")));

    const result = await service.dispatch("zoom_image", { name: "whole-image.png" }, CTX);
    expect(result).toMatchObject({
      ok: true,
      region: { x: 0, y: 0, width: 30, height: 20 },
      zoomedWidth: 60,
      zoomedHeight: 40,
    });
  });

  it("reference_zoom_image clamps an out-of-bounds crop region instead of throwing", async () => {
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

  /** Width and height used to be clamped to 1600 independently, so a default call on any wide
   *  screenshot came back square — a 1920×1080 capture returned 1600×1600. */
  it("reference_zoom_image keeps the crop's aspect ratio when the zoom is capped", async () => {
    const source = new Jimp({ width: 1920, height: 1080, color: 0x336699ff });
    attach("wide.png", Buffer.from(await source.getBuffer("image/png")));

    const whole = await service.dispatch("zoom_image", { name: "wide.png" }, CTX);
    expect(whole).toMatchObject({ ok: true, zoomedWidth: 1600, zoomedHeight: 900 });

    const byWidth = await service.dispatch("zoom_image", { name: "wide.png", width: 400, height: 100, targetWidth: 800 }, CTX);
    expect(byWidth).toMatchObject({ ok: true, zoomedWidth: 800, zoomedHeight: 200 });
  }, 20_000);

  /** Jimp has no WebP decoder, so WebP only worked where macOS `sips` could convert it. */
  it("reference_zoom_image decodes WebP on every platform", async () => {
    attach("capture.webp", Buffer.from(WEBP_64X32_RED, "base64"));
    const result = await service.dispatch("zoom_image", { name: "capture.webp" }, CTX);
    expect(result).toMatchObject({ ok: true, region: { width: 64, height: 32 }, zoomedWidth: 128, zoomedHeight: 64 });
    expect(result.mediaDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  /** macOS screenshot names carry U+202F before AM/PM and Finder may hand over NFD accents; the
   *  agent retypes both as plain characters, and an exact lookup then reported "not found". */
  it("finds an attachment whose name differs only in whitespace, Unicode form or case", async () => {
    const macName = "Screenshot 2026-09-22 at 10.15.32 AM.png";
    const source = new Jimp({ width: 10, height: 10, color: 0xffffffff });
    attach(macName, Buffer.from(await source.getBuffer("image/png")));
    attach("Résumé.txt", "cv");

    const typed = await service.dispatch("zoom_image", { name: "Screenshot 2026-09-22 at 10.15.32 AM.png" }, CTX);
    expect(typed).toMatchObject({ ok: true, name: macName });

    const composed = await service.dispatch("read", { name: "résumé.TXT" }, CTX);
    expect(composed).toMatchObject({ ok: true, content: "cv" });

    const attachment = store.listAttachments(CTX.sessionId).find((item) => item.name === macName)!;
    const byPath = await service.dispatch("zoom_image", { name: attachment.path }, CTX);
    expect(byPath).toMatchObject({ ok: true, name: macName });
  });

  it("refuses an ambiguous folded match instead of guessing", async () => {
    // Distinct files on every filesystem (a plain space vs a no-break space) that fold to one key.
    attach("final report.txt", "plain");
    attach("final report.txt", "no-break");
    const exact = await service.dispatch("read", { name: "final report.txt" }, CTX);
    expect(exact).toMatchObject({ ok: true, content: "no-break" });
    const ambiguous = await service.dispatch("read", { name: "FINAL REPORT.txt" }, CTX);
    expect(ambiguous.ok).toBe(false);
  });
});

/** 64×32 solid red, lossy WebP (VP8). */
const WEBP_64X32_RED = "UklGRlAAAABXRUJQVlA4IEQAAABwAwCdASpAACAAPpFIn0ulpCKhpAgAsBIJZwDQRoAAII0kYaAA/u6mP/9x2BuvFv/+5wP+5wP+5wP42wiXYTbpQAAAAA==";

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
