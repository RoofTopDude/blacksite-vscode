// Implements the reference_* tools: agent-facing operations over the files a user has
// attached to a conversation (permanent storage in .blacksite/reference/<sessionId>/,
// owned by ReferenceStore). Kept separate from agent-session.ts (already large) and
// from chat-provider.ts's DI wiring, mirroring how DiffEditService/LspService are
// their own modules rather than inline chat-provider methods.
//
// reference_read / reference_query_spreadsheet / reference_zoom_image extract live
// from disk on every call rather than caching in the embedded database — the SQLite
// ingestion pipeline (core_sources/core_documents) is populated at attach time by the
// webview attach flow, not here; these tools work directly against the files the
// user already attached regardless of whether that ingestion has run.

import * as fs from "fs";
import * as path from "path";
import {
  extractReadableTextFromBytes,
  extractXlsxJsonRows,
  parseCsv,
  delimiterForFileName,
  legacyBinaryOfficeHint,
  readPdfFile,
  visitPdfPages,
  type PdfOutlineEntry,
  type PdfPageText,
} from "@blacksite/file-content";
import { transcodeImageWithMacSips } from "./macos-image.js";
import type { ReferenceAttachment, ReferenceStore } from "./reference-store.js";
import type { DatabaseManager } from "./data/database-manager.js";
import { ExactLocalVectorProvider } from "./data/exact-local-vector-provider.js";
import { referenceCollection } from "./reference-ingestion.js";
import type { EmbeddingService } from "./embedding-service.js";
import { getPdfIndexState } from "./pdf-index.js";
import { resolveWorkspacePath } from "./workspace-paths.js";

const SPREADSHEET_TEXT_EXTENSIONS = new Set(["csv", "tsv", "tab"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "heic", "heif", "tif", "tiff"]);
const PDF_READ_DEFAULT_PAGES = 3;
const PDF_READ_MAX_PAGES = 20;
const PDF_READ_CHAR_BUDGET = 14_000;

