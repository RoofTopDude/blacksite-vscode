import { useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { actions } from "@/lib/store";
import type { PlanRunView } from "@/lib/protocol";
import { formatRunDuration } from "@/lib/run-format";
import { formatClock } from "@/lib/format";
import { EvidenceChips, StepStatusIcon } from "./bits";

/**
 * Every phase and step of the plan with when it ran, how long it took, how often it was tried
 * and what checked it. The plan stays the source of truth for what is done; this adds the time
 * and the evidence. Clicking a step takes the transcript to the turn that did the work.
 */
export function StepTimeline({ run }: { run: PlanRunView }) {
  return (
    <div className="step-timeline reveal-in" role="list" aria-label="Plan steps">
      {run.phases.map((phase, index) => (
        <Phase key={phase.id} run={run} phase={phase} index={index} />
      ))}
      {run.snapshotNote && (
        <div className="px-1 pt-1 text-2xs text-muted-foreground/80" title="Restore points are the working tree captured after each step.">
          Restore points: {run.snapshotNote}
        </div>
      )}
    </div>
  );
}

function Phase({ run, phase, index }: { run: PlanRunView; phase: PlanRunView["phases"][number]; index: number }) {
  const done = phase.steps.filter((step) => step.status === "completed").length;
  const hasCurrent = phase.steps.some((step) => step.status === "in_progress" || step.id === run.currentStep?.stepId && phase.id === run.currentStep?.phaseId);
  const [manual, setManual] = useState<boolean | null>(null);
  // The phase being worked is open; finished and future phases are one line each.
  const open = manual ?? hasCurrent;
  return (
    <div role="listitem">
      <button type="button" onClick={() => setManual(!open)} className="chat-interactive flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.04]" aria-expanded={open}>
        <ChevronRight className={cn("disclosure size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
        <span className="text-xs font-semibold text-foreground/90">Phase {index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={phase.title}>{phase.title}</span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{done}/{phase.steps.length}</span>
      </button>
      {open && (
        <ul className="ml-3 flex flex-col border-l border-border pl-2">
          {phase.steps.map((step) => {
            const current = run.currentStep?.phaseId === phase.id && run.currentStep.stepId === step.id;
            return (
              <li key={step.id} className={cn("step-row", current && "step-row-current")}>
                <button
                  type="button"
                  className="chat-interactive flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.04]"
                  onClick={() => step.turnId && actions.revealTurn(step.turnId)}
                  disabled={!step.turnId}
                  title={step.turnId ? "Show the part of the conversation that did this step." : "This step has not been worked on yet."}
                >
                  <StepStatusIcon status={step.status} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground/90" title={step.title}>{step.title}</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                      {step.durationMs !== undefined && <span>{formatRunDuration(step.durationMs)}</span>}
                      {step.startedAt !== undefined && step.status !== "pending" && <span>{formatClock(step.startedAt)}</span>}
                      {step.attempts > 1 && <span className="text-[color:var(--s-warn)]" title="The step moved back to in progress after it had been started.">tried {step.attempts}×</span>}
                      <EvidenceChips step={step} />
                      {step.status === "blocked" && step.blockedReason && <span className="text-[color:var(--s-warn)]" title={step.blockedReason}>{step.blockedReason.slice(0, 80)}</span>}
                    </span>
                  </span>
                </button>
                {step.restorable && step.status === "completed" && (
                  <button
                    type="button"
                    className="chat-interactive ml-5 inline-flex items-center gap-1 rounded px-1 text-2xs text-muted-foreground hover:text-foreground"
                    onClick={() => actions.restoreToStep(phase.id, step.id)}
                    title="Put the files back the way they were when this step finished. You will see what changes first."
                  >
                    <RotateCcw className="size-2.5" />Restore to here
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
