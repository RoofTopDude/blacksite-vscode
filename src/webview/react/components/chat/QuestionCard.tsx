import { useEffect, useRef, useState } from "react";
import { Ban, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { actions } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { QuestionCard as QCardModel, QuestionItem } from "@/lib/chat-model";
import { SandboxPreview } from "./SandboxPreview";

const FADE = 18;

/** Background-agnostic edge fade: masks the scroll container's own opacity rather
 * than painting a gradient overlay, so it reads correctly against any card tint
 * (primary-tinted QuestionCard, PendingBar, light/dark theme) with no color to
 * keep in sync. Only fades an edge that's actually scrolled past, not statically. */
function edgeMask(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined;
  const stops = [
    top ? `transparent 0, black ${FADE}px` : "black 0",
    bottom ? `black calc(100% - ${FADE}px), transparent 100%` : "black 100%",
  ];
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** Tracks whether the option list has more content above/below the current
 * scroll position, recomputed on scroll and on size changes (e.g. a preview
 * iframe finishing load and growing the list). */
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

/** Leading index/status marker for a question. In a multi-question set it carries the
 * question's number (1-based) so the separations between questions are unambiguous;
 * once submitted it flips to a filled green check, giving an at-a-glance done signal.
 * For a lone question there's no number to show, so it only appears once submitted. */
function QuestionMarker({ index, answered, numbered }: { index: number; answered: boolean; numbered: boolean }) {
  if (!numbered && !answered) return null;
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums",
        answered ? "text-white" : "bg-primary/15 text-primary",
      )}
      style={answered ? { background: "var(--s-ok)" } : undefined}
    >
      {answered ? <Check className="size-3" /> : index + 1}
    </span>
  );
}

/**
 * One question within a set. Selections are stored on the shared card model rather
 * than in a row-local state, so the transcript and docked PendingBar stay in sync.
 * They are drafts until the one bottom-of-card submit action sends every answer.
 */
