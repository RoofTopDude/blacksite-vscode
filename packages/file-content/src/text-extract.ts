import { inflateSync, unzipSync } from "fflate";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const XML_BREAK_TAGS = /<\/(?:p|div|tr|li|row|cell|sheetData|table|section|title|h[1-6])\s*>/gi;
const XML_LINE_BREAK_TAGS = /<\s*(?:br|w:br|a:br|m:br)\b[^>]*\/?>/gi;
const XML_TAG_RE = /<[^>]+>/g;

function extensionOf(fileName: string): string {
  const leaf = fileName.split("/").pop()?.toLowerCase() ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1) : "";
}

function lowerMime(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]!.trim();
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function decodeLatin1(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    chunks.push(String.fromCharCode(...slice));
  }
  return chunks.join("");
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export interface PdfTextPageEvidence {
  pageNumber: number;
  text: string;
}

export interface PdfTextExtractionWithProvenance {
  text: string;
  pages: PdfTextPageEvidence[];
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16) || 0));
}

function extractXmlText(xml: string): string {
  const normalized = normalizeText(
    decodeXmlEntities(
      xml
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(XML_BREAK_TAGS, "\n")
        .replace(XML_LINE_BREAK_TAGS, "\n")
        .replace(XML_TAG_RE, " "),
    ),
  );
  return normalized;
}

function isPdf(fileName: string, mimeType: string): boolean {
  return lowerMime(mimeType) === "application/pdf" || extensionOf(fileName) === "pdf";
}

function isOpenXmlOfficeFile(fileName: string, mimeType: string): boolean {
  const ext = extensionOf(fileName);
  const mime = lowerMime(mimeType);
  return ext === "docx"
    || ext === "pptx"
    || ext === "xlsx"
    || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function isOpenDocumentFile(fileName: string, mimeType: string): boolean {
  const ext = extensionOf(fileName);
  const mime = lowerMime(mimeType);
  return ext === "odt"
    || ext === "odp"
    || ext === "ods"
    || mime === "application/vnd.oasis.opendocument.text"
    || mime === "application/vnd.oasis.opendocument.presentation"
    || mime === "application/vnd.oasis.opendocument.spreadsheet";
}

function isZipArchive(fileName: string, mimeType: string): boolean {
  const ext = extensionOf(fileName);
  const mime = lowerMime(mimeType);
  return ext === "zip"
    || ext === "jar"
    || ext === "war"
    || ext === "ear"
    || ext === "apk"
    || ext === "ipa"
    || ext === "epub"
    || mime === "application/zip"
    || mime === "application/x-zip-compressed"
    || mime === "application/java-archive"
    || mime === "application/vnd.android.package-archive"
    || mime === "application/epub+zip";
}

function findXmlFiles(entries: Record<string, Uint8Array>, patterns: RegExp[]): string[] {
  return Object.keys(entries)
    .filter((path) => patterns.some((pattern) => pattern.test(path)))
    .sort((a, b) => a.localeCompare(b));
}

function parseSharedStrings(xml: string): string[] {
  const shared: string[] = [];
  const re = /<si\b[\s\S]*?<\/si>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const block = match[0] ?? "";
    shared.push(extractXmlText(block));
  }
  return shared;
}

/** Parse a worksheet XML's <row>/<c> cells into a row-major grid of cell text. Shared by the flattened-text extractor and xlsx-rows.ts's JSON-rows extractor — the single source of truth for OOXML cell decoding. */
export function parseXlsxSheetCells(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowXml = rowMatch[1] ?? "";
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowXml)) !== null) {
      const attrs = cellMatch[1] ?? "";
      const cellXml = cellMatch[2] ?? "";
      const type = attrs.match(/\bt=["']([^"']+)["']/i)?.[1] ?? "";
      const value = cellXml.match(/<v>([\s\S]*?)<\/v>/i)?.[1] ?? "";
      let text = "";
      if (type === "s") {
        const index = Number.parseInt(value.trim(), 10);
        text = sharedStrings[index] ?? "";
      } else if (type === "inlineStr") {
        text = extractXmlText(cellXml);
      } else if (type === "b") {
        text = value.trim() === "1" ? "TRUE" : "FALSE";
      } else {
        text = decodeXmlEntities(value);
        if (!text) text = extractXmlText(cellXml);
      }
      cells.push(text.replace(/\s+/g, " ").trim());
    }
    rows.push(cells);
  }
  return rows;
}

