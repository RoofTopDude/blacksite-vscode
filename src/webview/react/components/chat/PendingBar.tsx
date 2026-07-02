import { useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { actions, useStore } from "@/lib/store";
import { pendingItemsOf } from "@/lib/chat-model";
import { ApprovalButtons } from "./ToolLog";
import { QuestionOptions } from "./QuestionCard";

/**
 * Docked "action needed" bar — always visible above the input box regardless of where
 * the transcript is scrolled, so answering a question or approving a tool never requires
 * hunting through the thread. Mirrors the existing pendingCtx/queuedMessage banner pattern
 * in InputDock. When more than one item is pending (including inside subagent lanes,
 * which are otherwise the most buried case), the oldest is shown expanded with a small
 * "N of M" cycle instead of stacking every item at once.
 */
export function PendingBar() {
  const store = useStore();
  const items = pendingItemsOf(store.chat);
  const [index, setIndex] = useState(0);

  if (items.length === 0) return null;
  const focused = index % items.length;
  const item = items[focused]!;

  return (
    <div className="fade-in rounded-lg border border-primary/30 bg-primary/[0.08] p-2.5 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="pulse-dot" />
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.07em] text-primary">
            {item.kind === "question" ? "Question" : "Approval needed"}
          </span>
          {item.laneLabel && (
            <span className="truncate rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] text-muted-foreground">
              in {item.laneLabel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {items.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setIndex((focused - 1 + items.length) % items.length)}
                className="chat-interactive rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="Previous pending item"
              >
                <ChevronLeft className="size-3" />
              </button>
              <span className="px-0.5 text-[9.5px] tabular-nums text-muted-foreground">{focused + 1} of {items.length}</span>
              <button
                type="button"
                onClick={() => setIndex((focused + 1) % items.length)}
                className="chat-interactive rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="Next pending item"
              >
                <ChevronRight className="size-3" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => actions.revealInThread(item.turnId, item.toolCallId, item.laneId)}
            className="chat-interactive ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground"
            title="Show in thread"
          >
            <ExternalLink className="size-3" />
          </button>
        </div>
      </div>

      <div className="mb-2 text-[12px] font-medium leading-snug text-foreground">{item.title}</div>
      {item.context && (
        <div className="mb-2 whitespace-pre-wrap rounded-md border border-border bg-black/20 p-2 text-[10.5px] leading-snug text-muted-foreground">
          {item.context}
        </div>
      )}

      {item.kind === "question" && item.options ? (
        <QuestionOptions turnId={item.turnId} toolCallId={item.toolCallId} options={item.options} answeredKey={null} />
      ) : (
        <ApprovalButtons turnId={item.turnId} toolCallId={item.toolCallId} binary={item.binary} />
      )}
    </div>
  );
}
