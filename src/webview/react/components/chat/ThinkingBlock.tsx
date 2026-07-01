import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Turn } from "@/lib/chat-model";

export function ThinkingBlock({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(turn.thinkingOpen);
  if (!turn.thinkingRaw) return null;

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-primary/20 bg-primary/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chat-interactive flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/[0.03]"
      >
        {turn.thinkingActive && <span className="pulse-dot" />}
        <span className="flex-1 text-[9px] font-bold uppercase tracking-[0.07em] text-primary">
          {turn.thinkingActive ? "Thinking…" : "Thinking"}
        </span>
        <ChevronRight className={cn("disclosure size-3 text-muted-foreground", open && "rotate-90")} />
      </button>
      {open && (
        <div className="reveal-in border-t border-primary/10 px-2.5 py-2">
          <div className="thinking-text max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-muted-foreground">
            {turn.thinkingRaw}
          </div>
        </div>
      )}
    </div>
  );
}