function QuestionRow(
  { turnId, toolCallId, index, item, numbered }: { turnId: string; toolCallId: string; index: number; item: QuestionItem; numbered: boolean },
) {
  const answered = item.answeredKeys != null;
  const selectedKeys = item.answeredKeys ?? item.draftKeys;
  const [expanded, setExpanded] = useState(!answered);
  const { ref, edges } = useScrollEdges([item.options.length]);
  const mask = edgeMask(edges.top, edges.bottom);

  // Collapse the instant a submitted answer lands. Drafted choices deliberately remain
  // open: users can still correct them before submitting the complete card.
  useEffect(() => {
    if (answered) setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);

  function selectOption(key: string): void {
    if (answered) return;
    if (item.multiSelect) {
      const next = new Set(selectedKeys);
      if (next.has(key)) next.delete(key); else next.add(key);
      actions.setQuestionDraft(turnId, toolCallId, index, [...next]);
      return;
    }
    actions.setQuestionDraft(turnId, toolCallId, index, [key]);
  }

  const selectedLabels = item.options
    .filter((option) => selectedKeys.includes(option.key))
    .map((option) => option.label || option.key)
    .join(", ");
  const resolutionLabel = item.declined ? "Declined" : selectedLabels;

  const header = (
    <div className="flex items-center gap-2">
      <QuestionMarker index={index} answered={answered} numbered={numbered} />
      <span className={cn("min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground", !expanded && "truncate")}>
        {item.question}
      </span>
      {answered && !expanded && (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{resolutionLabel}</span>
      )}
      {answered && (
        <ChevronRight className={cn("disclosure size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")} />
      )}
    </div>
  );

  return (
    <div className={cn("rounded-md", answered && !expanded && "chat-interactive px-2 py-1.5 hover:bg-white/[0.03]")}>
      {answered ? (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="chat-interactive w-full text-left">
          {header}
        </button>
      ) : header}

      {expanded && (
        <div className={cn(answered && "reveal-in mt-2")}>
          {item.context && (
            <div className={cn(
              "mb-2 whitespace-pre-wrap rounded-md border border-border bg-black/20 p-2 text-xs leading-snug text-muted-foreground",
              numbered && "ml-7",
            )}
            >
              {item.context}
            </div>
          )}
          {item.multiSelect && !answered && (
            <div className={cn("mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground", numbered && "ml-7")}>
              Select all that apply
            </div>
          )}
          <div
            ref={ref}
            className={cn(
              "qcard-options-scroll flex max-h-[280px] flex-col gap-1.5 overflow-y-auto pr-0.5",
              numbered && "ml-7",
            )}
            style={{ WebkitMaskImage: mask, maskImage: mask }}
          >
            {item.options.map((option) => {
              const selected = selectedKeys.includes(option.key);
              return (
                <div key={option.key}>
                  <button
                    type="button"
                    disabled={answered}
                    onClick={() => selectOption(option.key)}
                    className={cn(
                      "lift w-full rounded-md border border-border bg-white/[0.02] px-2.5 py-2 text-left",
                      "hover:border-primary/40 hover:bg-primary/[0.06] disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:shadow-none",
                      selected && "border-primary/60 bg-primary/10 shadow-[0_2px_10px_rgba(139,92,246,0.14)]",
                      answered && !selected && "opacity-50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {item.multiSelect ? (
                        <span className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                          selected ? "border-primary bg-primary" : "border-border bg-transparent",
                        )}
                        >
                          {selected && <Check className="size-3 text-white" />}
                        </span>
                      ) : (
                        <span className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                          selected ? "border-primary bg-primary" : "border-border bg-transparent",
                        )}
                        >
                          {selected && <span className="size-1.5 rounded-full bg-white" />}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{option.label || option.key}</span>
                    </div>
                    {option.description && (
                      <div className="mt-1 pl-6 text-xs leading-snug text-muted-foreground">{option.description}</div>
                    )}
                  </button>
                  {option.preview?.code ? <SandboxPreview preview={option.preview} label={option.label || option.key} /> : null}
                </div>
              );
            })}
          </div>
          {!answered && (
            <div className={cn("mt-2 text-xs text-muted-foreground", numbered && "ml-7")}>
              {selectedKeys.length === 0 ? "Choose an option to continue" : `${selectedKeys.length} selected — review and submit below`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Shared body for a set of one or more questions. Used both here in QuestionCard (the
 * thread) and, via the same turnId/toolCallId/items props, in the docked PendingBar.
 * A card now has exactly one submit action, always after the visible question stack.
 */
const QUESTIONS_PER_PAGE = 3;

function itemHasSelection(item: QuestionItem): boolean {
  return item.answeredKeys != null || item.draftKeys.length > 0;
}

/** Two or more sandboxed option previews need room for side-by-side comparison. The editor
 * panel owns their interactive selection UI; the chat drawer stays a compact launch point. */
export function hasQuestionPreviewGallery(items: QuestionItem[]): boolean {
  return items.reduce((count, item) => count + item.options.filter((option) => !!option.preview?.code).length, 0) >= 2;
}

function initialQuestionPage(items: QuestionItem[]): number {
  const firstOpen = items.findIndex((item) => !itemHasSelection(item));
  return firstOpen < 0 ? 0 : Math.floor(firstOpen / QUESTIONS_PER_PAGE);
}

/** Renders larger question sets as a compact, selection-gated wizard. The current page stays
 * focused on at most three decisions while the original item index is retained for the host. */
export function QuestionSetBody(
  { turnId, toolCallId, items }: { turnId: string; toolCallId: string; items: QuestionItem[] },
) {
  const numbered = items.length > 1;
  const pageCount = Math.max(1, Math.ceil(items.length / QUESTIONS_PER_PAGE));
  const [page, setPage] = useState(() => initialQuestionPage(items));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * QUESTIONS_PER_PAGE;
  const pageItems = items.slice(start, start + QUESTIONS_PER_PAGE);
  const answered = items.filter((item) => item.answeredKeys != null).length;
  const selected = items.filter(itemHasSelection).length;
  const pageSelected = pageItems.every(itemHasSelection);
  const allSelected = selected === items.length;
  const allAnswered = answered === items.length;
  const allDeclined = allAnswered && items.every((item) => item.declined);
  const onLastPage = safePage === pageCount - 1;

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  return (
    <div className="question-set">
      <div className="question-card-page flex flex-col">
        {pageItems.map((item, offset) => (
          <div key={start + offset} className={cn(offset > 0 && "mt-2.5 border-t border-border/50 pt-2.5")}>
            <QuestionRow turnId={turnId} toolCallId={toolCallId} index={start + offset} item={item} numbered={numbered} />
          </div>
        ))}
      </div>
      {pageCount > 1 && (
        <div className="question-card-pager">
          <div className="min-w-0">
            <div className="font-mono text-2xs tabular-nums text-muted-foreground">Page {safePage + 1} of {pageCount}</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">{selected} of {items.length} selected</div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button type="button" size="xs" variant="ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              <ChevronLeft className="size-3" /> Back
            </Button>
            {safePage < pageCount - 1 ? (
              <Button
                type="button"
                size="xs"
                disabled={!pageSelected}
                title={pageSelected ? "Continue to the next questions" : "Choose an answer for every question on this page"}
                onClick={() => setPage(safePage + 1)}
              >
                Continue <ChevronRight className="size-3" />
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {!onLastPage && !allAnswered && (
        <div className="mt-2 flex justify-end border-t border-primary/15 pt-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            title="Decline every question in this card and let the agent continue"
            onClick={() => actions.declineQuestionCard(turnId, toolCallId)}
          >
            <Ban className="size-3" /> Decline questions
          </Button>
        </div>
      )}
      {onLastPage && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-primary/20 pt-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">
              {allAnswered ? "Answers submitted" : allSelected ? "Ready to submit" : "Complete every question"}
            </div>
            <div className="mt-0.5 text-2xs text-muted-foreground tabular-nums">
              {allAnswered ? `${answered} of ${items.length} answered` : `${selected} of ${items.length} selected`}
            </div>
          </div>
          {allAnswered ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {allDeclined && <Ban className="size-3" />} {allDeclined ? "Questions declined" : "Responses recorded"}
            </span>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                title="Decline these questions and let the agent continue"
                onClick={() => actions.declineQuestionCard(turnId, toolCallId)}
              >
                <Ban className="size-3.5" /> Decline
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!allSelected}
                title={allSelected ? "Submit all selected answers" : "Choose an answer for every question first"}
                onClick={() => actions.submitQuestionCard(turnId, toolCallId)}
              >
                <Check className="size-3.5" />
                Submit <span className="font-mono text-2xs opacity-85">{selected}/{items.length}</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact progress reflects the action the user is currently taking: drafts are
 * "selected" and only a successful submit becomes "answered". */
function QuestionProgress({ items }: { items: QuestionItem[] }) {
  const answered = items.filter((item) => item.answeredKeys != null).length;
  const selected = items.filter(itemHasSelection).length;
  const total = items.length;
  const allAnswered = answered === total;

  if (total === 1) {
    if (allAnswered) return <span className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-semibold text-primary">{items[0]?.declined ? "Declined" : "Answered"}</span>;
    if (selected) return <span className="rounded-full bg-white/10 px-2 py-0.5 text-2xs font-semibold text-muted-foreground">Selected</span>;
    return null;
  }
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums",
        allAnswered ? "bg-primary/15 text-primary" : "bg-white/10 text-muted-foreground",
      )}
    >
      {allAnswered ? `${answered} / ${total} resolved` : `${selected} / ${total} selected`}
    </span>
  );
}

export function QuestionCard({ turnId, card }: { turnId: string; card: QCardModel }) {
  const multi = card.items.length > 1;

  return (
    <div id={`tool-${card.toolCallId}`} className="question-card fade-in rounded-lg border border-primary/25 bg-primary/[0.06] p-2.5 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="pulse-dot" />
          <span className="text-2xs font-bold uppercase tracking-[0.07em] text-primary">
            {multi ? `Questions (${card.items.length})` : "Question"}
          </span>
        </div>
        <QuestionProgress items={card.items} />
      </div>

      <QuestionSetBody turnId={turnId} toolCallId={card.toolCallId} items={card.items} />
    </div>
  );
}
