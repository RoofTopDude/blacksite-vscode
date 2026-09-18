/*
  Attachment classification and decoding: MIME lookup by extension, the size ceilings the
  chat input enforces, PNG dimension probing, and image decode with HEIC/macOS-sips fallbacks.

  Extracted from chat-provider.ts, which re-exports the symbols its own callers and specs
  already import from there. Everything here is provider-agnostic and free of webview state.
*/
import { transcodeImageWithMacSips } from "../macos-image.js";
import { decodeHeicImage } from "../heic-image.js";

export type AttachmentKind = "image" | "audio" | "video" | "document" | "code" | "data" | "archive" | "other";

export const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  epub: "application/epub+zip",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  ts: "text/typescript",
  jsx: "text/jsx",
  tsx: "text/tsx",
  py: "text/x-python",
  java: "text/x-java-source",
  c: "text/x-c",
  cpp: "text/x-c++",
  h: "text/x-c",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  go: "text/x-go",
  rs: "text/x-rust",
  php: "text/x-php",
  rb: "text/x-ruby",
  sh: "application/x-sh",
  sql: "application/sql",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  wma: "audio/x-ms-wma",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
};

export const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "rtf", "odt", "ppt", "pptx", "odp", "epub", "txt", "md", "log", "html", "htm"]);
export const CODE_EXTENSIONS = new Set(["js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php", "rb", "sh", "sql"]);
export const DATA_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods", "json", "jsonl", "yaml", "yml", "xml"]);
export const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "7z", "rar"]);
export const MAX_FILE_ATTACHMENT_BYTES = 256 * 1024 * 1024;
export const MAX_PASTED_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_PASTED_ATTACHMENT_FILES = 12;
export const MAX_PASTED_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_TRANSCRIPT_CHARS = 80_000;

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read declared width/height straight out of a PNG's IHDR chunk without decoding any pixel
 * data — IHDR is always the first chunk, at a fixed offset right after the signature, so this
 * needs no parsing library. Returns null for anything that isn't a well-formed PNG header
 * (including other formats); those fall through to the post-decode size checks that already
 * exist, a smaller safety net but non-PNG images are a minority of screenshot attachments.
 */
export function probePngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Decode through Jimp first, then the cross-platform libheif bridge for HEIC/HEIF (works on
 * every OS), then macOS ImageIO as a last resort for whatever both of those still decline.
 * This closes the gap where the picker accepted a Photos screenshot/export but the model
 * received only an error note instead of image pixels — previously true on every platform
 * except macOS, since only macOS had a fallback decoder at all. */
export async function decodeAttachmentImage(bytes: Buffer, sourcePath: string) {
  const { Jimp } = await import("jimp");
  try {
    return await Jimp.read(bytes);
  } catch (decodeError) {
    const heic = await decodeHeicImage(bytes);
    if (heic) return Jimp.fromBitmap(heic);
    const converted = await transcodeImageWithMacSips(sourcePath);
    if (!converted) throw decodeError;
    return Jimp.read(converted);
  }
}

/** Best-effort mime lookup by extension — attachments arriving via a native file picker have no browser-supplied File.type. */
export function guessMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export function extensionOf(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

/** Categorize for a clear UI and the media pipeline. Unsupported formats deliberately fall back
 * to `other`: files are still stored and available to the agent's reference tools. */
export function classifyAttachment(fileName: string, mimeType?: string): AttachmentKind {
  const mime = (mimeType ?? guessMimeType(fileName)).toLowerCase();
  const ext = extensionOf(fileName);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (DOCUMENT_EXTENSIONS.has(ext) || mime === "application/pdf" || mime.startsWith("application/msword") || mime.includes("officedocument") || mime.includes("opendocument")) return "document";
  if (CODE_EXTENSIONS.has(ext) || mime.startsWith("text/x-") || mime === "text/typescript" || mime === "text/jsx" || mime === "text/tsx") return "code";
  if (DATA_EXTENSIONS.has(ext) || mime.includes("json") || mime.includes("yaml") || mime.includes("xml") || mime === "application/sql") return "data";
  if (ARCHIVE_EXTENSIONS.has(ext) || mime.includes("zip") || mime.includes("compressed") || mime.includes("archive")) return "archive";
  return "other";
}
