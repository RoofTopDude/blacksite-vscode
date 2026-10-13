import { useState } from "react";
import { cn } from "@/lib/utils";
import { actions } from "@/lib/store";
import type { DeferredDecisionView, PlanRunView } from "@/lib/protocol";
import { formatRunDuration, runIsOver } from "@/lib/run-format";
import { StatusPill } from "@/components/chat/signal";

const button = "chat-interactive inline-flex h-6 items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground disabled:opacity-40";

const KIND_LABEL: Record<DeferredDecisionView["kind"], string> = {
  approval: "Run",
  edit: "Edit",
  question: "Question",
};

const STATUS_TONE = { approved: "ok", answered: "ok", declined: "idle", open: "warn" } as const;

/**
 * What the run needed from the user while they were away, queued instead of waited on.
 *
 * Each one is a decision only the user can make. Approving one lets the agent repeat exactly that
 * operation once; declining tells it to find another way; answering a question passes the choice
 * on. The run never carries any of these out on its own.
 */
export function DecisionsPanel({ run }: { run: PlanRunView }) {
  const over = runIsOver(run);
  if (run.decisions.length === 0) {
    return <div className="run-rail-line text-muted-foreground">Nothing has been queued. When the run needs you and nobody answers, the decision waits here.</div>;
  }
  return (
    <section aria-label="Queued decisions" className="flex flex-col divide-y divide-border rounded-md border border-border bg-white/[0.02]">
      {run.decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} over={over} />)}
    </section>
  );
}

function DecisionRow({ decision, over }: { decision: DeferredDecisionView; over: boolean }) {
  const open = decision.status === "open";
  const firstLine = (decision.description.split("\n").find((line) => line.trim()) ?? decision.description).trim();
  const age = formatRunDuration(Math.max(0, Date.now() - decision.at));
  return (
    <div className={cn("flex flex-col gap-1 px-2 py-1.5 text-sm", !open && "opacity-60")}>
      <div className="flex items-start gap-1.5">
        <span className="mt-px font-mono text-2xs text-muted-foreground">{decision.id}</span>
        <span className="min-w-0 flex-1 break-words" title={decision.description}>
          <span className="text-muted-foreground">{KIND_LABEL[decision.kind]}: </span>{firstLine}
        </span>
        {!open && <StatusPill tone={STATUS_TONE[decision.status]} className="text-2xs">{decision.status}</StatusPill>}
      </div>
      <div className="text-xs text-muted-foreground">
        {decision.stepTitle ? `During “${decision.stepTitle}” · ` : ""}{age} ago{decision.tier ? ` · ${decision.tier} operation` : ""}
      </div>
      {open && !over && (decision.kind === "question" ? <QuestionAnswer decision={decision} /> : (
        <div className="flex flex-wrap gap-1">
          <button type="button" className={cn(button, "border-primary/40 text-primary")} onClick={() => actions.answerRunDecision(decision.id, "approve")}
            title="The agent may repeat exactly this, once. It is told you approved it.">
            Approve
          </button>
          <button type="button" className={button} onClick={() => actions.answerRunDecision(decision.id, "decline")}
            title="The agent is told not to do this or reach the same result another way.">
            Decline
          </button>
        </div>
      ))}
      {open && over && <div className="text-xs text-muted-foreground">The run has ended, so there is nobody left to tell.</div>}
      {!open && decision.answer && decision.status === "answered" && <div className="text-xs text-muted-foreground">{decision.answer}</div>}
    </div>
  );
}

function QuestionAnswer({ decision }: { decision: DeferredDecisionView }) {
  const questions = decision.questions ?? [];
  const [chosen, setChosen] = useState<string[][]>(() => questions.map(() => []));
  const complete = questions.length > 0 && chosen.every((keys) => keys.length > 0);

  function pick(index: number, key: string, multi: boolean): void {
    setChosen((current) => current.map((keys, at) => {
      if (at !== index) return keys;
      if (!multi) return [key];
      return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
    }));
  }

  return (
    <div className="flex flex-col gap-1.5">
      {questions.map((question, index) => (
        <div key={index} className="flex flex-col gap-1">
          {questions.length > 1 && <div className="text-xs">{question.question}</div>}
          <div className="flex flex-wrap gap-1" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
            {question.options.map((option) => {
              const selected = chosen[index]?.includes(option.key) ?? false;
              return (
                <button key={option.key} type="button" aria-pressed={selected} onClick={() => pick(index, option.key, !!question.multiSelect)}
                  className={cn(button, selected && "border-primary/50 bg-primary/15 text-foreground")} title={option.description}>
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <button type="button" className={cn(button, "border-primary/40 text-primary")} disabled={!complete} onClick={() => actions.answerRunDecision(decision.id, "answer", chosen)}>
          Send answer
        </button>
        <button type="button" className={button} onClick={() => actions.answerRunDecision(decision.id, "decline")}
          title="The agent chooses what is easiest to change later and says what it chose.">
          Let it decide
        </button>
      </div>
    </div>
  );
}
