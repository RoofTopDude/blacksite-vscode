/**
 * The transport: a filmstrip, per-channel event lanes, and a playhead over an elapsed-time axis.
 *
 * Replaces a bare range input over sequence numbers. Sequence numbers are uniform and a run is
 * not — a four-second step and a four-millisecond one occupied identical width, so the old
 * scrubber conveyed nothing about where time actually went. Everything here is positioned by
 * elapsed nanoseconds (see timeline.ts), which is what makes it read like a media transport.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ObservationBundle, RunArtifact, RunEvent, RunFocus, RunStep, TraceOverview } from "../runs/protocol";
import {
  filmstripFrames,
  formatElapsed,
  framesToPrefetch,
  laneSegments,
  overviewExtent,
  overviewOrigin,
  offsetIn,
  panScale,
  sequenceAtOffset,
  stepSpans,
  timestampAtOffset,
  elapsedOf,
  zoomScale,
  type TimeScale,
} from "./timeline";

function severityTone(severity: string | undefined): string {
  if (severity === "error" || severity === "fatal") return "var(--s-err)";
  if (severity === "warning") return "var(--s-warn)";
  return "var(--s-info)";
}

/**
 * Decode frames near the playhead before they are needed.
 *
 * Assigning a `src` at scrub time means the browser starts a fetch+decode only once the frame is
 * already wanted, which is exactly the flash of nothing this is meant to remove. Constructing an
 * Image with the same URL warms the cache, so the later `<img>` paints from a decoded bitmap.
 */
function usePrefetchedFrames(urls: string[]): void {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const url of urls) {
      if (seen.current.has(url)) continue;
      seen.current.add(url);
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }, [urls]);
}

