import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { actions } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { QuestionCard as QCardModel, QuestionItem } from "@/lib/chat-model";
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
 * One question within a set. Unanswered, it's always expanded (question + context +
 * options) — you can't collapse something that still needs an answer. The moment it's
 * answered it auto-collapses to a single slim row (checkmark, question, selected
 * label(s)); clicking that row re-expands it to show the original question and options
 * again, with the selected one(s) highlighted and the rest dimmed/disabled.
 */
function QuestionRow(
  { turnId, toolCallId, index, item }: { turnId: string; toolCallId: string; index: number; item: QuestionItem },
) {
  const answered = item.answeredKeys != null;
  const [expanded, setExpanded] = useState(!answered);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(item.answeredKeys ?? []));
  const { ref, edges } = useScrollEdges([item.options.length]);
  const mask = edgeMask(edges.top, edges.bottom);

  // Collapse the instant an answer lands — this is the actual "collapse after being
  // answered" behavior, not just an initial-mount default.
  useEffect(() => {
    if (answered) setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);

  function toggleChecked(key: string): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const selectedLabels = answered
    ? item.options.filter((o) => item.answeredKeys!.includes(o.key)).map((o) => o.label || o.key).join(", ")
    : "";

  const header = (
    <div className="flex items-center gap-1.5">
      {answered && <Check className="size-3 shrink-0" style={{ color: "var(--s-ok)" }} />}
      <span className={cn("min-w-0 flex-1 text-sm font-medium leading-snug text-foreground", !expanded && "truncate")}>
        {item.question}
      </span>
      {answered && !expanded && (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{selectedLabels}</span>
      )}
      {answered && (
        <ChevronRight className={cn("disclosure size-3 shrink-0 text-muted-foreground", expanded && "rotate-90")} />
      )}
    </div>
  );

  return (
    <div className={cn(answered && !expanded && "chat-interactive rounded-md px-2 py-1 hover:bg-white/[0.03]")}>
      {answered ? (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="chat-interactive w-full text-left">
          {header}
        </button>
      ) : header}

      {expanded && (
        <div className={cn(answered && "reveal-in mt-1.5")}>
          {item.context && (
            <div className="mb-1.5 whitespace-pre-wrap rounded-md border border-border bg-black/20 p-1.5 text-xs leading-snug text-muted-foreground">
              {item.context}
            </div>
          )}
          <div
            ref={ref}
            className="qcard-options-scroll flex max-h-[280px] flex-col gap-1 overflow-y-auto pr-0.5"
            style={{ WebkitMaskImage: mask, maskImage: mask }}
          >
            {item.options.map((option) => {
              const selected = item.multiSelect ? checked.has(option.key) : item.answeredKeys?.[0] === option.key;
              return (
                <div key={option.key}>
                  <button
                    type="button"
                    disabled={answered}
                    onClick={() => (item.multiSelect
                      ? toggleChecked(option.key)
                      : actions.answerQuestion(turnId, toolCallId, index, [option.key]))}
                    className={cn(
                      "lift w-full rounded-md border border-border bg-white/[0.02] px-2 py-1.5 text-left",
                      "hover:border-primary/40 hover:bg-primary/[0.06] disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:shadow-none",
                      selected && "border-primary/60 bg-primary/10 shadow-[0_2px_10px_rgba(139,92,246,0.14)]",
                      answered && !selected && "opacity-50",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {item.multiSelect ? (
                        <span className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                          selected ? "border-primary bg-primary" : "border-border",
                        )}
                        >
                          {selected && <Check className="size-2.5 text-white" />}
                        </span>
                      ) : (
                        <span className={cn("text-sm text-primary", selected ? "opacity-100" : "opacity-0")}>✓</span>
                      )}
                      <span className="text-sm font-medium text-foreground">{option.label || option.key}</span>
                    </div>
                    {option.description && (
                      <div className="mt-0.5 pl-[18px] text-xs leading-snug text-muted-foreground">{option.description}</div>
                    )}
                  </button>
                  {option.preview?.code ? <SandboxPreview preview={option.preview} label={option.label || option.key} /> : null}
                </div>
              );
            })}
          </div>
          {item.multiSelect && !answered && (
            <div className="mt-1.5">
              <Button
                type="button"
                size="xs"
                disabled={checked.size === 0}
                onClick={() => actions.answerQuestion(turnId, toolCallId, index, [...checked])}
              >
                Submit
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shared body for a set of one or more questions. Used both here in QuestionCard (the
 * thread) and, via the same turnId/toolCallId/items props, in the docked PendingBar —
 * one implementation of the answer-selection wiring instead of two.
 */
export function QuestionSetBody(
  { turnId, toolCallId, items }: { turnId: string; toolCallId: string; items: QuestionItem[] },
) {
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((item, i) => (
        <QuestionRow key={i} turnId={turnId} toolCallId={toolCallId} index={i} item={item} />
      ))}
    </div>
  );
}

export function QuestionCard({ turnId, card }: { turnId: string; card: QCardModel }) {
  const allAnswered = card.items.every((i) => i.answeredKeys != null);
  const multi = card.items.length > 1;

  return (
    <div id={`tool-${card.toolCallId}`} className="fade-in rounded-lg border border-primary/25 bg-primary/[0.06] p-2 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="pulse-dot" />
          <span className="text-2xs font-bold uppercase tracking-[0.07em] text-primary">
            {multi ? `Questions (${card.items.length})` : "Question"}
          </span>
        </div>
        {allAnswered && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-semibold text-primary">Answered</span>
        )}
      </div>

      <QuestionSetBody turnId={turnId} toolCallId={card.toolCallId} items={card.items} />
    </div>
  );
}
