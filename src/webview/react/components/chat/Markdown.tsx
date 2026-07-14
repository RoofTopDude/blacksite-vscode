import { useDeferredValue, useMemo, type MouseEvent } from "react";
import { renderMd } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { actions } from "@/lib/store";

interface MarkdownProps {
  raw: string;
  className?: string;
  /** Keep token streaming cheap; rich Markdown is rendered once the turn settles. */
  streaming?: boolean;
}

const MAX_MARKDOWN_RENDER_CHARS = 250_000;
const RENDER_TRUNCATION = "\n\n[… rich rendering capped at 250,000 characters …]";

/** Renders agent markdown with full rich-content support.
 *
 *  Event delegation handles:
 *  - .cb-copy   → clipboard copy for fenced code blocks
 *  - .file-link → posts open_file to the extension host to jump to the file
 *  - .md-img    → lightbox on click (delegates to the existing lightbox action)
 */
export function Markdown({ raw, className, streaming = false }: MarkdownProps) {
  // Tokens can arrive dozens of times a second. Deferring parse work preserves
  // responsive scrolling and input while still converging immediately once the
  // stream settles.
  const deferredRaw = useDeferredValue(raw);
  // Keep this hook unconditional: changing from streaming=true to false at
  // stream_end must not change the hook order (which would crash React exactly
  // when the final response arrives). Parsing/highlighting is also guarded so a
  // malformed or unusually large final response falls back to readable text.
  const rendered = useMemo(() => {
    if (streaming) return { html: "", failed: false };
    const source = deferredRaw.length > MAX_MARKDOWN_RENDER_CHARS
      ? deferredRaw.slice(0, MAX_MARKDOWN_RENDER_CHARS) + RENDER_TRUNCATION
      : deferredRaw;
    try {
      return { html: renderMd(source), failed: false };
    } catch {
      return { html: "", failed: true };
    }
  }, [deferredRaw, streaming]);

  if (streaming) {
    return (
      <div className={cn("whitespace-pre-wrap", className)}>{deferredRaw}</div>
    );
  }
  if (rendered.failed) {
    return <div className={cn("whitespace-pre-wrap", className)}>{deferredRaw}</div>;
  }

  function onClick(event: MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;

    // Code block copy button
    const copyBtn = target.closest(".cb-copy") as HTMLElement | null;
    if (copyBtn) {
      const code = copyBtn.closest(".cb")?.querySelector("code");
      const text = code?.textContent ?? "";
      navigator.clipboard.writeText(text).then(() => {
        const prev = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = prev; }, 1500);
      }).catch(() => { /* clipboard unavailable */ });
      return;
    }

    // File / line hyperlinks — open in editor
    const fileLink = target.closest(".file-link") as HTMLElement | null;
    if (fileLink) {
      event.preventDefault();
      const filePath = fileLink.dataset.fileOpen ?? "";
      const lineStr  = fileLink.dataset.fileLine ?? "";
      const line     = lineStr ? parseInt(lineStr, 10) : undefined;
      if (filePath) actions.openFile(filePath, line);
      return;
    }

    // Inline images — open in lightbox
    const img = target.closest(".md-img") as HTMLImageElement | null;
    if (img && img.src) {
      actions.openLightbox(img.src, img.alt || "Image");
      return;
    }
  }

  return (
    <div
      className={cn("md", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
