import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes, shortText } from "@/lib/format";
import { actions, useStore } from "@/lib/store";
import { Markdown } from "./Markdown";

const SCHEMA = "blacksite.transcript_document.v1";

interface TranscriptDocumentResult {
  schema: typeof SCHEMA;
  documentId: string;
  title: string;
  subtitle?: string;
  filename: string;
  docType: string;
  status: string;
  summary: string;
  sizeChars: number;
  wordCount: number;
  sectionCount: number;
  outline: string[];
  previewMarkdown: string;
  warnings?: string[];
}

function parseDocument(raw: unknown): TranscriptDocumentResult | null {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Partial<TranscriptDocumentResult>;
  return doc.schema === SCHEMA && typeof doc.documentId === "string" && typeof doc.title === "string"
    && typeof doc.previewMarkdown === "string" && typeof doc.filename === "string"
    ? doc as TranscriptDocumentResult
    : null;
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A compact artifact card keeps long deliverables out of the transcript until
    requested, while Open always points to its persisted conversation file. */
export function TranscriptDocumentCard({ result }: { result: unknown }) {
  const document = useMemo(() => parseDocument(result), [result]);
  const store = useStore();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const loaded = document ? store.transcriptDocuments[document.documentId] : undefined;
  const markdown = loaded?.markdown ?? document?.previewMarkdown ?? "";
  const hasFullDocument = Boolean(loaded?.markdown) || Boolean(document && document.previewMarkdown.length >= document.sizeChars);

  useEffect(() => {
    if (loading && (loaded?.markdown || loaded?.error)) {
      setLoading(false);
      if (loaded.markdown) setExpanded(true);
    }
  }, [loading, loaded]);

  if (!document) return null;
  const transcript = document;

  function toggleExpanded(): void {
    if (expanded) { setExpanded(false); return; }
    if (hasFullDocument) { setExpanded(true); return; }
    setLoading(true);
    actions.loadTranscriptDocument(transcript.documentId);
  }

  function copyDocument(): void {
    const value = loaded?.markdown ?? transcript.previewMarkdown;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }

  const meta = [
    titleCase(transcript.docType || "document"),
    titleCase(transcript.status || "complete"),
    transcript.wordCount ? `${transcript.wordCount.toLocaleString()} words` : "",
    transcript.sectionCount ? `${transcript.sectionCount} sections` : "",
    formatBytes(transcript.sizeChars),
  ].filter(Boolean).join(" · ");

  return (
    <section className={cn("transcript-document-card", expanded && "transcript-document-expanded")}>
      <div className="flex items-start gap-2">
        <span className="transcript-document-icon"><FileText className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{transcript.title}</div>
          <div className="truncate text-xs text-muted-foreground">{transcript.subtitle || transcript.filename}</div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" className="transcript-document-action" onClick={copyDocument} title="Copy document Markdown">
            {copied ? <Check className="size-3 text-[color:var(--s-ok)]" /> : <Copy className="size-3" />}
          </button>
          <button type="button" className="transcript-document-action" onClick={() => actions.openTranscriptDocument(transcript.documentId)} title="Open persisted Markdown document in VS Code">
            <ExternalLink className="size-3" />
          </button>
          <button type="button" className="transcript-document-action" onClick={toggleExpanded} title={expanded ? "Collapse document" : "Expand document"}>
            <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
          </button>
        </div>
      </div>
      <div className="mt-1 text-2xs text-muted-foreground">{meta}</div>
      {transcript.summary && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{shortText(transcript.summary, 320)}</p>}
      {transcript.outline?.length > 0 && !expanded && (
        <div className="mt-1.5 truncate text-xs text-muted-foreground/80">{transcript.outline.slice(0, 4).join("  ·  ")}</div>
      )}
      {transcript.warnings?.length ? <div className="mt-1.5 text-xs text-[color:var(--s-warn)]">{transcript.warnings.join(" ")}</div> : null}
      {loading && <div className="mt-2 text-xs text-muted-foreground">Loading document…</div>}
      {loaded?.error && <div className="mt-2 text-xs text-[color:var(--s-err)]">{loaded.error}</div>}
      {expanded && (
        <div className="transcript-document-body mt-2">
          <Markdown raw={markdown} />
        </div>
      )}
    </section>
  );
}
