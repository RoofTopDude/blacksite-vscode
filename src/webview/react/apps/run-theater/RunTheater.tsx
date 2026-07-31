/**
 * One execution run, watched live and then scrubbed back through.
 *
 * The surface is deliberately a single instrument rather than two screens: while the run is in
 * flight the stage shows the newest frame and the stream tails the trace; once it settles, the
 * same controls become a transport over what happened. Nothing moves, nothing has to be
 * re-learned — which is the difference between a viewer and a log window.
 */
import { useEffect, useMemo, useRef } from "react";
import { CircleSlash, Pause, Play, RefreshCw, TriangleAlert } from "lucide-react";
import { PanelHeader } from "@/components/PanelHeader";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import {
  eventLabel,
  formatRunDuration,
  isAnomalyEvent,
  observationForSequence,
  runCoverage,
  runTitle,
  visualArtifactsForObservation,
} from "../runs/view-model";
import { initTheaterStore, theaterActions, useTheaterStore } from "./store";

const ACTIVE_STATUSES = new Set(["created", "validating", "awaiting_approval", "running"]);

/** Severity → the shared signal tokens, so a warning here reads the same as a warning anywhere
 *  else in the product. */
function severityTone(severity: string | undefined): string | undefined {
  if (severity === "error") return "var(--s-err)";
  if (severity === "warning") return "var(--s-warn)";
  return undefined;
}

