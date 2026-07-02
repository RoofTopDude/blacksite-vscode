import { actions } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { QuestionCard as QCardModel } from "@/lib/chat-model";
import type { QCardOption } from "@/lib/protocol";
import { SandboxPreview } from "./SandboxPreview";

/**
 * Shared option-button list. Used inline here in QuestionCard and, via the same
 * turnId/toolCallId/options props, in the docked PendingBar — one implementation
 * of the answer-selection wiring and preview rendering instead of two.
 */
export function QuestionOptions(
  { turnId, toolCallId, options, answeredKey }: { turnId: string; toolCallId: string; options: QCardOption[]; answeredKey: string | null },
) {
  const answered = answeredKey != null;
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option) => {
        const selected = answeredKey === option.key;
        return (
          <div key={option.key}>
            <button
              type="button"
              disabled={answered}
              onClick={() => actions.answerQuestion(turnId, toolCallId, option.key)}
              className={cn(
                "chat-interactive w-full rounded-md border border-border bg-white/[0.02] p-2 text-left",
                "hover:border-primary/40 hover:bg-primary/[0.06] disabled:cursor-default disabled:active:scale-100",
                selected && "border-primary/60 bg-primary/10",
                answered && !selected && "opacity-50",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn("text-[11px] text-primary", selected ? "opacity-100" : "opacity-0")}>✓</span>
                <span className="text-[11.5px] font-medium text-foreground">{option.label || option.key}</span>
              </div>
              {option.description && (
                <div className="mt-0.5 pl-[18px] text-[10.5px] leading-snug text-muted-foreground">{option.description}</div>
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
          <span className="text-[9px] font-bold uppercase tracking-[0.07em] text-primary">Question</span>
        </div>
        {answered && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-semibold text-primary">Answered</span>
        )}
      </div>

      <div className="mb-2 text-[12px] font-medium leading-snug text-foreground">{card.question}</div>
      {card.context && (
        <div className="mb-2 whitespace-pre-wrap rounded-md border border-border bg-black/20 p-2 text-[10.5px] leading-snug text-muted-foreground">
          {card.context}
        </div>
      )}

      <QuestionOptions turnId={turnId} toolCallId={card.toolCallId} options={card.options} answeredKey={card.answeredKey} />
    </div>
  );
}
