import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffPreview } from "@/lib/protocol";

/**
 * What an edit approval would change, shown in the card that asks. The first file is open; the
 * rest are one line each. The editor diffs the host opens stay the full review — this is enough to
 * decide on a routine change without leaving the chat.
 */
export function ApprovalDiffs({ previews }: { previews: DiffPreview[] }) {
  if (!previews.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-1" aria-label="Proposed changes">
      {previews.map((preview, index) => <FileDiff key={preview.path} preview={preview} initiallyOpen={index === 0} />)}
    </div>
  );
}

function FileDiff({ preview, initiallyOpen }: { preview: DiffPreview; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-black/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="chat-interactive flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/[0.04]"
        title={open ? "Hide this file's changes" : "Show this file's changes"}
      >
        <ChevronRight className={cn("disclosure size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{preview.path}</span>
        {preview.created && <span className="text-2xs text-muted-foreground">new</span>}
        {preview.deleted && <span className="text-2xs text-muted-foreground">deleted</span>}
        <span className="shrink-0 font-mono text-2xs">
          <span style={{ color: "var(--s-ok)" }}>+{preview.additions}</span>{" "}
          <span style={{ color: "var(--s-err)" }}>−{preview.deletions}</span>
        </span>
      </button>
      {open && (
        <pre className="approval-diff">
          {preview.lines.map((line, index) => (
            <span key={index} className="approval-diff-line" data-kind={line.kind}>
              <span className="approval-diff-mark" aria-hidden>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "skip" ? "⋯" : " "}</span>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