export function RunTheater() {
  const state = useTheaterStore();
  useEffect(() => { initTheaterStore(); }, []);

  const run = state.run;
  const isActive = run ? ACTIVE_STATUSES.has(run.status) : false;

  const observation = useMemo(
    () => (run ? observationForSequence(state.observations, state.playheadSequence) : undefined),
    [run, state.observations, state.playheadSequence],
  );
  const frames = useMemo(
    () => visualArtifactsForObservation(observation, state.artifacts),
    [observation, state.artifacts],
  );
  const coverage = useMemo(
    () => (run ? runCoverage(run, state.steps) : undefined),
    [run, state.steps],
  );

  const runningStep = useMemo(
    () => state.steps.find((step) => step.status === "running"),
    [state.steps],
  );

  if (state.loading) {
    return (
      <div className="theater-root flex h-screen items-center justify-center">
        <span className="pulse-dot" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="theater-root flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm font-medium text-foreground">No run to show</div>
        <p className="max-w-sm text-xs text-muted-foreground">
          Execution runs are produced by the agent's sequence tools. Ask it to run a sequence and
          this view will follow it as it happens.
        </p>
      </div>
    );
  }

  return (
    <div className="theater-root flex h-screen flex-col overflow-hidden">
      <header className="theater-header shrink-0 border-b border-border px-4 py-3">
        <PanelHeader
          eyebrow="Execution run"
          title={runTitle(run)}
          sub={
            <span className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              {coverage && <span>{coverage.completed} of {coverage.total} steps</span>}
              <span>{formatRunDuration(run)}</span>
              {state.watermark && <span>{state.watermark.eventCount} events</span>}
            </span>
          }
          status={
            isActive
              ? { label: runningStep ? `Step ${runningStep.ordinal + 1}` : "Running", tone: "live", pulse: true }
              : { label: "Settled", tone: run.status === "succeeded" ? "ok" : "idle" }
          }
          actions={
            <>
              <Button
                size="xs"
                variant={state.following ? "secondary" : "ghost"}
                onClick={() => theaterActions.setFollowing(!state.following)}
                title={state.following ? "Following the newest event" : "Paused — scrubbed away from the tail"}
              >
                {state.following ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {state.following ? "Following" : "Paused"}
              </Button>
              {isActive && (
                <Button size="xs" variant="ghost" onClick={() => theaterActions.cancel()}>
                  <CircleSlash className="size-3.5" />
                  Cancel
                </Button>
              )}
            </>
          }
        />
      </header>

      {state.reconnecting && (
        <div className="theater-banner flex items-center gap-2 px-4 py-1.5 text-xs" role="status">
          <RefreshCw className="size-3.5 animate-spin" aria-hidden />
          Lost the tail of the trace — resyncing from a fresh baseline.
        </div>
      )}
      {state.error && (
        <div className="theater-banner is-error flex items-center gap-2 px-4 py-1.5 text-xs" role="alert">
          <TriangleAlert className="size-3.5" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{state.error}</span>
          <Button size="xs" variant="ghost" onClick={() => theaterActions.dismissError()}>Dismiss</Button>
        </div>
      )}

      <div className="theater-body grid min-h-0 flex-1 grid-cols-[220px_1fr] overflow-hidden">
        <StepRail steps={state.steps} playhead={state.playheadSequence} />
        <div className="grid min-h-0 grid-rows-[1fr_auto] overflow-hidden">
          <Stage frames={frames} runningLabel={runningStep ? eventLabel({
            channel: "action",
            type: runningStep.declaredAction?.type ?? "step",
          } as never) : undefined} />
          <EventStream events={state.events} playhead={state.playheadSequence} />
        </div>
      </div>

      <Transport
        first={state.truncatedBefore ?? 1}
        last={state.watermark?.lastSequenceNumber ?? state.lastSequence}
        playhead={state.playheadSequence}
        onSeek={(value) => theaterActions.seek(value)}
      />
    </div>
  );
}

function StepRail({ steps, playhead }: { steps: ReturnType<typeof useTheaterStore>["steps"]; playhead: number }) {
  return (
    <aside className="theater-rail min-h-0 overflow-y-auto border-r border-border">
      {steps.length === 0 && (
        <p className="px-3 py-4 text-xs text-muted-foreground">No steps recorded yet.</p>
      )}
      {steps.map((step) => {
        const started = step.startCursor?.sequenceNumber ?? 0;
        const ended = step.endCursor?.sequenceNumber ?? Number.POSITIVE_INFINITY;
        const current = playhead >= started && playhead <= ended;
        return (
          <div
            key={step.id}
            className={cn("theater-rail-step px-3 py-2", current && "is-current")}
            aria-current={current || undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs tabular-nums text-muted-foreground">{step.ordinal + 1}</span>
              <StatusBadge status={step.status} />
            </div>
            <div className="mt-0.5 truncate text-xs text-foreground">
              {step.title || step.declaredAction?.type || step.id}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

/** The newest visual observation at the playhead. During a live run this is the closest thing to
 *  "what the agent is looking at right now". */
function Stage({ frames, runningLabel }: { frames: Array<{ id: string; url?: string }>; runningLabel?: string }) {
  const frame = frames[0];
  return (
    <div className="theater-stage relative flex min-h-0 items-center justify-center overflow-hidden">
      {frame?.url
        ? <img className="theater-stage-image" src={frame.url} alt="" decoding="async" />
        : (
          <p className="px-6 text-center text-xs text-muted-foreground">
            No visual capture at this point in the run.
          </p>
        )}
      {runningLabel && (
        <div className="theater-nowline absolute inset-x-0 bottom-0 truncate px-4 py-1.5 text-xs">
          {runningLabel}
        </div>
      )}
    </div>
  );
}

function EventStream({
  events,
  playhead,
}: {
  events: ReturnType<typeof useTheaterStore>["events"];
  playhead: number;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const atTail = events.at(-1)?.sequenceNumber === playhead;

  useEffect(() => {
    if (atTail) endRef.current?.scrollIntoView({ block: "end" });
  }, [events.length, atTail]);

  return (
    <div className="theater-stream min-h-0 overflow-y-auto border-t border-border" role="log">
      {events.map((event) => (
        <div
          key={event.id}
          className={cn("theater-stream-row", isAnomalyEvent(event) && "is-anomaly")}
          style={{ ["--row-tone" as string]: severityTone(event.severity) }}
        >
          <span className="theater-stream-seq tabular-nums">{event.sequenceNumber}</span>
          <span className="theater-stream-channel">{event.channel}</span>
          <span className="theater-stream-label truncate">{eventLabel(event)}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/**
 * The transport. A plain range input for now — Phase 3 replaces this with the filmstrip and
 * per-channel lanes, and keeps this same seek contract so the swap is local to this component.
 */
function Transport({
  first,
  last,
  playhead,
  onSeek,
}: {
  first: number;
  last: number;
  playhead: number;
  onSeek: (value: number) => void;
}) {
  const min = Math.max(1, first);
  const max = Math.max(min, last);
  return (
    <footer className="theater-transport shrink-0 border-t border-border px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-2xs tabular-nums text-muted-foreground">{min}</span>
        <input
          className="theater-scrubber flex-1"
          type="range"
          min={min}
          max={max}
          value={Math.min(Math.max(playhead, min), max)}
          onChange={(changed) => onSeek(Number(changed.target.value))}
          aria-label="Scrub the run"
        />
        <span className="text-2xs tabular-nums text-muted-foreground">{max}</span>
      </div>
    </footer>
  );
}
