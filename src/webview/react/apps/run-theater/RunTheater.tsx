/** Canonical editor-hosted workbench for retained execution evidence. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Bot, Camera, CircleSlash, GitCompareArrows, Map as MapIcon, Pause, Play, RefreshCw, Save, TicketPlus, TriangleAlert } from "lucide-react";
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
import { Timeline } from "./TimelineView";
import { replayDelayMs } from "./timeline";
import { InspectionReport } from "./InspectionReport";

const ACTIVE_STATUSES = new Set(["created", "validating", "awaiting_approval", "running"]);
const INSPECTOR_TABS = ["overview", "events", "console", "network", "state", "assertions", "artifacts"] as const;

function severityTone(severity: string | undefined): string | undefined {
  if (severity === "error" || severity === "fatal") return "var(--s-err)";
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
  const coverage = useMemo(() => (run ? runCoverage(run, state.steps) : undefined), [run, state.steps]);
  const runningStep = useMemo(() => state.steps.find((step) => step.status === "running"), [state.steps]);

  useReplay(state);
  useTransportShortcuts(state);

  if (state.loading) {
    return <div className="theater-root flex h-screen items-center justify-center"><span className="pulse-dot" /></div>;
  }
  if (!run) {
    return (
      <div className="theater-root flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm font-medium text-foreground">No run to show</div>
        <p className="max-w-sm text-xs text-muted-foreground">Execution runs appear here as the agent works.</p>
      </div>
    );
  }

  return (
    <div className="theater-root flex h-screen flex-col overflow-hidden">
      <header className="theater-header shrink-0 border-b border-border px-4 py-2">
        <PanelHeader
          eyebrow="Execution workbench"
          title={runTitle(run)}
          sub={(
            <span className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              {coverage && <span>{coverage.completed}/{coverage.total} steps</span>}
              <span>{formatRunDuration(run)}</span>
              <span>{state.overview?.eventCount ?? state.totalEvents} events</span>
              {state.overview && <span>{state.overview.warningCount} warnings · {state.overview.errorCount} errors</span>}
            </span>
          )}
          status={isActive
            ? { label: runningStep ? `Step ${runningStep.ordinal + 1}` : "Running", tone: "live", pulse: true }
            : { label: "Settled", tone: run.status === "succeeded" ? "ok" : "idle" }}
          actions={(
            <>
              <Button size="xs" variant={state.playing ? "secondary" : "ghost"} onClick={() => theaterActions.setPlaying(!state.playing)}>
                {state.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {state.playing ? "Pause" : "Play"}
              </Button>
              <select
                className="theater-rate"
                aria-label="Replay speed"
                value={state.playbackRate}
                onChange={(event) => theaterActions.setPlaybackRate(Number(event.target.value) as 0.5 | 1 | 2 | 4)}
              >
                {[0.5, 1, 2, 4].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
              </select>
              <Button size="xs" variant="ghost" onClick={() => theaterActions.askAgent()} title="Insert an evidence reference into chat">
                <Bot className="size-3.5" /> Ask Agent
              </Button>
              <Button size="xs" variant={state.followAgent ? "secondary" : "ghost"} onClick={() => theaterActions.setFollowAgent(!state.followAgent)} title={state.agentFocus?.reason ?? "Show the agent's evidence cursor without taking over your review"}>
                <Bot className="size-3.5" /> Follow Agent
              </Button>
              <Button size="xs" variant="ghost" onClick={() => theaterActions.keepRun()} title="Retain without changing a baseline">
                <Save className="size-3.5" /> Keep run
              </Button>
              <Button size="xs" variant="ghost" onClick={() => theaterActions.setBaseline()}>
                <Bookmark className="size-3.5" /> Set baseline
              </Button>
              <Button size="xs" variant="ghost" onClick={() => theaterActions.compareBaseline()}>
                <GitCompareArrows className="size-3.5" /> Compare
              </Button>
              <Button size="xs" variant="ghost" onClick={() => theaterActions.openMap()}><MapIcon className="size-3.5" /> Map</Button>
              {isActive && <Button size="xs" variant="ghost" onClick={() => theaterActions.cancel()}><CircleSlash className="size-3.5" /> Cancel</Button>}
            </>
          )}
        />
      </header>

      {state.reconnecting && (
        <div className="theater-banner flex items-center gap-2 px-4 py-1.5 text-xs" role="status">
          <RefreshCw className="size-3.5 animate-spin" /> Live tail gap detected — restoring a fresh tail.
        </div>
      )}
      {state.error && (
        <div className="theater-banner is-error flex items-center gap-2 px-4 py-1.5 text-xs" role="alert">
          <TriangleAlert className="size-3.5" /><span className="min-w-0 flex-1 truncate">{state.error}</span>
          <Button size="xs" variant="ghost" onClick={() => theaterActions.dismissError()}>Dismiss</Button>
        </div>
      )}

      <div className="theater-body grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(320px,38%)] overflow-hidden">
        {state.comparison
          ? <ComparisonStage />
          : <Stage
              frames={frames}
              observationId={observation?.id}
              runningLabel={runningStep ? eventLabel({ channel: "action", type: runningStep.declaredAction?.type ?? "step" } as never) : undefined}
            />}
        <Inspector />
      </div>

      <Timeline
        events={state.events}
        steps={state.steps}
        observations={state.observations}
        artifacts={state.artifacts}
        overview={state.overview}
        agentFocus={state.agentFocus}
        playheadSequence={state.playheadSequence}
        onSeek={(value) => theaterActions.seek(value)}
        onSeekTimestamp={(value) => theaterActions.seekTimestamp(value)}
      />
    </div>
  );
}

function useReplay(state: ReturnType<typeof useTheaterStore>): void {
  useEffect(() => {
    if (!state.playing) return;
    const index = Math.max(0, state.events.findIndex((event) => event.sequenceNumber >= state.playheadSequence));
    const current = state.events[index];
    const next = state.events[index + 1];
    if (!current || !next) { theaterActions.setPlaying(false); return; }
    const delay = replayDelayMs(current.monotonicTimestampNs, next.monotonicTimestampNs, state.playbackRate);
    const timer = window.setTimeout(() => theaterActions.seek(next.sequenceNumber), delay);
    return () => window.clearTimeout(timer);
  }, [state.playing, state.playbackRate, state.playheadSequence, state.events]);
}

function useTransportShortcuts(state: ReturnType<typeof useTheaterStore>): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const index = Math.max(0, state.events.findIndex((candidate) => candidate.sequenceNumber >= state.playheadSequence));
      if (event.code === "Space") {
        event.preventDefault(); theaterActions.setPlaying(!state.playing); return;
      }
      if (event.key === "End") { event.preventDefault(); theaterActions.setFollowing(true); return; }
      if (event.key === "Home" && state.events[0]) { event.preventDefault(); theaterActions.seek(state.events[0].sequenceNumber); return; }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const candidates = event.shiftKey ? state.events.filter(isAnomalyEvent) : state.events;
      const candidate = event.key === "ArrowRight"
        ? candidates.find((item) => item.sequenceNumber > state.playheadSequence)
        : [...candidates].reverse().find((item) => item.sequenceNumber < state.playheadSequence);
      if (candidate) theaterActions.seek(candidate.sequenceNumber);
      else if (!event.shiftKey && event.key === "ArrowRight" && state.events[index]) theaterActions.seek(state.events[index].sequenceNumber);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.events, state.playheadSequence, state.playing]);
}

function Stage({ frames, observationId, runningLabel }: {
  frames: Array<{ id: string; url?: string; mediaType?: string; metadata?: Record<string, unknown> }>;
  observationId?: string;
  runningLabel?: string;
}) {
  const video = frames.find((frame) => frame.mediaType?.startsWith("video/"));
  const frame = frames.find((candidate) => candidate.mediaType?.startsWith("image/"));
  const [zoomed, setZoomed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const retention = video?.metadata?.["videoRetention"] as Record<string, unknown> | undefined;
  const preserved = retention?.["preserved"] === true;

  const flagFrame = () => {
    const element = videoRef.current;
    if (!video || !observationId || !element || !element.videoWidth || !element.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext("2d")?.drawImage(element, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    theaterActions.flagVideoFrame(video.id, observationId, Math.round(element.currentTime * 1_000), dataUrl);
  };
  return (
    <main className={cn("theater-stage relative flex min-h-0 items-center justify-center overflow-hidden", zoomed && "is-zoomed")}>
      {video?.url
        ? <>
            <video ref={videoRef} className="theater-stage-image" src={video.url} controls preload="metadata" aria-label="Recorded browser evidence" />
            <div className="absolute right-3 top-3 flex gap-2">
              <Button size="xs" variant="secondary" onClick={flagFrame} disabled={!observationId} title="Retain the current video frame for later agent review">
                <Camera className="size-3.5" /> Flag frame
              </Button>
              <Button size="xs" variant={preserved ? "secondary" : "ghost"} onClick={() => theaterActions.preserveArtifact(video.id, !preserved)}>
                <Save className="size-3.5" /> {preserved ? "Preserved" : "Preserve video"}
              </Button>
            </div>
          </>
        : frame?.url
        ? <button type="button" className="theater-stage-zoom" onClick={() => setZoomed(!zoomed)} title={zoomed ? "Fit artifact" : "Zoom artifact"}><img className="theater-stage-image" src={frame.url} alt="Captured application state at the playhead" decoding="async" /></button>
        : <p className="px-6 text-center text-xs text-muted-foreground">No visual capture at this point. The last real observation is held between captures.</p>}
      {runningLabel && <div className="theater-nowline absolute inset-x-0 bottom-0 truncate px-4 py-1.5 text-xs">{runningLabel}</div>}
    </main>
  );
}

function ComparisonStage() {
  const state = useTheaterStore();
  const alignment = state.comparison?.alignments.find((candidate) =>
    candidate.right?.events.some((event) => event.sequenceNumber === state.playheadSequence))
    ?? state.comparison?.alignments[0];
  const left = alignment?.left?.artifacts.find((artifact) => artifact.mediaType?.startsWith("image/"))?.url;
  const right = alignment?.right?.artifacts.find((artifact) => artifact.mediaType?.startsWith("image/"))?.url;
  return (
    <main className="theater-stage theater-comparison-stage relative grid min-h-0 overflow-hidden">
      <div className="theater-comparison-modes">
        {(["two-up", "wipe", "overlay", "heatmap"] as const).map((mode) => (
          <button key={mode} type="button" className={cn(state.comparisonMode === mode && "is-active")}
            onClick={() => theaterActions.setComparisonMode(mode)}>{mode}</button>
        ))}
      </div>
      {state.comparisonEnvironmentMismatch && <div className="theater-comparison-warning">Environment fingerprint differs; comparison remains available.</div>}
      <div className={cn("theater-compare-visual", `is-${state.comparisonMode}`)}>
        {left && <img className="is-baseline" src={left} alt="Baseline capture" />}
        {right && <img className="is-current" src={right} alt="Current capture" />}
        {!left && !right && <p className="text-xs text-muted-foreground">This alignment has no visual artifacts. Candidate differences remain in the inspector.</p>}
      </div>
    </main>
  );
}

function Inspector() {
  const state = useTheaterStore();
  const [note, setNote] = useState("");
  const selectedEvent = state.events.find((event) => event.sequenceNumber === state.playheadSequence);
  const filtered = state.events.filter((event) => {
    if (state.inspectorTab === "console") return event.channel === "log" || event.channel === "diagnostic";
    if (state.inspectorTab === "network") return event.channel === "network";
    if (state.inspectorTab === "state") return event.channel === "state" || event.channel === "filesystem";
    if (state.inspectorTab === "assertions") return event.channel === "assertion";
    if (state.inspectorTab === "artifacts") return event.channel === "artifact" || event.channel === "visual";
    return true;
  });
  const nearby = state.annotations.filter((annotation) => {
    const sequence = annotation.anchor.sequenceNumber;
    return sequence === undefined || Math.abs(sequence - state.playheadSequence) <= 5;
  });

  return (
    <aside className="theater-inspector grid min-h-0 grid-rows-[auto_1fr] overflow-hidden border-l border-border">
      <div className="theater-inspector-tabs" role="tablist" aria-label="Evidence inspector">
        {INSPECTOR_TABS.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={state.inspectorTab === tab}
            className={cn("theater-inspector-tab", state.inspectorTab === tab && "is-active")}
            onClick={() => theaterActions.setInspectorTab(tab)}>
            {tab === "state" ? "State/Files" : tab}
          </button>
        ))}
      </div>
      <div className="theater-inspector-content min-h-0 overflow-y-auto">
        {state.inspectorTab === "overview" && state.inspection && (
          <InspectionReport report={state.inspection} onSeek={(sequence) => theaterActions.seek(sequence)} />
        )}
        {state.inspectorTab === "overview" && state.comparison && (
          <section className="theater-candidate-differences p-3">
            <h2>Candidate differences</h2>
            <p>{state.comparison.summary?.changed ?? 0} changed · {state.comparison.summary?.added ?? 0} added · {state.comparison.summary?.removed ?? 0} removed</p>
            {(state.comparison.alignments[0]?.changes ?? []).map((change, index) => (
              <div key={`${change.channel}:${index}`} data-kind={change.kind}><span>{change.channel}</span>{change.summary}</div>
            ))}
          </section>
        )}
        {state.inspectorTab === "overview" && !state.inspection && (
          <div className="p-4 text-xs text-muted-foreground">Verdict, effects, failed assertions, and recommended review points appear when the run settles.</div>
        )}
        {state.inspectorTab === "network"
          ? <NetworkWaterfall events={filtered} />
          : state.inspectorTab !== "overview" && <EventStream events={filtered} playhead={state.playheadSequence} />}
        {selectedEvent && state.inspectorTab !== "overview" && (
          <pre className="theater-payload">{JSON.stringify(selectedEvent.inlinePayload ?? {}, null, 2)}</pre>
        )}
        {selectedEvent && isAnomalyEvent(selectedEvent) && (
          <div className="px-3 pb-2"><Button size="xs" variant="outline" onClick={() => theaterActions.fileAnomaly()}><TicketPlus className="size-3" /> File anomaly ticket</Button></div>
        )}
        <div className="theater-annotations border-t border-border p-3">
          <div className="mb-2 text-2xs uppercase tracking-wide text-muted-foreground">Shared annotations near this moment</div>
          {nearby.map((annotation) => (
            <div key={annotation.id} className="theater-annotation"><span>{annotation.kind.replace("_", " ")}</span><p>{annotation.body}</p></div>
          ))}
          <form className="mt-2 flex gap-1" onSubmit={(event) => {
            event.preventDefault(); theaterActions.annotate(note); setNote("");
          }}>
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note at this moment" aria-label="Annotation text" />
            <Button size="xs" type="submit" disabled={!note.trim()}>Add</Button>
          </form>
        </div>
      </div>
    </aside>
  );
}

function NetworkWaterfall({ events }: { events: ReturnType<typeof useTheaterStore>["events"] }) {
  const responses = events.flatMap((event) => {
    if (!event.type.endsWith("response") && !event.type.endsWith("request_failed")) return [];
    const payload = event.inlinePayload && typeof event.inlinePayload === "object"
      ? event.inlinePayload as Record<string, unknown> : {};
    const duration = Number(payload["durationMs"] ?? 0);
    return [{ event, payload, duration: Number.isFinite(duration) ? Math.max(0, duration) : 0 }];
  });
  const maximum = Math.max(1, ...responses.map((item) => item.duration));
  if (responses.length === 0) return <div className="p-4 text-xs text-muted-foreground">No correlated request completion evidence in this window.</div>;
  return (
    <div className="theater-waterfall" aria-label="Sanitized network waterfall">
      {responses.map(({ event, payload, duration }) => (
        <button key={event.id} type="button" onClick={() => theaterActions.seek(event.sequenceNumber)}>
          <span className="theater-waterfall-name">{String(payload["method"] ?? "GET")} {String(payload["url"] ?? payload["requestId"] ?? event.id)}</span>
          <span className="theater-waterfall-track"><i style={{ width: `${Math.max(2, duration / maximum * 100)}%` }} /></span>
          <span className="theater-waterfall-duration">{duration.toFixed(duration < 10 ? 1 : 0)}ms</span>
        </button>
      ))}
    </div>
  );
}

function EventStream({ events, playhead }: { events: ReturnType<typeof useTheaterStore>["events"]; playhead: number }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (events.at(-1)?.sequenceNumber === playhead) endRef.current?.scrollIntoView({ block: "end" });
  }, [events, playhead]);
  return (
    <div className="theater-stream min-h-0 overflow-y-auto" role="log" aria-label="Evidence events">
      {events.map((event) => (
        <button key={event.id} type="button" onClick={() => theaterActions.seek(event.sequenceNumber)}
          className={cn("theater-stream-row w-full text-left", isAnomalyEvent(event) && "is-anomaly", event.sequenceNumber === playhead && "is-current")}
          style={{ ["--row-tone" as string]: severityTone(event.severity) }}>
          <span className="theater-stream-seq tabular-nums">{event.sequenceNumber}</span>
          <span className="theater-stream-channel">{event.channel}</span>
          <span className="theater-stream-label truncate">{eventLabel(event)}</span>
        </button>
      ))}
      <div ref={endRef} />
    </div>
  );
}
