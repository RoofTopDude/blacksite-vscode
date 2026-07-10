import { useDeferredValue, useMemo, type MouseEvent } from "react";
import { renderMd } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { actions } from "@/lib/store";

interface MarkdownProps {
  raw: string;
  className?: string;
}

/** Renders agent markdown with full rich-content support.
 *
 *  Event delegation handles:
 *  - .cb-copy   → clipboard copy for fenced code blocks
 *  - .file-link → posts open_file to the extension host to jump to the file
 *  - .md-img    → lightbox on click (delegates to the existing lightbox action)
 */
export function Markdown({ raw, className }: MarkdownProps) {
  // Tokens can arrive dozens of times a second. Deferring parse work preserves
  // responsive scrolling and input while still converging immediately once the
  // stream settles.
  const deferredRaw = useDeferredValue(raw);
  const html = useMemo(() => renderMd(deferredRaw), [deferredRaw]);

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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
