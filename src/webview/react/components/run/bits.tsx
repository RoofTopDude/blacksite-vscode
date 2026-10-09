import { AlertTriangle, CheckCircle2, Circle, CircleDot, Loader2, ShieldCheck, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanRunPhaseView, PlanRunStepView } from "@/lib/protocol";
import { formatUsd } from "@/lib/run-format";
import { StatusPill, toneColor, type SignalTone } from "@/components/chat/signal";

/** One icon per step state, so a list of steps reads at a glance. */
export function StepStatusIcon({ status, className }: { status: PlanRunStepView["status"]; className?: string }) {
  switch (status) {
    case "completed": return <CheckCircle2 className={cn("size-3.5 shrink-0", className)} style={{ color: "var(--s-ok)" }} aria-label="Done" />;
    case "in_progress": return <Loader2 className={cn("size-3.5 shrink-0 animate-spin", className)} style={{ color: "var(--s-info)" }} aria-label="In progress" />;
    case "blocked": return <AlertTriangle className={cn("size-3.5 shrink-0", className)} style={{ color: "var(--s-warn)" }} aria-label="Blocked" />;
    default: return <Circle className={cn("size-3.5 shrink-0 text-muted-foreground/60", className)} aria-label="Not started" />;
  }
}

/**
 * What a finished step was shown to have. Never a gate: a step nothing checked is labelled
 * unverified, and the label is the whole of the consequence.
 */
export function EvidenceChips({ step }: { step: PlanRunStepView }) {
  const evidence = step.evidence;
  if (!evidence || step.status !== "completed") return null;
  const checked = evidence.checks.length > 0;
  const unverified = evidence.unverified.length;
  const changed = evidence.filesChanged.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {checked && (
        <StatusPill tone="ok" className="text-2xs" >
          <ShieldCheck className="size-2.5" />
          <span title={`Cleared by: ${evidence.checks.join(", ")}`}>{evidence.checks[0]}{evidence.checks.length > 1 ? ` +${evidence.checks.length - 1}` : ""}</span>
        </StatusPill>
      )}
      {unverified > 0 && (
        <StatusPill tone="warn" className="text-2xs">
          <ShieldQuestion className="size-2.5" />
          <span title={`Changed and not checked:\n${evidence.unverified.join("\n")}`}>{unverified} unverified</span>
        </StatusPill>
      )}
      {!checked && unverified === 0 && changed === 0 && (
        <span className="text-2xs text-muted-foreground/80" title="The step changed no files, so there was nothing to check.">no changes</span>
      )}
      {!checked && unverified === 0 && changed > 0 && (
        <span className="text-2xs text-muted-foreground/80" title="The files changed needed no check (prose or configuration).">no check needed</span>
      )}
      {changed > 0 && (
        <span className="text-2xs text-muted-foreground/80" title={evidence.filesChanged.slice(0, 20).join("\n")}>{changed} file{changed === 1 ? "" : "s"}</span>
      )}
    </span>
  );
}

/**
 * The plan as a bar: one segment per phase, as wide as it has steps, filled as steps finish.
 * The segment being worked breathes. Alone it says how far along; with its tooltip, where.
 */
export function RunProgressBar({
  phases,
  done,
  total,
  tone = "info",
  title,
}: {
  phases: PlanRunPhaseView[];
  done: number;
  total: number;
  tone?: SignalTone;
  title?: string;
}) {
  const fill = toneColor(tone);
  return (
    <div
      className="run-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} steps done`}
      title={title}
    >
      {phases.map((phase) => {
        const count = Math.max(phase.steps.length, 1);
        const finished = phase.steps.filter((step) => step.status === "completed").length;
        const working = phase.steps.some((step) => step.status === "in_progress");
        const blocked = phase.steps.some((step) => step.status === "blocked");
        return (
          <span key={phase.id} className="run-bar-seg" style={{ flexGrow: count }} data-working={working || undefined} data-blocked={blocked || undefined}>
            <i style={{ width: `${(finished / count) * 100}%`, background: fill }} />
          </span>
        );
      })}
    </div>
  );
}

/** Spend against its ceiling, when there is one. */
export function BudgetMeter({ spent, max, partial }: { spent: number; max?: number; partial?: boolean }) {
  const pct = max ? Math.min(spent / max, 1) : 0;
  const tone: SignalTone = max && pct >= 0.9 ? "err" : max && pct >= 0.7 ? "warn" : "idle";
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground"
      title={max ? `Spent ${formatUsd(spent)} of the ${formatUsd(max)} ceiling for this run${partial ? " (some usage could not be priced)" : ""}.` : `Spent ${formatUsd(spent)} so far${partial ? " (some usage could not be priced)" : ""}.`}
    >
      {formatUsd(spent)}{partial ? "+" : ""}
      {max ? (
        <>
          <span className="inline-block h-1 w-8 overflow-hidden rounded-full bg-white/10" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${pct * 100}%`, background: toneColor(tone === "idle" ? "info" : tone) }} />
          </span>
          <span className="text-muted-foreground/70">{formatUsd(max)}</span>
        </>
      ) : null}
    </span>
  );
}

export function CurrentStepDot({ className }: { className?: string }) {
  return <CircleDot className={cn("size-3 shrink-0", className)} style={{ color: "var(--s-info)" }} aria-hidden />;
}