function extractXlsxSheetText(xml: string, sharedStrings: string[]): string {
  return parseXlsxSheetCells(xml, sharedStrings)
    .map((cells) => cells.join("\t").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function extractOfficeArchiveText(bytes: Uint8Array, fileName: string, mimeType: string): string | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return null;
  }

  const ext = extensionOf(fileName);
  const mime = lowerMime(mimeType);
  const parts: string[] = [];

  if (ext === "xlsx" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mime === "application/vnd.oasis.opendocument.spreadsheet") {
    const sharedXml = entries["xl/sharedStrings.xml"] ? decodeUtf8(entries["xl/sharedStrings.xml"]!) : "";
    const sharedStrings = sharedXml ? parseSharedStrings(sharedXml) : [];
    const sheetPaths = findXmlFiles(entries, [
      /^xl\/worksheets\/sheet\d+\.xml$/i,
      /^content\.xml$/i,
    ]);
    for (const path of sheetPaths) {
      const xml = decodeUtf8(entries[path]!);
      const text = path === "content.xml" ? extractXmlText(xml) : extractXlsxSheetText(xml, sharedStrings);
      if (text) parts.push(text);
    }
    return normalizeText(parts.join("\n\n")) || null;
  }

  const preferredPaths = findXmlFiles(entries, [
    /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i,
    /^ppt\/(slides|notesSlides)\/.*\.xml$/i,
    /^content\.xml$/i,
  ]);

  for (const path of preferredPaths) {
    const xml = decodeUtf8(entries[path]!);
    const text = extractXmlText(xml);
    if (text) parts.push(text);
  }

  if (parts.length > 0) return normalizeText(parts.join("\n\n"));

  const fallbackXml = Object.keys(entries)
    .filter((path) => /\.xml$/i.test(path) && !path.endsWith("/"))
    .sort((a, b) => a.localeCompare(b));
  for (const path of fallbackXml.slice(0, 32)) {
    const text = extractXmlText(decodeUtf8(entries[path]!));
    if (text) parts.push(text);
  }

  return normalizeText(parts.join("\n\n")) || null;
}

function extractZipManifest(bytes: Uint8Array, fileName: string): string | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return null;
  }

  const files = Object.entries(entries)
    .filter(([path]) => path && !path.endsWith("/"))
    .sort(([a], [b]) => a.localeCompare(b));
  if (files.length === 0) return null;

  const lines = [`Archive contents for ${fileName}:`];
  for (const [path, content] of files.slice(0, 200)) {
    lines.push(`- ${path} (${content.length} bytes)`);
  }
  if (files.length > 200) {
    lines.push(`- ...and ${files.length - 200} more files`);
  }
  return lines.join("\n");
}

async function extractPdfTextFromBytes(bytes: Uint8Array): Promise<string> {
  const pdfjsText = await extractPdfTextWithPdfJs(bytes);
  if (pdfjsText) return pdfjsText.text;

  const fallback = extractPdfTextWithRawHeuristics(bytes);
  return fallback?.text ?? "";
}

async function extractPdfTextWithPdfJs(bytes: Uint8Array): Promise<PdfTextExtractionWithProvenance | null> {
  try {
    configurePdfWorker();
    const task = pdfjsLib.getDocument({
      data: bytes,
      stopAtErrors: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    });
    const doc = await task.promise;
    try {
      const pages: PdfTextPageEvidence[] = [];
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        try {
          const textContent = await page.getTextContent();
          const items = Array.isArray(textContent.items)
            ? (textContent.items as Array<Array<{ str?: string }> | { str?: string }>)
            : [];
          const text = items
            .map((item) => ("str" in item ? item.str ?? "" : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) pages.push({ pageNumber, text });
        } finally {
          page.cleanup?.();
        }
      }
      const joined = normalizeText(pages.map((page) => page.text).join("\n\n"));
      return joined ? { text: joined, pages } : null;
    } finally {
      const proxy = doc as unknown as { destroy?: () => Promise<void> | void; cleanup?: () => void };
      if (typeof proxy.destroy === "function") {
        await proxy.destroy();
      } else if (typeof proxy.cleanup === "function") {
        proxy.cleanup();
      }
    }
  } catch {
    return null;
  }
}

function extractPdfTextWithRawHeuristics(bytes: Uint8Array): PdfTextExtractionWithProvenance | null {
  const raw = decodeLatin1(bytes);
  const pages: PdfTextPageEvidence[] = [];
  const streamRe = /stream(?:\r\n|\n|\r)([\s\S]*?)endstream/g;
  let sm: RegExpExecArray | null;

  while ((sm = streamRe.exec(raw)) !== null) {
    const header = raw.slice(Math.max(0, sm.index - 1600), sm.index);
    const streamContent = decodePdfStreamContent(sm[1] ?? "", header);
    const chunks: string[] = [];
    extractTextFromPdfStream(streamContent, chunks);
    const text = normalizeText(chunks.join(" "));
    if (text) pages.push({ pageNumber: pages.length + 1, text });
  }

  if (pages.length === 0) {
    const chunks: string[] = [];
    extractTextFromPdfStream(raw, chunks);
    const text = normalizeText(chunks.join(" "));
    if (text) pages.push({ pageNumber: 1, text });
  }

  return pages.length > 0 ? { text: pages.map((page) => page.text).join("\n\n"), pages } : null;
}

