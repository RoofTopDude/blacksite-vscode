import { useMemo, type MouseEvent } from "react";
import { renderMd } from "@/lib/markdown";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  raw: string;
  className?: string;
}

/** Renders the legacy markdown HTML. Code-copy buttons are wired via event
 *  delegation (the renderer emits `.cb-copy` buttons without inline onclick). */
export function Markdown({ raw, className }: MarkdownProps) {
  const html = useMemo(() => renderMd(raw), [raw]);

  function onClick(event: MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    const copyBtn = target.closest(".cb-copy") as HTMLElement | null;
    if (!copyBtn) return;
    const block = copyBtn.closest(".cb");
    const code = block?.querySelector("code");
    const text = code?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => {
      const prev = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = prev; }, 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }

  return (
    <div
      className={cn("md", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
