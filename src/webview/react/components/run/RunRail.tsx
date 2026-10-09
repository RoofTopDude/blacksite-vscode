import { useEffect, useRef, useState } from "react";
import { Bell, FileDiff, FileText, ListChecks, Map as MapIcon, Pause, Play, RotateCw, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { iterationProgressLabel } from "@/lib/format";
import { useLiveClock } from "@/lib/use-live-clock";
import type { PlanRunView } from "@/lib/protocol";
import { RUN_STATE_META, formatCountdown, formatRunDuration, runClockMs, runIsOver, runIsTicking } from "@/lib/run-format";
import { LiveAction } from "@/components/chat/LiveAction";
import { StatusPill, LiveDot } from "@/components/chat/signal";
import { BudgetMeter, RunProgressBar } from "./bits";
import { StepTimeline } from "./StepTimeline";
import { LaneStrip } from "./LaneStrip";

const button = "chat-interactive inline-flex h-6 items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground";

/**
 * The plan run, pinned above the chat for as long as it exists.
 *
 * It answers the questions a person asks when they come back after a few hours: is it still
 * going, how far along, what is it doing right now, does it need me, what has it cost. One state
 * word, one bar, one line of live activity, and the controls — and nothing else, because
 * everything longer belongs in a tooltip or the step list underneath.
 */
export function RunRail() {
  const store = useStore();
  const run = store.planRun;
  if (!run || store.dismissedRunId === run.id) return null;
  return <Rail run={run} />;
}

function Rail({ run }: { run: PlanRunView }) {
  const store = useStore();
  const over = runIsOver(run);
  const ticking = runIsTicking(run.liveState);
  const now = useLiveClock(ticking);
  const meta = RUN_STATE_META[run.liveState];
  const live = store.chat.currentLiveTurnId ? store.chat.byId.get(store.chat.currentLiveTurnId) : undefined;
  const clock = formatRunDuration(runClockMs(run, now - store.planRunAt));
  const waitingOnYou = store.attention.filter((item) => item.severity === "needs_you").length;

  // A step finishing is the thing a person glancing at the bar wants to notice: the bar glows once.
  const lastDone = useRef(run.stepsDone);
  const [ticked, setTicked] = useState(false);
  useEffect(() => {
    const finished = run.stepsDone > lastDone.current;
    lastDone.current = run.stepsDone;
    if (!finished) return;
    setTicked(true);
    const timer = setTimeout(() => setTicked(false), 1200);
    return () => clearTimeout(timer);
  }, [run.stepsDone]);

  const rounds = live ? iterationProgressLabel(live.iterations, store.settings.maxIterations) : "";
  const barTitle = [
    run.stepsTotal ? `Step ${run.stepPosition} of ${run.stepsTotal}${run.phaseCount ? ` · phase ${run.phaseIndex} of ${run.phaseCount}` : ""}` : "",
    run.medianStepMs ? `A step takes about ${formatRunDuration(run.medianStepMs)} (median)` : "",
    `Working ${formatRunDuration(run.activeMs)} · waiting on you ${formatRunDuration(run.waitingUserMs)} · waiting on the model ${formatRunDuration(run.waitingProviderMs)}`,
    rounds ? `This turn: ${rounds}` : "",
    run.compactions ? `${run.compactions} compaction${run.compactions === 1 ? "" : "s"}` : "",
    run.retries ? `${run.retries} provider retr${run.retries === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean).join("\n");

  return (
    <section className="run-rail" aria-label="Plan run" data-state={run.liveState} data-ticked={ticked || undefined}>
      <div className="flex items-center gap-1.5">
        <StatusPill tone={meta.tone} className={cn("text-2xs", run.liveState === "working" && "live-breathe")}>
          {run.liveState === "working" && <LiveDot tone={meta.tone} />}
          {run.liveState === "needs_you" && <Bell className="size-2.5" />}
          <span title={meta.hint}>{meta.label}</span>
        </StatusPill>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={run.planTitle}>{run.planTitle}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" title="Time the run has spent working or waiting. Time paused is not counted.">{clock}</span>
        <BudgetMeter spent={run.spentUsd} max={run.maxUsd} partial={run.spendPartial} />
      </div>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <RunProgressBar phases={run.phases} done={run.stepsDone} total={run.stepsTotal} tone={run.liveState === "failed" ? "err" : run.liveState === "done" ? "ok" : "info"} title={barTitle} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={barTitle}>
          {run.stepsTotal ? `Step ${run.stepPosition}/${run.stepsTotal}` : "No steps"}
          {run.phaseCount > 1 ? ` · Phase ${run.phaseIndex}/${run.phaseCount}` : ""}
        </span>
      </div>

      <RailLine run={run} live={live} now={now} waitingOnYou={waitingOnYou} />
      {live && <LaneStrip turn={live} />}

      <div className="flex flex-wrap items-center gap-1">
        {!over && run.liveState !== "paused" && run.liveState !== "interrupted" && run.status !== "failed" && (
          <button type="button" className={button} onClick={() => actions.pausePlanRun()} disabled={run.pauseRequested}
            title="Pause the run at the end of the step it is on. Nothing is cut off mid-command.">
            <Pause className="size-3" />{run.pauseRequested ? "Pausing…" : "Pause"}
          </button>
        )}
        {!over && (run.liveState === "paused" || run.liveState === "interrupted" || run.status === "failed") && (
          <button type="button" className={cn(button, "border-primary/40 text-primary")} onClick={() => actions.resumePlanRun()}
            title="Carry on from where the run stopped. The agent is told what was done and what is next.">
            <Play className="size-3" />Resume
          </button>
        )}
        {!over && (
          <button type="button" className={button} onClick={() => actions.stopPlanRun()}
            title="End the run. Work already done stays; the run's approvals are dropped and it will not continue.">
            <Square className="size-3" />Stop
          </button>
        )}
        <button type="button" className={cn(button, store.timelineOpen && "border-primary/40 text-primary")} onClick={() => actions.toggleTimeline()}
          aria-pressed={store.timelineOpen} title="Show every phase and step, how long each took, and what checked it.">
          <ListChecks className="size-3" />Steps
        </button>
        {(run.hasBaseline || run.stepsDone > 0) && (
          <button type="button" className={button} onClick={() => actions.reviewChanges("run")}
            title="Open every file changed since the run started as one review, each against how it was before the run.">
            <FileDiff className="size-3" />Changes
          </button>
        )}
        <button type="button" className={button} onClick={() => actions.showRunOnMap()}
          title="Open the Codebase Map where the run is working: the last file it changed, or the files its current phase names.">
          <MapIcon className="size-3" />Map
        </button>
        {run.hasReport && (
          <button type="button" className={button} onClick={() => actions.openRunReport()}
            title="Open the report: what was done, how long it took, what checked it, and what was never checked.">
            <FileText className="size-3" />Report
          </button>
        )}
        {over && (
          <button type="button" className={cn(button, "ml-auto")} onClick={() => actions.dismissRun()} title="Hide this bar. The record of the run stays in the workspace.">
            <X className="size-3" />Dismiss
          </button>
        )}
      </div>

      {store.timelineOpen && <StepTimeline run={run} />}
    </section>
  );
}

/** The one line of "what is happening", which depends on what state the run is in. */
function RailLine({ run, live, now, waitingOnYou }: { run: PlanRunView; live: ReturnType<typeof useStore>["chat"]["turns"][number] | undefined; now: number; waitingOnYou: number }) {
  switch (run.liveState) {
    case "working":
    case "quiet":
      return (
        <div className="min-w-0">
          {live ? <LiveAction turn={live} /> : (
            <div className="run-rail-line">Between steps — deciding what to do next.</div>
          )}
          {run.liveState === "quiet" && run.quietMs !== undefined && (
            <div className="run-rail-line text-[color:var(--s-warn)]" role="status">
              No response for {formatRunDuration(run.quietMs)}. Providers can go quiet while they think; if this goes on, stop the turn and resume.
            </div>
          )}
          {run.nextStep && <div className="run-rail-line text-muted-foreground/80" title="The next step in the plan.">Next: {run.nextStep.title}</div>}
        </div>
      );
    case "needs_you":
      return (
        <div className="run-rail-line" role="status">
          Waiting for you{waitingOnYou > 1 ? ` — ${waitingOnYou} things` : ""}. The request is above the composer; the run continues as soon as you answer.
        </div>
      );
    case "provider":
      return (
        <div className="flex items-center gap-2" role="status">
          <span className="run-rail-line min-w-0 flex-1">
            The model provider is unavailable{run.providerRetryAt ? ` — trying again in ${formatCountdown(run.providerRetryAt, now)}` : ""}.
          </span>
          <button type="button" className={button} onClick={() => actions.retryProviderNow()} title="Try the provider again now instead of waiting.">
            <RotateCw className="size-3" />Retry now
          </button>
        </div>
      );
    case "paused":
      return <div className="run-rail-line">{run.endReason ?? "Paused."} {run.currentStep ? `Next up: ${run.currentStep.title}.` : ""}</div>;
    case "interrupted":
      return <div className="run-rail-line">VS Code closed or reloaded while this was working. Resume to pick the plan up at {run.currentStep ? `“${run.currentStep.title}”` : "the current step"}.</div>;
    case "failed":
      return <div className="run-rail-line text-[color:var(--s-err)]">{run.endReason ?? "The run stopped on an error."}</div>;
    case "done":
      return <div className="run-rail-line">Every step is done — {run.stepsDone} steps in {formatRunDuration(run.activeMs + run.waitingUserMs + run.waitingProviderMs)}.</div>;
    case "stopped":
      return <div className="run-rail-line">{run.endReason ?? "The run was stopped."}</div>;
  }
}