export function Timeline({
  events,
  steps,
  observations,
  artifacts,
  overview,
  playheadSequence,
  agentFocus,
  onSeek,
  onSeekTimestamp,
}: {
  events: RunEvent[];
  steps: RunStep[];
  observations: ObservationBundle[];
  artifacts: RunArtifact[];
  overview?: TraceOverview;
  playheadSequence: number;
  agentFocus?: RunFocus;
  onSeek: (sequenceNumber: number) => void;
  onSeekTimestamp: (timestampNs: string) => void;
}) {
  const duration = useMemo(() => overviewExtent(overview, events), [overview, events]);
  const [scale, setScale] = useState<TimeScale>({ from: 0, to: duration, duration });
  const trackRef = useRef<HTMLDivElement>(null);

  // Follow the run's growth while fully zoomed out; leave a zoomed window alone so the user's
  // chosen framing is not yanked out from under them by an incoming event.
  useEffect(() => {
    setScale((current) => (current.to >= current.duration
      ? { from: 0, to: duration, duration }
      : { ...current, duration }));
  }, [duration]);

  const origin = useMemo(() => overviewOrigin(overview, events), [overview, events]);
  const playheadNs = useMemo(() => {
    const event = events.find((candidate) => candidate.sequenceNumber === playheadSequence)
      ?? events.at(-1);
    return event ? elapsedOf(event, origin) ?? 0 : 0;
  }, [events, origin, playheadSequence]);

  const frames = useMemo(
    () => filmstripFrames(observations, events, artifacts, scale, origin),
    [observations, events, artifacts, scale, origin],
  );
  const lanes = useMemo(() => laneSegments(events, scale, origin), [events, scale, origin]);
  const spans = useMemo(() => stepSpans(steps, events, scale, origin), [steps, events, scale, origin]);
  const idleGaps = useMemo(() => events.slice(1).flatMap((event, index) => {
    const previous = events[index];
    if (!previous || origin === null) return [];
    const from = elapsedOf(previous, origin);
    const to = elapsedOf(event, origin);
    if (from === null || to === null || to - from <= 2_000_000_000) return [];
    const at = from + (to - from) / 2;
    return [{ id: `${previous.id}:${event.id}`, at, offset: offsetIn(scale, at), duration: to - from }];
  }), [events, origin, scale]);
  usePrefetchedFrames(useMemo(() => framesToPrefetch(frames, playheadNs), [frames, playheadNs]));

  const playheadOffset = scale.to > scale.from
    ? (playheadNs - scale.from) / (scale.to - scale.from)
    : 0;
  const agentEvent = agentFocus?.sequenceNumber === undefined
    ? undefined
    : events.find((event) => event.sequenceNumber === agentFocus.sequenceNumber);
  const agentAt = agentEvent ? elapsedOf(agentEvent, origin) : null;
  const agentOffset = agentAt === null ? null : offsetIn(scale, agentAt);

  const seekToOffset = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const offset = (clientX - rect.left) / rect.width;
    if (overview) {
      onSeekTimestamp(timestampAtOffset(overview, scale, offset));
      return;
    }
    const sequence = sequenceAtOffset(events, scale, offset);
    if (sequence !== null) onSeek(sequence);
  };

  const zoom = (factor: number) => setScale((current) => zoomScale(current, factor, playheadNs));

  return (
    <footer className="theater-timeline shrink-0 border-t border-border">
      <div className="theater-timeline-toolbar flex items-center gap-2 px-3 py-1.5">
        <span className="text-2xs tabular-nums text-muted-foreground">
          {formatElapsed(scale.from)} – {formatElapsed(scale.to)}
        </span>
        <span className="text-2xs text-muted-foreground">of {formatElapsed(duration)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-xs" variant="ghost" title="Zoom out" onClick={() => zoom(1 / 1.8)}>
            <ZoomOut className="size-3.5" />
          </Button>
          <Button size="icon-xs" variant="ghost" title="Zoom in" onClick={() => zoom(1.8)}>
            <ZoomIn className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            title="Fit the whole run"
            onClick={() => setScale({ from: 0, to: duration, duration })}
          >
            <Maximize className="size-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={trackRef}
        className="theater-timeline-track relative select-none"
        onPointerDown={(pointer) => {
          (pointer.target as Element).setPointerCapture?.(pointer.pointerId);
          seekToOffset(pointer.clientX);
        }}
        onPointerMove={(pointer) => { if (pointer.buttons === 1) seekToOffset(pointer.clientX); }}
        onWheel={(wheel) => {
          // Shift-wheel pans, plain wheel zooms — the convention every timeline editor uses.
          if (wheel.shiftKey) {
            setScale((current) => panScale(current, (current.to - current.from) * 0.08 * Math.sign(wheel.deltaY)));
          } else {
            zoom(wheel.deltaY < 0 ? 1.25 : 1 / 1.25);
          }
        }}
        role="slider"
        tabIndex={0}
        aria-label="Run timeline"
        aria-valuemin={0}
        aria-valuemax={events.at(-1)?.sequenceNumber ?? 0}
        aria-valuenow={playheadSequence}
        onKeyDown={(key) => {
          const index = events.findIndex((event) => event.sequenceNumber === playheadSequence);
          if (key.key === "ArrowRight" && index < events.length - 1) onSeek(events[index + 1]!.sequenceNumber);
          if (key.key === "ArrowLeft" && index > 0) onSeek(events[index - 1]!.sequenceNumber);
        }}
      >
        {/* Step bands: which step owned which stretch of time. */}
        {overview && (
          <div className="theater-density relative" aria-label="Full-run event density">
            {overview.segments.map((segment) => {
              const start = Number(BigInt(segment.firstMonotonicTimestampNs) - BigInt(overview.originMonotonicTimestampNs));
              const end = Number(BigInt(segment.lastMonotonicTimestampNs) - BigInt(overview.originMonotonicTimestampNs));
              const left = offsetIn(scale, start);
              const width = Math.max(0.002, offsetIn(scale, end) - left);
              const intensity = Math.min(1, Math.log2(segment.eventCount + 1) / 10);
              return (
                <div
                  key={`${segment.firstSequence}:${segment.lastSequence}`}
                  className="theater-density-segment"
                  style={{ left: `${left * 100}%`, width: `${width * 100}%`, opacity: 0.2 + intensity * 0.8 }}
                  title={`${segment.eventCount} events · ${segment.warningCount} warnings · ${segment.errorCount} errors`}
                />
              );
            })}
          </div>
        )}
        <div className="theater-steps relative">
          {spans.map((span) => (
            <div
              key={span.id}
              className={cn("theater-step-band", `is-${span.status}`)}
              style={{
                left: `${Math.max(0, span.startOffset) * 100}%`,
                width: `${Math.max(0.4, (Math.min(1, span.endOffset) - Math.max(0, span.startOffset))) * 100}%`,
              }}
              title={`${span.ordinal + 1}. ${span.title} — ${span.status}`}
            >
              <span className="truncate">{span.ordinal + 1}. {span.title}</span>
            </div>
          ))}
        </div>

        {/* Filmstrip: real captures at their real moments. */}
        <div className="theater-filmstrip relative">
          {frames.map((frame) => (
            <button
              key={frame.id}
              type="button"
              className={cn("theater-frame", frame.sequenceNumber === playheadSequence && "is-current")}
              style={{ left: `${frame.offset * 100}%` }}
              onClick={(clicked) => { clicked.stopPropagation(); onSeek(frame.sequenceNumber); }}
              title={`Capture at ${formatElapsed(frame.at)}`}
            >
              {frame.url
                ? <img src={frame.url} alt="" loading="eager" decoding="async" />
                : <span className="theater-frame-empty" aria-hidden />}
            </button>
          ))}
        </div>

        {/* One lane per channel. */}
        <div className="theater-lanes">
          {[...lanes.entries()].map(([channel, segments]) => (
            <div key={channel} className="theater-lane relative">
              <span className="theater-lane-label">{channel}</span>
              {segments.map((segment) => (
                <button
                  key={segment.id}
                  type="button"
                  className="theater-lane-mark"
                  style={{ left: `${segment.offset * 100}%`, background: severityTone(segment.severity) }}
                  onClick={(clicked) => { clicked.stopPropagation(); onSeek(segment.sequenceNumber); }}
                  title={`${segment.label} @ ${formatElapsed(segment.at)}`}
                />
              ))}
            </div>
          ))}
        </div>

        <div
          className="theater-playhead"
          style={{ left: `${Math.min(Math.max(playheadOffset, 0), 1) * 100}%` }}
          aria-hidden
        />
        {idleGaps.map((gap) => (
          <div key={gap.id} className="theater-idle-marker" style={{ left: `${gap.offset * 100}%` }}
            title={`Idle time skipped during replay · ${formatElapsed(gap.duration)}`}>
            <span>idle time skipped</span>
          </div>
        ))}
        {agentOffset !== null && (
          <div
            className="theater-agent-playhead"
            style={{ left: `${Math.min(Math.max(agentOffset, 0), 1) * 100}%` }}
            title={agentFocus?.reason}
            aria-label={`Agent focus: ${agentFocus?.reason ?? "retained evidence"}`}
          />
        )}
      </div>
    </footer>
  );
}
