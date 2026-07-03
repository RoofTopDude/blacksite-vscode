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
import { extractReadableTextFromBytes, extractXlsxJsonRows, parseCsv, delimiterForFileName } from "@blacksite/file-content";
import { json as jqJson } from "jq-wasm";
import { Jimp } from "jimp";
import type { ReferenceAttachment, ReferenceStore } from "./reference-store.js";
import type { DatabaseManager } from "./data/database-manager.js";
import { ExactLocalVectorProvider } from "./data/exact-local-vector-provider.js";
import { referenceCollection } from "./reference-ingestion.js";
import type { EmbeddingService } from "./embedding-service.js";

const SPREADSHEET_TEXT_EXTENSIONS = new Set(["csv", "tsv", "tab"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp"]);

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

export class ReferenceToolService {
  constructor(
    private readonly store: ReferenceStore,
    private readonly rag?: ReferenceRagSupport,
  ) {}

  async dispatch(op: string, payload: Record<string, unknown>, ctx: { sessionId: string }): Promise<Record<string, unknown>> {
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
          return await this._read(ctx.sessionId, payload);
        case "query_spreadsheet":
          return await this._querySpreadsheet(ctx.sessionId, payload);
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
      const extractionStatus = doc
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

  private async _read(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = String(payload["name"] ?? "").trim();
    if (!name) return { ok: false, error: "name is required." };
    const attachments = this.store.listAttachments(sessionId);
    const attachment = findAttachment(attachments, name);
    if (!attachment) return notFoundError(name, attachments);

    const bytes = fs.readFileSync(attachment.path);
    const text = await extractReadableTextFromBytes({
      fileName: name,
      mimeType: "application/octet-stream",
      bytes: new Uint8Array(bytes),
    });
    if (text === null) {
      return {
        ok: false,
        error: `'${name}' has no extractable text (likely an image or unsupported binary format). Use reference_zoom_image to inspect images directly.`,
      };
    }
    return { ok: true, name, content: text };
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
      img = await Jimp.read(bytes);
    } catch {
      return { ok: false, error: `'${name}' could not be read as an image.` };
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
    const topK = typeof payload["topK"] === "number" ? payload["topK"] : 10;

    const embedding = this.rag.buildEmbeddingService();
    const vector = await embedding.embed(query);
    const vectors = new ExactLocalVectorProvider(this.rag.database);
    const hits = await vectors.search(vector, { topK, collection: referenceCollection(sessionId) });

    if (hits.length === 0) {
      return {
        ok: true,
        hits: [],
        note: "No indexed chunks yet for this conversation's attachments — they're embedded in the background shortly after attaching, or none may be embeddable yet. Use reference_read for guaranteed access.",
      };
    }
    return {
      ok: true,
      hits: hits.map((h) => ({ score: h.score, ...h.payload })),
    };
  }
}
