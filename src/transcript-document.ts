/* Conversation-scoped long-form Markdown documents.
 *
 * A transcript document stores the full body with the conversation's permanent
 * attachments under `.blacksite/reference/<sessionId>/`, while the model and UI
 * receive only a small metadata/preview result. That preserves easy access
 * without allowing a large report to bloat the chat transcript or context.
 */

import { ReferenceStore } from "./reference-store.js";

export const TRANSCRIPT_DOCUMENT_SCHEMA = "blacksite.transcript_document.v1";
const MAX_MARKDOWN_CHARS = 220_000;
const MAX_PREVIEW_CHARS = 8_000;
const MAX_OUTLINE_ITEMS = 28;
const MAX_SECTIONS = 48;

export type TranscriptDocumentType =
  | "documentation" | "report" | "runbook" | "readme" | "architecture"
  | "setup_guide" | "user_guide" | "reference" | "analysis" | "general";
export type TranscriptDocumentStatus = "complete" | "partial" | "draft";

export interface TranscriptDocumentInput {
  title?: unknown;
  subtitle?: unknown;
  docType?: unknown;
  status?: unknown;
  summary?: unknown;
  filename?: unknown;
  markdown?: unknown;
  sections?: unknown;
  sources?: unknown;
  warnings?: unknown;
}

export interface TranscriptDocumentOutput {
  schema: typeof TRANSCRIPT_DOCUMENT_SCHEMA;
  renderedInTranscript: true;
  documentId: string;
  title: string;
  subtitle?: string;
  filename: string;
  docType: TranscriptDocumentType;
  status: TranscriptDocumentStatus;
  summary: string;
  sizeChars: number;
  wordCount: number;
  sectionCount: number;
  outline: string[];
  previewMarkdown: string;
  warnings?: string[];
}

interface Section {
  heading: string;
  content: string;
  level: number;
}

const DOC_TYPES = new Set<TranscriptDocumentType>([
  "documentation", "report", "runbook", "readme", "architecture", "setup_guide",
  "user_guide", "reference", "analysis", "general",
]);

function inlineText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function blockText(value: unknown, max = MAX_MARKDOWN_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function normalizedDocType(value: unknown): TranscriptDocumentType {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return DOC_TYPES.has(text as TranscriptDocumentType) ? text as TranscriptDocumentType : "documentation";
}

function normalizedStatus(value: unknown): TranscriptDocumentStatus {
  return value === "partial" || value === "draft" ? value : "complete";
}

function filenameFor(value: unknown, title: string): string {
  const candidate = inlineText(value, 180) ?? `${title}.md`;
  const normalized = candidate.toLowerCase().endsWith(".md") ? candidate : `${candidate}.md`;
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point: they're invalid in filenames
  return normalized.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "transcript-document.md";
}

function normalizeSections(value: unknown): Section[] {
  if (!Array.isArray(value)) return [];
  const sections: Section[] = [];
  for (const item of value.slice(0, MAX_SECTIONS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const heading = inlineText(record.heading, 180);
    const content = blockText(record.content, 30_000);
    if (!heading || !content) continue;
    const rawLevel = typeof record.level === "number" && Number.isFinite(record.level) ? Math.round(record.level) : 2;
    sections.push({ heading, content, level: Math.max(2, Math.min(4, rawLevel)) });
  }
  return sections;
}

function shortStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => inlineText(item, maxChars))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}

function buildMarkdown(input: {
  title: string;
  subtitle?: string;
  summary?: string;
  markdown?: string;
  sections: Section[];
  sources: string[];
}): string {
  if (input.markdown) return input.markdown;
  const parts = [`# ${input.title}`];
  if (input.subtitle) parts.push("", input.subtitle);
  if (input.summary) parts.push("", "## Summary", "", input.summary);
  for (const section of input.sections) {
    parts.push("", `${"#".repeat(section.level)} ${section.heading}`, "", section.content);
  }
  if (input.sources.length) parts.push("", "## Sources", "", ...input.sources.map((source) => `- ${source}`));
  return parts.join("\n").trim();
}

function extractOutline(markdown: string, sections: Section[]): string[] {
  const outline: string[] = [];
  const headings = /^(#{1,4})\s+(.+?)\s*#*\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headings.exec(markdown)) && outline.length < MAX_OUTLINE_ITEMS) {
    const heading = match[2]?.replace(/\s+/g, " ").trim();
    if (heading) outline.push(heading);
  }
  return outline.length ? outline : sections.map((section) => section.heading).slice(0, MAX_OUTLINE_ITEMS);
}

function countWords(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]()|:-]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function inferSummary(value: string | undefined, markdown: string): string {
  if (value) return value;
  const paragraph = markdown
    .split(/\n{2,}/)
    .map((part) => part.replace(/^#+\s+.*$/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!paragraph) return "Markdown document attached to this conversation.";
  return paragraph.length > 420 ? `${paragraph.slice(0, 417).trimEnd()}...` : paragraph;
}

export class TranscriptDocumentService {
  constructor(private readonly store: ReferenceStore) {}

  create(input: TranscriptDocumentInput, sessionId: string): { ok: true; document: TranscriptDocumentOutput } | { ok: false; error: string } {
    const title = inlineText(input.title, 180);
    if (!title) return { ok: false, error: "Document title is required." };
    const sections = normalizeSections(input.sections);
    const markdownInput = blockText(input.markdown);
    if (!markdownInput && sections.length === 0) {
      return { ok: false, error: "Provide either markdown or at least one document section." };
    }

    const subtitle = inlineText(input.subtitle, 220);
    const summaryInput = inlineText(input.summary, 520);
    const sources = shortStringList(input.sources, 24, 260);
    const warnings = shortStringList(input.warnings, 8, 240);
    const markdown = buildMarkdown({ title, subtitle, summary: summaryInput, markdown: markdownInput, sections, sources });
    const attachment = this.store.writeAttachmentBytes(sessionId, filenameFor(input.filename, title), Buffer.from(markdown, "utf8"));
    const output: TranscriptDocumentOutput = {
      schema: TRANSCRIPT_DOCUMENT_SCHEMA,
      renderedInTranscript: true,
      documentId: attachment.name,
      title,
      ...(subtitle ? { subtitle } : {}),
      filename: attachment.name,
      docType: normalizedDocType(input.docType),
      status: normalizedStatus(input.status),
      summary: inferSummary(summaryInput, markdown),
      sizeChars: markdown.length,
      wordCount: countWords(markdown),
      sectionCount: extractOutline(markdown, sections).length,
      outline: extractOutline(markdown, sections),
      previewMarkdown: markdown.slice(0, MAX_PREVIEW_CHARS),
      ...(warnings.length ? { warnings } : {}),
    };
    return { ok: true, document: output };
  }

  read(documentId: string, sessionId: string): { ok: true; markdown: string } | { ok: false; error: string } {
    const markdown = this.store.readAttachmentText(sessionId, documentId);
    return markdown === undefined
      ? { ok: false, error: "Transcript document not found in this conversation." }
      : { ok: true, markdown };
  }
}
