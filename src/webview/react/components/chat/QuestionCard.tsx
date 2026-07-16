import { useEffect, useRef, useState } from "react";
import { actions } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { QuestionCard as QCardModel } from "@/lib/chat-model";
import type { QCardOption } from "@/lib/protocol";
import { SandboxPreview } from "./SandboxPreview";

const FADE = 18;

/** Background-agnostic edge fade: masks the scroll container's own opacity rather
 *  than painting a gradient overlay, so it reads correctly against any card tint
 *  (primary-tinted QuestionCard, PendingBar, light/dark theme) with no color to
 *  keep in sync. Only fades an edge that's actually scrolled past, not statically. */
function edgeMask(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined;
  const stops = [
    top ? `transparent 0, black ${FADE}px` : "black 0",
    bottom ? `black calc(100% - ${FADE}px), transparent 100%` : "black 100%",
  ];
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** Tracks whether the option list has more content above/below the current
 *  scroll position, recomputed on scroll and on size changes (e.g. a preview
 *  iframe finishing load and growing the list). */
function useScrollEdges(deps: readonly unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setEdges({ top: scrollTop > 1, bottom: scrollTop + clientHeight < scrollHeight - 1 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, edges };
}

/**
 * Shared option-button list. Used inline here in QuestionCard and, via the same
 * turnId/toolCallId/options props, in the docked PendingBar — one implementation
 * of the answer-selection wiring and preview rendering instead of two.
 */
export function QuestionOptions(
  { turnId, toolCallId, options, answeredKey }: { turnId: string; toolCallId: string; options: QCardOption[]; answeredKey: string | null },
) {
  const answered = answeredKey != null;
  const { ref, edges } = useScrollEdges([options.length]);
  const mask = edgeMask(edges.top, edges.bottom);

  return (
    <div
      ref={ref}
      className="qcard-options-scroll flex max-h-[280px] flex-col gap-1.5 overflow-y-auto pr-0.5"
      style={{ WebkitMaskImage: mask, maskImage: mask }}
    >
      {options.map((option) => {
        const selected = answeredKey === option.key;
        return (
          <div key={option.key}>
            <button
              type="button"
              disabled={answered}
              onClick={() => actions.answerQuestion(turnId, toolCallId, option.key)}
              className={cn(
                "lift w-full rounded-md border border-border bg-white/[0.02] p-2 text-left",
                "hover:border-primary/40 hover:bg-primary/[0.06] disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:shadow-none",
                selected && "border-primary/60 bg-primary/10 shadow-[0_2px_10px_rgba(139,92,246,0.14)]",
                answered && !selected && "opacity-50",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn("text-sm text-primary", selected ? "opacity-100" : "opacity-0")}>✓</span>
                <span className="text-base font-medium text-foreground">{option.label || option.key}</span>
              </div>
              {option.description && (
                <div className="mt-0.5 pl-[18px] text-sm leading-snug text-muted-foreground">{option.description}</div>
              )}
            </button>
            {option.preview?.code ? <SandboxPreview preview={option.preview} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function QuestionCard({ turnId, card }: { turnId: string; card: QCardModel }) {
  const answered = card.answeredKey != null;

  return (
    <div id={`tool-${card.toolCallId}`} className="fade-in rounded-lg border border-primary/25 bg-primary/[0.06] p-2.5 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="pulse-dot" />
          <span className="text-2xs font-bold uppercase tracking-[0.07em] text-primary">Question</span>
        </div>
        {answered && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-semibold text-primary">Answered</span>
        )}
      </div>

      <div className="mb-2 text-base font-medium leading-snug text-foreground">{card.question}</div>
      {card.context && (
        <div className="mb-2 whitespace-pre-wrap rounded-md border border-border bg-black/20 p-2 text-sm leading-snug text-muted-foreground">
          {card.context}
        </div>
      )}

      <QuestionOptions turnId={turnId} toolCallId={card.toolCallId} options={card.options} answeredKey={card.answeredKey} />
    </div>
  );
}