/** Optional RAG support — absent for workspaces with no embedded database or no embedding configured. */
export interface ReferenceRagSupport {
  database: DatabaseManager;
  buildEmbeddingService: () => EmbeddingService;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function typeFromAttachment(attachment: ReferenceAttachment, mime?: string): string {
  if (mime?.trim()) return mime;
  const ext = extensionOf(attachment.name);
  return ext ? `.${ext}` : "unknown";
}

function findAttachment(attachments: ReferenceAttachment[], name: string): ReferenceAttachment | undefined {
  return attachments.find((a) => a.name === name);
}

function notFoundError(name: string, attachments: ReferenceAttachment[]): Record<string, unknown> {
  const available = attachments.map((a) => a.name);
  return {
    ok: false,
    error: available.length
      ? `No attachment named '${name}' in this conversation. Available: ${available.join(", ")}`
      : `No attachment named '${name}' in this conversation. No files have been attached yet.`,
  };
}

function flattenOutline(entries: PdfOutlineEntry[], limit = 80): Array<{ title: string; pageNumber?: number; depth: number }> {
  const out: Array<{ title: string; pageNumber?: number; depth: number }> = [];
  const visit = (items: PdfOutlineEntry[], depth: number): void => {
    for (const item of items) {
      if (out.length >= limit) return;
      out.push({ title: item.title, ...(item.pageNumber ? { pageNumber: item.pageNumber } : {}), depth });
      visit(item.children, depth + 1);
    }
  };
  visit(entries, 0);
  return out;
}

function searchSnippet(text: string, query: string, radius = 180): string {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function numericPage(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

interface ReferenceTarget {
  name: string;
  path: string;
  source: "attachment" | "workspace";
  /** Present only for conversation attachments, which may have a background PDF index. */
  attachment?: ReferenceAttachment;
  /** Workspace-relative display path. Never expose a machine-specific absolute path to the agent. */
  workspacePath?: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isReferenceTarget(value: ReferenceTarget | Record<string, unknown>): value is ReferenceTarget {
  return typeof value.name === "string"
    && typeof value.path === "string"
    && (value.source === "attachment" || value.source === "workspace");
}

export class ReferenceToolService {
  constructor(
    private readonly store: ReferenceStore,
    private readonly rag?: ReferenceRagSupport,
    /** Workspace PDF paths are opt-in so stand-alone attachment use keeps its existing boundary. */
    private readonly workspaceRoots: readonly string[] = [],
  ) {}

  async dispatch(op: string, payload: Record<string, unknown>, ctx: { sessionId: string; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    try {
      switch (op) {
        case "list":
          return { ok: true, attachments: this._list(ctx.sessionId) };
        case "context_read":
          return { ok: true, content: this.store.readContextMd(ctx.sessionId) };
        case "context_write": {
          const entry = String(payload["entry"] ?? "").trim();
          if (!entry) return { ok: false, error: "entry is required." };
          this.store.appendContextMd(ctx.sessionId, entry);
          return { ok: true, saved: entry.length > 80 ? `${entry.slice(0, 80)}…` : entry };
        }
        case "read":
          return await this._read(ctx.sessionId, payload, ctx.signal);
        case "query_spreadsheet":
          return await this._querySpreadsheet(ctx.sessionId, payload);
        case "search":
          return await this._search(ctx.sessionId, payload, ctx.signal);
        case "zoom_image":
          return await this._zoomImage(ctx.sessionId, payload);
        case "vector_search":
          return await this._vectorSearch(ctx.sessionId, payload);
        default:
          return { ok: false, error: `Unknown reference operation: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private _list(sessionId: string): Record<string, unknown>[] {
    const attachments = this.store.listAttachments(sessionId);
    return attachments.map((attachment) => {
      const doc = this._documentForAttachment(attachment);
      const ext = extensionOf(attachment.name);
      const mime = doc?.mime;
      const pdfState = ext === "pdf" && doc?.id && this.rag?.database.isOpen
        ? getPdfIndexState(this.rag.database, doc.id)
        : undefined;
      const extractionStatus = ext === "pdf"
        ? (pdfState?.status === "done" ? (pdfState.textPages > 0 ? "extracted" : "no_text") : pdfState?.status ?? "unindexed")
        : doc
          ? (doc.body?.trim() ? "extracted" : (mime?.startsWith("image/") || IMAGE_EXTENSIONS.has(ext) ? "image" : "no_text"))
          : "uncataloged";
      return {
        id: doc?.id ?? attachment.hash,
        name: attachment.name,
        type: typeFromAttachment(attachment, mime ?? undefined),
        size: attachment.byteSize,
        byteSize: attachment.byteSize,
        extractionStatus,
        hash: attachment.hash,
        path: attachment.path,
        ...(ext === "pdf" ? {
          pageCount: pdfState?.totalPages || undefined,
          indexStatus: pdfState?.status ?? "unindexed",
          indexedPages: pdfState?.indexedPages ?? 0,
          textPages: pdfState?.textPages ?? 0,
        } : {}),
      };
    });
  }

  private _documentForAttachment(attachment: ReferenceAttachment): { id: string; mime?: string | null; body?: string | null } | undefined {
    const db = this.rag?.database;
    if (!db?.isOpen) return undefined;
    try {
      return db.get<{ id: string; mime?: string | null; body?: string | null }>(
        `SELECT d.id, d.mime, d.body
         FROM core_documents d
         JOIN core_sources s ON s.id = d.source_id
         WHERE s.uri = ?
         ORDER BY d.created_at DESC
         LIMIT 1`,
        [attachment.path],
      );
    } catch {
      return undefined;
    }
  }

  /** `name` selects a conversation attachment. `path` selects a project PDF and is checked
   *  after resolving symlinks, so this read-only surface cannot follow a workspace link outside
   *  the folders the agent is working in. */
  private _resolvePdfTarget(sessionId: string, payload: Record<string, unknown>): ReferenceTarget | Record<string, unknown> {
    const name = String(payload["name"] ?? "").trim();
    const requestedPath = String(payload["path"] ?? "").trim();
    if (name && requestedPath) return { ok: false, error: "Provide either name (an attachment) or path (a workspace PDF), not both." };
    if (!name && !requestedPath) return { ok: false, error: "name (an attachment) or path (a workspace PDF) is required." };

    if (name) {
      const attachments = this.store.listAttachments(sessionId);
      const attachment = findAttachment(attachments, name);
      if (!attachment) return notFoundError(name, attachments);
      return { name: attachment.name, path: attachment.path, source: "attachment", attachment };
    }

    if (this.workspaceRoots.length === 0) {
      return { ok: false, error: "Workspace PDF paths are unavailable because this session has no workspace root." };
    }
    const candidate = resolveWorkspacePath(requestedPath, [...this.workspaceRoots]);
    if (!candidate) return { ok: false, error: `Workspace PDF path is outside the open workspace: ${requestedPath}` };
    if (extensionOf(candidate) !== "pdf") return { ok: false, error: `'${requestedPath}' is not a PDF. Workspace paths are supported only for PDFs.` };

    try {
      const physical = fs.realpathSync(candidate);
      const containingRoot = this.workspaceRoots.find((root) => {
        try { return isInside(fs.realpathSync(root), physical); } catch { return false; }
      });
      if (!containingRoot) return { ok: false, error: `Workspace PDF path resolves outside the open workspace: ${requestedPath}` };
      if (!fs.statSync(physical).isFile()) return { ok: false, error: `'${requestedPath}' is not a file.` };
      return {
        name: path.basename(physical),
        path: physical,
        source: "workspace",
        workspacePath: path.relative(fs.realpathSync(containingRoot), physical).split(path.sep).join("/"),
      };
    } catch {
      return { ok: false, error: `Workspace PDF not found or unreadable: ${requestedPath}` };
    }
  }

  private async _read(sessionId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const target = this._resolvePdfTarget(sessionId, payload);
    if (!isReferenceTarget(target)) return target;
    if (extensionOf(target.name) === "pdf") return this._readPdf(target, payload, signal);

    // Workspace paths are deliberately PDF-only. Other project files continue to use file_read.
    const bytes = fs.readFileSync(target.path);
    const text = await extractReadableTextFromBytes({
      fileName: target.name,
      mimeType: "application/octet-stream",
      bytes: new Uint8Array(bytes),
    });
    if (text === null) {
      const legacyHint = legacyBinaryOfficeHint(target.name);
      return {
        ok: false,
        error: legacyHint
          ? `'${target.name}' has no extractable text. ${legacyHint}`
          : `'${target.name}' has no extractable text (likely an image or unsupported binary format). Use reference_zoom_image to inspect images directly.`,
      };
    }
    return { ok: true, name: target.name, content: text };
  }

  private async _readPdf(
    target: ReferenceTarget,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const hasExplicitStart = payload["startPage"] !== undefined;
    const hasExplicitEnd = payload["endPage"] !== undefined;
    const startPage = numericPage(payload["startPage"], 1);
    const requestedEnd = hasExplicitEnd
      ? numericPage(payload["endPage"], startPage)
      : hasExplicitStart ? startPage : startPage + PDF_READ_DEFAULT_PAGES - 1;
    if (requestedEnd < startPage) return { ok: false, error: "endPage must be greater than or equal to startPage." };
    if (requestedEnd - startPage + 1 > PDF_READ_MAX_PAGES) {
      return { ok: false, error: `Read at most ${PDF_READ_MAX_PAGES} PDF pages per call.` };
    }

    const doc = target.attachment ? this._documentForAttachment(target.attachment) : undefined;
    const db = this.rag?.database;
    const state = doc?.id && db?.isOpen ? getPdfIndexState(db, doc.id) : undefined;
    let pageCount = state?.totalPages ?? 0;
    if (pageCount > 0 && startPage > pageCount) {
      return { ok: false, error: `startPage ${startPage} is beyond the ${pageCount}-page document.` };
    }
    let endPage = pageCount > 0 ? Math.min(requestedEnd, pageCount) : requestedEnd;
    let pages: PdfPageText[] = [];
    let outline = state?.outline as PdfOutlineEntry[] | undefined;
    let metadata = state?.metadata ?? {};

    if (doc?.id && db?.isOpen) {
      const rows = db.all<{
        page_number: number; page_label: string | null; text: string; width: number; height: number; has_text: number;
      }>(
        `SELECT page_number, page_label, text, width, height, has_text
         FROM core_document_pages
         WHERE document_id = ? AND page_number BETWEEN ? AND ?
         ORDER BY page_number`,
        [doc.id, startPage, endPage],
      );
      if (rows.length === endPage - startPage + 1) {
        pages = rows.map((row) => ({
          pageNumber: row.page_number,
          ...(row.page_label ? { label: row.page_label } : {}),
          text: row.text,
          width: row.width,
          height: row.height,
          hasText: row.has_text === 1,
        }));
      }
    }

    if (pages.length === 0) {
      const live = await readPdfFile(target.path, { startPage, endPage, signal });
      pageCount = live.manifest.pageCount;
      endPage = Math.min(requestedEnd, pageCount);
      pages = live.pages;
      outline = live.manifest.outline;
      metadata = live.manifest.info;
    }

    let remaining = PDF_READ_CHAR_BUDGET;
    const boundedPages: Array<Record<string, unknown>> = [];
    for (const page of pages) {
      if (remaining <= 0) break;
      const content = page.text.slice(0, remaining);
      boundedPages.push({
        pageNumber: page.pageNumber,
        ...(page.label ? { label: page.label } : {}),
        content,
        hasText: page.hasText,
        ...(content.length < page.text.length ? { truncated: true } : {}),
      });
      remaining -= content.length;
    }
    const lastReturned = Number(boundedPages.at(-1)?.["pageNumber"] ?? startPage - 1);
    const hasMore = lastReturned < pageCount;
    return {
      ok: true,
      name: target.name,
      source: target.source,
      ...(target.workspacePath ? { path: target.workspacePath } : {}),
      pageCount,
      range: { startPage, endPage: lastReturned },
      pages: boundedPages,
      outline: flattenOutline(outline ?? []),
      metadata,
      indexStatus: state?.status ?? "live",
      indexedPages: state?.indexedPages ?? 0,
      textPages: state?.textPages ?? pages.filter((page) => page.hasText).length,
      hasMore,
      nextPage: hasMore ? lastReturned + 1 : null,
    };
  }

  private async _search(
    sessionId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const query = String(payload["query"] ?? "").trim();
    if (!query) return { ok: false, error: "query is required." };
    const target = this._resolvePdfTarget(sessionId, payload);
    if (!isReferenceTarget(target)) return target;
    if (extensionOf(target.name) !== "pdf") return { ok: false, error: "reference_search supports PDFs only." };

    const startPage = numericPage(payload["startPage"], 1);
    const endPage = payload["endPage"] === undefined ? Number.MAX_SAFE_INTEGER : numericPage(payload["endPage"], startPage);
    if (endPage < startPage) return { ok: false, error: "endPage must be greater than or equal to startPage." };
    const maxMatches = Math.min(50, Math.max(1, Math.floor(Number(payload["maxMatches"] ?? 20)) || 20));
    const doc = target.attachment ? this._documentForAttachment(target.attachment) : undefined;
    const db = this.rag?.database;
    const state = doc?.id && db?.isOpen ? getPdfIndexState(db, doc.id) : undefined;

    if (doc?.id && db?.isOpen && state && state.indexedPages > 0) {
      const total = db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM core_document_pages
         WHERE document_id = ? AND page_number BETWEEN ? AND ? AND instr(lower(text), lower(?)) > 0`,
        [doc.id, startPage, endPage, query],
      )?.count ?? 0;
      const rows = db.all<{ page_number: number; page_label: string | null; text: string }>(
        `SELECT page_number, page_label, text FROM core_document_pages
         WHERE document_id = ? AND page_number BETWEEN ? AND ? AND instr(lower(text), lower(?)) > 0
         ORDER BY page_number LIMIT ?`,
        [doc.id, startPage, endPage, query, maxMatches],
      );
      return {
        ok: true,
        name: target.name,
        source: target.source,
        ...(target.workspacePath ? { path: target.workspacePath } : {}),
        query,
        totalMatches: total,
        matches: rows.map((row) => ({
          pageNumber: row.page_number,
          ...(row.page_label ? { label: row.page_label } : {}),
          snippet: searchSnippet(row.text, query),
        })),
        truncated: total > rows.length,
        indexStatus: state.status,
        indexedPages: state.indexedPages,
        pageCount: state.totalPages,
        note: state.status === "done" ? undefined : "Results cover the pages indexed so far; indexing is still incomplete.",
      };
    }

    const matches: Array<{ pageNumber: number; label?: string; snippet: string }> = [];
    let totalMatches = 0;
    const manifest = await visitPdfPages(target.path, {
      startPage,
      ...(endPage < Number.MAX_SAFE_INTEGER ? { endPage } : {}),
      signal,
      onPage: (page) => {
        if (!page.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return;
        totalMatches += 1;
        if (matches.length < maxMatches) {
          matches.push({ pageNumber: page.pageNumber, ...(page.label ? { label: page.label } : {}), snippet: searchSnippet(page.text, query) });
        }
      },
    });
    return {
      ok: true,
      name: target.name,
      source: target.source,
      ...(target.workspacePath ? { path: target.workspacePath } : {}),
      query,
      totalMatches,
      matches,
      truncated: totalMatches > matches.length,
      indexStatus: "live",
      indexedPages: 0,
      pageCount: manifest.pageCount,
    };
  }

  private async _querySpreadsheet(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = String(payload["name"] ?? "").trim();
    const filter = String(payload["filter"] ?? "").trim();
    const requestedSheet = typeof payload["sheet"] === "string" ? payload["sheet"] : undefined;
    if (!name) return { ok: false, error: "name is required." };
    if (!filter) return { ok: false, error: "filter (a jq expression) is required." };

    const attachments = this.store.listAttachments(sessionId);
    const attachment = findAttachment(attachments, name);
    if (!attachment) return notFoundError(name, attachments);

    const ext = extensionOf(name);
    const bytes = fs.readFileSync(attachment.path);

    let rows: Record<string, unknown>[];
    let columns: string[];
    let sheetName: string | undefined;

    if (SPREADSHEET_TEXT_EXTENSIONS.has(ext)) {
      const table = parseCsv(bytes.toString("utf8"), { delimiter: delimiterForFileName(name) });
      rows = table.rows;
      columns = table.columns;
    } else if (ext === "xlsx") {
      const sheets = extractXlsxJsonRows(new Uint8Array(bytes));
      if (sheets.length === 0) return { ok: false, error: `Could not parse any sheets from '${name}'.` };
      const target = requestedSheet
        ? sheets.find((s) => s.name.toLowerCase() === requestedSheet.toLowerCase())
        : sheets[0];
      if (!target) {
        return {
          ok: false,
          error: `Sheet '${requestedSheet}' not found in '${name}'. Available sheets: ${sheets.map((s) => s.name).join(", ")}`,
        };
      }
      rows = target.rows;
      columns = target.columns;
      sheetName = target.name;
    } else {
      return { ok: false, error: `'${name}' is not a supported spreadsheet format. Supported: .csv, .tsv, .xlsx.` };
    }

    let result: unknown;
    try {
      // Dynamic import keeps jq-wasm's WASM instantiation out of the activation path — most
      // sessions never call reference_query_spreadsheet.
      const { json: jqJson } = await import("jq-wasm");
      result = await jqJson(rows, filter);
    } catch (err) {
      return { ok: false, error: `Invalid jq filter: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { ok: true, name, sheet: sheetName, columns, rowCount: rows.length, result };
  }

  private async _zoomImage(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = String(payload["name"] ?? "").trim();
    if (!name) return { ok: false, error: "name is required." };
    const attachments = this.store.listAttachments(sessionId);
    const attachment = findAttachment(attachments, name);
    if (!attachment) return notFoundError(name, attachments);

    const bytes = fs.readFileSync(attachment.path);
    let img;
    try {
      const { Jimp } = await import("jimp");
      try {
        img = await Jimp.read(bytes);
      } catch (decodeError) {
        // macOS captures and Photos exports often use HEIC/HEIF/TIFF. They are accepted by the
        // attachment picker but are outside Jimp's portable decoder set, so convert them through
        // ImageIO before doing the same crop/resize operation.
        const converted = await transcodeImageWithMacSips(attachment.path);
        if (!converted) throw decodeError;
        img = await Jimp.read(converted);
      }
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
      return {
        ok: false,
        error: `'${name}' could not be read as an image${detail}. Supported directly: PNG, JPEG, GIF, BMP, and WebP; on macOS, HEIC, HEIF, TIFF, and AVIF are converted through ImageIO.`,
      };
    }

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const x = clamp(Math.trunc(Number(payload["x"] ?? 0)), 0, img.width - 1);
    const y = clamp(Math.trunc(Number(payload["y"] ?? 0)), 0, img.height - 1);
    const w = clamp(Math.trunc(Number(payload["width"] ?? img.width)), 1, img.width - x);
    const h = clamp(Math.trunc(Number(payload["height"] ?? img.height)), 1, img.height - y);

    img.crop({ x, y, w, h });

    const MAX_DIM = 1600;
    const requestedTargetWidth = typeof payload["targetWidth"] === "number" ? payload["targetWidth"] : undefined;
    const requestedTargetHeight = typeof payload["targetHeight"] === "number" ? payload["targetHeight"] : undefined;
    // Default to a 2x upscale of the crop for a genuine "zoom" effect when no explicit
    // target size is given, capped so a tiny crop can't balloon into a huge payload.
    const targetWidth = clamp(requestedTargetWidth ?? w * 2, 1, MAX_DIM);
    const targetHeight = clamp(requestedTargetHeight ?? h * 2, 1, MAX_DIM);
    img.resize({ w: Math.round(targetWidth), h: Math.round(targetHeight) });

    const buffer = await img.getBuffer("image/png");
    const mediaDataUrl = `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
    return {
      ok: true,
      name,
      region: { x, y, width: w, height: h },
      zoomedWidth: img.width,
      zoomedHeight: img.height,
      mediaDataUrl,
      note: "Image data returned for display. Whether the model can directly see it depends on the active model's vision support.",
    };
  }

  /** Semantic search over this conversation's ingested attachment chunks — supplements, never replaces, reference_read. */
  private async _vectorSearch(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.rag) {
      return {
        ok: false,
        error: "Semantic search over attachments isn't available — no embedding model is configured (Settings → Embedding), or this workspace has no local database. Use reference_read for direct access instead.",
      };
    }
    const query = String(payload["query"] ?? "").trim();
    if (!query) return { ok: false, error: "query is required." };
    const requestedName = typeof payload["name"] === "string" ? payload["name"].trim() : "";
    const topK = Math.min(50, Math.max(1, typeof payload["topK"] === "number" ? Math.floor(payload["topK"]) : 10));

    const embedding = this.rag.buildEmbeddingService();
    const vector = await embedding.embed(query);
    const vectors = new ExactLocalVectorProvider(this.rag.database);
    const hits = await vectors.search(vector, {
      topK: requestedName ? Math.min(200, topK * 5) : topK,
      collection: referenceCollection(sessionId),
    });

    if (hits.length === 0) {
      return {
        ok: true,
        hits: [],
        note: "No indexed chunks yet for this conversation's attachments — they're embedded in the background shortly after attaching, or none may be embeddable yet. Use reference_read for guaranteed access.",
      };
    }
    return {
      ok: true,
      hits: hits
        .filter((hit) => !requestedName || String(hit.payload["title"] ?? "") === requestedName)
        .slice(0, topK)
        .map((h) => ({ score: h.score, ...h.payload })),
    };
  }
}