function decodePdfStreamContent(content: string, header: string): string {
  const trimmed = trimPdfStreamBoundary(content);
  const hasFlateFilter = /\/Filter\s*(?:\[\s*)?(?:\/FlateDecode|\/Fl)(?:\s*\])?/i.test(header);
  if (!hasFlateFilter) return trimmed;

  try {
    const inflated = inflateSync(latin1ToBytes(trimmed));
    return decodeLatin1(inflated);
  } catch {
    return trimmed;
  }
}

function trimPdfStreamBoundary(content: string): string {
  if (content.endsWith("\r\n")) return content.slice(0, -2);
  if (content.endsWith("\n") || content.endsWith("\r")) return content.slice(0, -1);
  return content;
}

function extractTextFromPdfStream(content: string, out: string[]): void {
  const btRe = /BT\s*([\s\S]*?)ET/g;
  let bm: RegExpExecArray | null;

  while ((bm = btRe.exec(content)) !== null) {
    const block = bm[1] ?? "";

    const tjRe = /(\((?:\\.|[^\\()])*\)|<[\da-fA-F\s]+>)\s*Tj/g;
    let tm: RegExpExecArray | null;
    while ((tm = tjRe.exec(block)) !== null) {
      const decoded = decodePdfStringToken(tm[1] ?? "");
      if (decoded.trim()) out.push(decoded);
    }

    const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
    let am: RegExpExecArray | null;
    while ((am = tjArrRe.exec(block)) !== null) {
      const arr = am[1] ?? "";
      const strRe = /\((?:\\.|[^\\()])*\)|<[\da-fA-F\s]+>/g;
      let sm: RegExpExecArray | null;
      const parts: string[] = [];
      while ((sm = strRe.exec(arr)) !== null) {
        parts.push(decodePdfStringToken(sm[0] ?? ""));
      }
      const joined = parts.join("");
      if (joined.trim()) out.push(joined);
    }

    const quoteRe = /(\((?:\\.|[^\\()])*\)|<[\da-fA-F\s]+>)\s*['"]/g;
    let qm: RegExpExecArray | null;
    while ((qm = quoteRe.exec(block)) !== null) {
      const decoded = decodePdfStringToken(qm[1] ?? "");
      if (decoded.trim()) out.push(decoded);
    }
  }
}

function decodePdfStringToken(token: string): string {
  if (token.startsWith("(") && token.endsWith(")")) {
    return decodePdfString(token.slice(1, -1));
  }
  if (token.startsWith("<") && token.endsWith(">") && !token.startsWith("<<")) {
    return decodePdfHexString(token.slice(1, -1));
  }
  return "";
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\\/g, "\\")
    .replace(/\\([()])/g, "$1")
    .replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function decodePdfHexString(hex: string): string {
  const normalized = hex.replace(/\s+/g, "");
  if (normalized.length < 2) return "";
  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return text;
  }
  return decodeLatin1(new Uint8Array(bytes));
}

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

let pdfWorkerConfigured = false;

function configurePdfWorker(): void {
  if (pdfWorkerConfigured) return;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
  } catch {
    // Best effort; the extractor still has a heuristic fallback below.
  }
  pdfWorkerConfigured = true;
}

export async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
  return extractPdfTextFromBytes(new Uint8Array(buffer));
}

export async function extractPdfTextWithProvenance(buffer: ArrayBuffer): Promise<PdfTextExtractionWithProvenance | null> {
  const pdfjsText = await extractPdfTextWithPdfJs(new Uint8Array(buffer));
  if (pdfjsText) return pdfjsText;
  return extractPdfTextWithRawHeuristics(new Uint8Array(buffer));
}

export async function extractReadableTextFromBytes(input: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<string | null> {
  const mime = lowerMime(input.mimeType);
  const ext = extensionOf(input.fileName);

  if (mime.startsWith("text/")
    || mime === "application/json"
    || mime === "application/xml"
    || mime === "application/xhtml+xml"
    || mime === "application/javascript"
    || mime === "application/typescript"
    || mime === "application/x-yaml"
    || mime === "application/yaml"
    || mime === "application/sql"
    || mime === "application/csv"
    || mime === "application/ld+json"
    || ["txt", "md", "markdown", "csv", "tsv", "tab", "json", "xml", "html", "htm", "css", "yml", "yaml", "toml", "ini", "log", "sql", "svg", "mjs", "cjs", "js", "ts", "jsx", "tsx"].includes(ext)) {
    return normalizeText(decodeUtf8(input.bytes));
  }

  if (isPdf(input.fileName, input.mimeType)) {
    return extractPdfTextFromBytes(input.bytes) || null;
  }

  if (isOpenXmlOfficeFile(input.fileName, input.mimeType) || isOpenDocumentFile(input.fileName, input.mimeType)) {
    return extractOfficeArchiveText(input.bytes, input.fileName, input.mimeType);
  }

  if (isZipArchive(input.fileName, input.mimeType)) {
    return extractZipManifest(input.bytes, input.fileName);
  }

  return null;
}

export { parseSharedStrings, extensionOf, lowerMime, normalizeText, decodeUtf8 };
