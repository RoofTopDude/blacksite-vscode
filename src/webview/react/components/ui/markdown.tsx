import { useDeferredValue, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { useMarkdown } from "@/lib/use-markdown";

/** Beyond this, rich rendering costs more than it returns; the tail is stated, not dropped. */
const MAX_MARKDOWN_RENDER_CHARS = 250_000;
const RENDER_TRUNCATION = "\n\n[… rich rendering capped at 250,000 characters …]";

export interface MarkdownProps {
  raw: string;
  className?: string;
  /** Keep token streaming cheap; rich Markdown is rendered once the turn settles. */
  streaming?: boolean;
  /**
   * "inline" renders emphasis, code spans, and links with no block structure — for fields
   * the planning store normalizes with `cleanText`, which collapses whitespace and so
   * cannot hold headings, lists, or fences in the first place.
   */
  variant?: "block" | "inline";
  /** "compact" tightens heading, list, and code-block metrics for narrow side panels. */
  density?: "comfortable" | "compact";
  /**
   * Render at most this many characters, followed by a notice naming the full length.
   * Used for plan documents, which run to 50,000 characters and belong in the editor —
   * the panel expansion is a preview and should say so rather than truncating silently.
   */
  previewChars?: number;
  /** Invoked for workspace file links. Omit to leave them inert. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Invoked when an inline image is clicked. Omit to leave images inert. */
  onOpenImage?: (src: string, alt: string) => void;
}

/**
 * Renders Markdown with full rich-content support, decoupled from any one webview's store.
 *
 * Event delegation handles:
 * - .cb-copy   → clipboard copy for fenced code blocks
 * - .file-link → onOpenFile, to jump to a workspace file
 * - .md-img    → onOpenImage, for a lightbox
 *
 * Images that fail to load are replaced with a labelled placeholder (see the effect below).
 */
export function Markdown({
  raw,
  className,
  streaming = false,
  variant = "block",
  density = "comfortable",
  previewChars,
  onOpenFile,
  onOpenImage,
}: MarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Tokens can arrive dozens of times a second. Deferring parse work preserves responsive
  // scrolling and input while still converging immediately once the stream settles.
  const deferredRaw = useDeferredValue(raw);
  // The renderer is a lazily-loaded chunk; until it lands (and if it never does) this
  // component renders plain text. Holding the import back while streaming keeps a chat
  // mount from paying for it before there is settled output to render.
  const md = useMarkdown(!streaming);

  // Keep hooks unconditional: changing streaming=true → false at stream_end must not change
  // hook order (which would crash React exactly when the final response arrives). Parsing is
  // also guarded so a malformed or unusually large body falls back to readable text.
  const rendered = useMemo(() => {
    if (streaming || !md) return { html: "", failed: false, truncated: false, totalChars: 0 };
    try {
      if (variant === "inline") {
        return { html: md.renderMdInline(deferredRaw), failed: false, truncated: false, totalChars: deferredRaw.length };
      }
      const bounded = md.boundMarkdown(deferredRaw, previewChars ?? 0);
      const source = bounded.text.length > MAX_MARKDOWN_RENDER_CHARS
        ? bounded.text.slice(0, MAX_MARKDOWN_RENDER_CHARS) + RENDER_TRUNCATION
        : bounded.text;
      return { html: md.renderMd(source), failed: false, truncated: bounded.truncated, totalChars: bounded.totalChars };
    } catch {
      return { html: "", failed: true, truncated: false, totalChars: 0 };
    }
  }, [deferredRaw, streaming, md, variant, previewChars]);

  /* A workspace-relative image in a plan document cannot load: the panel's webview
     localResourceRoots covers the extension's out/ directory only. Rather than leave a
     broken-image glyph, swap any image that fails to load for a labelled chip that points
     at the editor, where the document's own references resolve normally. */
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !rendered.html) return;
    const images = Array.from(root.querySelectorAll<HTMLImageElement>("img.md-img"));
    if (images.length === 0) return;

    const replace = (image: HTMLImageElement): void => {
      const chip = document.createElement("span");
      chip.className = "md-img-blocked";
      chip.textContent = image.getAttribute("alt")?.trim() || image.getAttribute("src") || "image";
      chip.title = "This image can't be loaded in the panel — open the document in the editor to view it.";
      image.replaceWith(chip);
    };
    const onError = (event: Event): void => replace(event.currentTarget as HTMLImageElement);

    for (const image of images) {
      // A cached failure can precede this effect, in which case no error event is coming.
      if (image.complete && image.naturalWidth === 0) replace(image);
      else image.addEventListener("error", onError);
    }
    return () => {
      for (const image of images) image.removeEventListener("error", onError);
    };
  }, [rendered.html]);

  if (streaming || !md || rendered.failed) {
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
      const lineStr = fileLink.dataset.fileLine ?? "";
      const line = lineStr ? parseInt(lineStr, 10) : undefined;
      if (filePath) onOpenFile?.(filePath, line);
      return;
    }

    // Inline images — open in lightbox
    const img = target.closest(".md-img") as HTMLImageElement | null;
    if (img && img.src) {
      onOpenImage?.(img.src, img.alt || "Image");
      return;
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        className={cn("md", variant === "inline" && "md-inline", density === "compact" && "md-compact", className)}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
      {rendered.truncated && (
        <div className="md-preview-notice">
          Preview of the first {new Intl.NumberFormat().format(previewChars ?? 0)} characters
          {" · "}
          {new Intl.NumberFormat().format(rendered.totalChars)} in the full document — open it in the editor to read it all.
        </div>
      )}
    </>
  );
}
