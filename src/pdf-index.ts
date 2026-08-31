import * as crypto from "node:crypto";
import { visitPdfPages, type PdfManifest, type PdfPageText } from "@blacksite/file-content";
import type { DatabaseManager } from "./data/database-manager.js";

export const PDF_EXTRACTOR_VERSION = 1;
const WRITE_BATCH_SIZE = 8;

export interface PdfIndexState {
  documentId: string;
  status: string;
  totalPages: number;
  indexedPages: number;
  textPages: number;
  outline: unknown[];
  metadata: Record<string, unknown>;
  error?: string;
}

export interface PdfIndexResult {
  ok: boolean;
  totalPages: number;
  indexedPages: number;
  textPages: number;
  error?: string;
}

interface PdfIndexRow extends Record<string, unknown> {
  document_id: string;
  status: string;
  total_pages: number;
  indexed_pages: number;
  text_pages: number;
  outline: string | null;
  metadata: string | null;
  error: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function getPdfIndexState(db: DatabaseManager, documentId: string): PdfIndexState | undefined {
  const row = db.get<PdfIndexRow>(
    `SELECT document_id, status, total_pages, indexed_pages, text_pages, outline, metadata, error
     FROM core_pdf_indexes WHERE document_id = ?`,
    [documentId],
  );
  if (!row) return undefined;
  return {
    documentId: row.document_id,
    status: row.status,
    totalPages: row.total_pages,
    indexedPages: row.indexed_pages,
    textPages: row.text_pages,
    outline: parseJson<unknown[]>(row.outline, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

async function writePageBatch(
  db: DatabaseManager,
  documentId: string,
  pages: PdfPageText[],
  manifest: PdfManifest,
  jobId: string,
): Promise<void> {
  if (pages.length === 0) return;
  await db.enqueueWrite((driver) => {
    driver.transaction(() => {
      for (const page of pages) {
        driver.run(
          `INSERT INTO core_document_pages
             (document_id, page_number, page_label, text, char_count, has_text, width, height, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(document_id, page_number) DO UPDATE SET
             page_label = excluded.page_label,
             text = excluded.text,
             char_count = excluded.char_count,
             has_text = excluded.has_text,
             width = excluded.width,
             height = excluded.height,
             updated_at = datetime('now')`,
          [documentId, page.pageNumber, page.label ?? null, page.text, page.text.length, page.hasText ? 1 : 0, page.width, page.height],
        );
      }
      const counts = driver.get<{ indexed_pages: number; text_pages: number }>(
        `SELECT COUNT(*) AS indexed_pages, COALESCE(SUM(has_text), 0) AS text_pages
         FROM core_document_pages WHERE document_id = ?`,
        [documentId],
      )!;
      driver.run(
        `UPDATE core_pdf_indexes
         SET total_pages = ?, indexed_pages = ?, text_pages = ?, outline = ?, metadata = ?, updated_at = datetime('now')
         WHERE document_id = ?`,
        [manifest.pageCount, counts.indexed_pages, counts.text_pages, JSON.stringify(manifest.outline), JSON.stringify(manifest.info), documentId],
      );
      driver.run(
        "UPDATE core_jobs SET total = ?, completed = ?, progress = ?, updated_at = datetime('now') WHERE id = ?",
        [manifest.pageCount, counts.indexed_pages, manifest.pageCount > 0 ? counts.indexed_pages / manifest.pageCount : 1, jobId],
      );
    });
  });
}

/** Extract and persist PDF pages incrementally so long documents become searchable before completion. */
export async function indexPdfDocument(
  db: DatabaseManager,
  input: { documentId: string; title: string; filePath: string; signal?: AbortSignal },
): Promise<PdfIndexResult> {
  const jobId = crypto.randomUUID();
  await db.enqueueWrite((driver) => {
    driver.transaction(() => {
      driver.run("DELETE FROM core_document_pages WHERE document_id = ?", [input.documentId]);
      driver.run(
        `INSERT INTO core_pdf_indexes (document_id, extractor_version, status, total_pages, indexed_pages, text_pages, error, updated_at, finished_at)
         VALUES (?, ?, 'running', 0, 0, 0, NULL, datetime('now'), NULL)
         ON CONFLICT(document_id) DO UPDATE SET
           extractor_version = excluded.extractor_version,
           status = 'running', total_pages = 0, indexed_pages = 0, text_pages = 0,
           outline = NULL, metadata = NULL, error = NULL, updated_at = datetime('now'), finished_at = NULL`,
        [input.documentId, PDF_EXTRACTOR_VERSION],
      );
      driver.run(
        "INSERT INTO core_jobs (id, kind, status, total, payload, started_at) VALUES (?, 'pdf_index', 'running', 0, ?, datetime('now'))",
        [jobId, JSON.stringify({ documentId: input.documentId, title: input.title })],
      );
    });
  });

  let manifest: PdfManifest | undefined;
  let batch: PdfPageText[] = [];
  try {
    manifest = await visitPdfPages(input.filePath, {
      signal: input.signal,
      onPage: async (page, currentManifest) => {
        manifest = currentManifest;
        batch.push(page);
        if (batch.length < WRITE_BATCH_SIZE) return;
        const ready = batch;
        batch = [];
        await writePageBatch(db, input.documentId, ready, currentManifest, jobId);
      },
    });
    await writePageBatch(db, input.documentId, batch, manifest, jobId);
    const state = getPdfIndexState(db, input.documentId);
    const indexedPages = state?.indexedPages ?? 0;
    const textPages = state?.textPages ?? 0;
    await db.enqueueWrite((driver) => {
      driver.run(
        "UPDATE core_pdf_indexes SET status = 'done', updated_at = datetime('now'), finished_at = datetime('now') WHERE document_id = ?",
        [input.documentId],
      );
      driver.run(
        "UPDATE core_jobs SET status = 'done', completed = ?, total = ?, progress = 1, finished_at = datetime('now') WHERE id = ?",
        [indexedPages, manifest!.pageCount, jobId],
      );
    });
    return { ok: true, totalPages: manifest.pageCount, indexedPages, textPages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = input.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    if (manifest && batch.length > 0) {
      await writePageBatch(db, input.documentId, batch, manifest, jobId).catch(() => undefined);
    }
    const state = getPdfIndexState(db, input.documentId);
    await db.enqueueWrite((driver) => {
      driver.run(
        "UPDATE core_pdf_indexes SET status = ?, error = ?, updated_at = datetime('now'), finished_at = datetime('now') WHERE document_id = ?",
        [cancelled ? "cancelled" : "failed", message, input.documentId],
      );
      driver.run(
        "UPDATE core_jobs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?",
        [cancelled ? "cancelled" : "failed", message, jobId],
      );
    }).catch(() => undefined);
    return {
      ok: false,
      totalPages: manifest?.pageCount ?? state?.totalPages ?? 0,
      indexedPages: state?.indexedPages ?? 0,
      textPages: state?.textPages ?? 0,
      error: message,
    };
  }
}
