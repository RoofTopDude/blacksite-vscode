import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfOutlineEntry {
  title: string;
  pageNumber?: number;
  children: PdfOutlineEntry[];
}

export interface PdfManifest {
  pageCount: number;
  pageLabels: Array<string | null>;
  outline: PdfOutlineEntry[];
  info: Record<string, unknown>;
}

export interface PdfPageText {
  pageNumber: number;
  label?: string;
  text: string;
  width: number;
  height: number;
  hasText: boolean;
}

export interface PdfReadResult {
  manifest: PdfManifest;
  pages: PdfPageText[];
}

export interface PdfPageRange {
  startPage?: number;
  endPage?: number;
  signal?: AbortSignal;
}

let pdfWorkerConfigured = false;

function configurePdfWorker(): void {
  if (pdfWorkerConfigured) return;
  try {
    const adjacent = typeof __dirname === "string" ? join(__dirname, "pdf.worker.mjs") : "";
    const workerPath = adjacent && existsSync(adjacent)
      ? adjacent
      : createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();
  } catch {
    // PDF.js can still use its Node fake-worker path when this URL cannot be resolved.
  }
  pdfWorkerConfigured = true;
}

function abortError(): Error {
  const error = new Error("PDF operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function normalizePageText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function plainMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["string", "number", "boolean"].includes(typeof item) || item === null) out[key] = item;
  }
  return out;
}

type PdfDocumentLike = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

async function resolveDestinationPage(doc: PdfDocumentLike, destination: unknown): Promise<number | undefined> {
  let resolved = destination;
  if (typeof resolved === "string") resolved = await doc.getDestination(resolved);
  if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
  const target = resolved[0];
  if (typeof target === "number" && Number.isInteger(target)) return target + 1;
  if (!target || typeof target !== "object") return undefined;
  try {
    return (await doc.getPageIndex(target as never)) + 1;
  } catch {
    return undefined;
  }
}

async function resolveOutline(doc: PdfDocumentLike, raw: unknown): Promise<PdfOutlineEntry[]> {
  if (!Array.isArray(raw)) return [];
  const entries: PdfOutlineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = String(record["title"] ?? "").trim();
    if (!title) continue;
    const pageNumber = await resolveDestinationPage(doc, record["dest"]);
    entries.push({
      title,
      ...(pageNumber ? { pageNumber } : {}),
      children: await resolveOutline(doc, record["items"]),
    });
  }
  return entries;
}

async function buildManifest(doc: PdfDocumentLike): Promise<PdfManifest> {
  const [labels, outline, metadata] = await Promise.all([
    doc.getPageLabels().catch(() => null),
    doc.getOutline().catch(() => null),
    doc.getMetadata().catch(() => null),
  ]);
  const pageLabels = Array.from({ length: doc.numPages }, (_, index) => labels?.[index] ?? null);
  return {
    pageCount: doc.numPages,
    pageLabels,
    outline: await resolveOutline(doc, outline),
    info: plainMetadata(metadata?.info),
  };
}

async function loadPdf<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  operation: (doc: PdfDocumentLike) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  configurePdfWorker();
  const task = pdfjsLib.getDocument({
    url: pathToFileURL(filePath),
    stopAtErrors: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
  });
  const onAbort = (): void => { void task.destroy(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const doc = await task.promise;
    throwIfAborted(signal);
    return await operation(doc);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await task.destroy().catch(() => undefined);
  }
}

async function extractPage(doc: PdfDocumentLike, pageNumber: number, label?: string | null): Promise<PdfPageText> {
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const parts: string[] = [];
    for (const item of textContent.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (!item || typeof item.str !== "string") continue;
      parts.push(item.str);
      parts.push(item.hasEOL ? "\n" : " ");
    }
    const text = normalizePageText(parts.join(""));
    return {
      pageNumber,
      ...(label ? { label } : {}),
      text,
      width: viewport.width,
      height: viewport.height,
      hasText: text.length > 0,
    };
  } finally {
    page.cleanup?.();
  }
}

/** Inspect metadata and structure without extracting every page's text. */
export async function inspectPdfFile(filePath: string, signal?: AbortSignal): Promise<PdfManifest> {
  return loadPdf(filePath, signal, buildManifest);
}

/** Read an explicit page range while opening the underlying PDF only once. */
export async function readPdfFile(filePath: string, range: PdfPageRange = {}): Promise<PdfReadResult> {
  return loadPdf(filePath, range.signal, async (doc) => {
    const manifest = await buildManifest(doc);
    const startPage = Math.max(1, Math.min(Math.floor(range.startPage ?? 1), manifest.pageCount));
    const endPage = Math.max(startPage, Math.min(Math.floor(range.endPage ?? startPage), manifest.pageCount));
    const pages: PdfPageText[] = [];
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      throwIfAborted(range.signal);
      pages.push(await extractPage(doc, pageNumber, manifest.pageLabels[pageNumber - 1]));
    }
    return { manifest, pages };
  });
}

/** Walk pages with one PDF.js document open, allowing callers to persist bounded batches. */
export async function visitPdfPages(
  filePath: string,
  options: PdfPageRange & { onPage: (page: PdfPageText, manifest: PdfManifest) => Promise<void> | void },
): Promise<PdfManifest> {
  return loadPdf(filePath, options.signal, async (doc) => {
    const manifest = await buildManifest(doc);
    const startPage = Math.max(1, Math.min(Math.floor(options.startPage ?? 1), manifest.pageCount));
    const endPage = Math.max(startPage, Math.min(Math.floor(options.endPage ?? manifest.pageCount), manifest.pageCount));
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await extractPage(doc, pageNumber, manifest.pageLabels[pageNumber - 1]);
      await options.onPage(page, manifest);
    }
    return manifest;
  });
}
