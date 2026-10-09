/* Wording for plan runs: durations that scale to hours, and the one-word state labels the run bar,
   the Header pill and the timeline share. Kept apart from format.ts so a run reads the same
   everywhere without each surface re-deciding what "paused" is called. */

import type { PlanRunLiveState, PlanRunView } from "./protocol";
import type { SignalTone } from "@/components/chat/signal";

/** "42s", "7m 12s", "1h 05m". Unlike formatDuration this stays readable across a whole afternoon. */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** How long until a moment, for a retry countdown. */
export function formatCountdown(untilMs: number, now: number): string {
  const left = Math.max(0, untilMs - now);
  return left < 1000 ? "now" : formatRunDuration(left);
}

export interface RunStateMeta {
  label: string;
  tone: SignalTone;
  /** One sentence for the tooltip. */
  hint: string;
}

export const RUN_STATE_META: Record<PlanRunLiveState, RunStateMeta> = {
  working: { label: "Working", tone: "info", hint: "The plan is running." },
  quiet: { label: "Quiet", tone: "warn", hint: "Nothing has come back from the agent for a while." },
  needs_you: { label: "Needs you", tone: "warn", hint: "The run is waiting for you and will not go on until you answer." },
  provider: { label: "Waiting", tone: "warn", hint: "The model provider is unavailable. The run is waiting and will try again." },
  paused: { label: "Paused", tone: "warn", hint: "The run is paused. Nothing happens until you resume it." },
  interrupted: { label: "Interrupted", tone: "warn", hint: "VS Code closed or reloaded while the run was working. Resume to carry on." },
  done: { label: "Done", tone: "ok", hint: "Every step is finished." },
  stopped: { label: "Stopped", tone: "idle", hint: "The run was stopped." },
  failed: { label: "Stopped", tone: "err", hint: "The run stopped on an error or a ceiling." },
};

/** Whether the run still has a clock running (so the bar should tick). */
export function runIsTicking(state: PlanRunLiveState): boolean {
  return state === "working" || state === "quiet" || state === "needs_you" || state === "provider";
}

export function runIsOver(run: Pick<PlanRunView, "status">): boolean {
  return run.status === "completed" || run.status === "stopped" || run.status === "budget_exhausted";
}

/** Time the run has spent running or waiting, not paused — what "how long has this taken" means. */
export function runClockMs(run: PlanRunView, sinceReceivedMs: number): number {
  const live = runIsTicking(run.liveState) ? Math.max(0, sinceReceivedMs) : 0;
  return run.activeMs + run.waitingUserMs + run.waitingProviderMs + live;
}

export function formatUsd(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
