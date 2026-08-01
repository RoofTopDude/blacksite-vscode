/**
 * Timeline geometry, kept pure and out of the component.
 *
 * The transport this replaces was a bare `<input type="range">` over sequence numbers. That is
 * the wrong axis for a trace: sequence numbers are uniform, but a run is not — a step that took
 * four seconds and one that took four milliseconds occupied the same width, so the scrubber told
 * you nothing about where time actually went. Everything here works in *elapsed nanoseconds* from
 * the run's first event and projects onto a viewport, which is what makes the result read like a
 * media transport rather than a list index.
 */
import type { ObservationBundle, RunEvent, RunStep, TraceOverview } from "../runs/protocol";

/** Nanoseconds, as a number. A run would have to last ~104 days before this loses integer
 *  precision, so the BigInt the store persists is unnecessary once we are relative to t0. */
export type ElapsedNs = number;

export interface TimeScale {
  /** Elapsed ns at the left edge of the viewport. */
  from: ElapsedNs;
  /** Elapsed ns at the right edge. */
  to: ElapsedNs;
  /** Full extent of the run, independent of zoom. */
  duration: ElapsedNs;
}

export interface Marker {
  id: string;
  at: ElapsedNs;
  /** 0..1 across the current viewport. Outside that range means off-screen. */
  offset: number;
}

export interface FilmstripFrame extends Marker {
  observationId: string;
  artifactId?: string;
  url?: string;
  sequenceNumber: number;
}

export interface LaneSegment extends Marker {
  channel: string;
  severity?: string;
  label: string;
  sequenceNumber: number;
}

export interface StepSpan {
  id: string;
  ordinal: number;
  title: string;
  status: string;
  startOffset: number;
  endOffset: number;
}

/** Parse the store's decimal-string nanosecond stamp. Returns null rather than 0 for anything
 *  unparseable — 0 would silently pin an event to the start of the run. */
export function parseNs(value: string | undefined): ElapsedNs | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Elapsed-time origin: the *earliest* stamp in the batch, which everything else is measured from.
 *
 * Deliberately a minimum rather than "the first element". Events normally arrive in sequence
 * order, but nothing in the pipeline guarantees it — a merged delta or a re-read window can be
 * ordered differently — and taking the first element there would put the origin *after* some
 * events, clamping them all to zero and silently collapsing the whole timeline.
 */
export function timeOrigin(events: RunEvent[]): ElapsedNs | null {
  let earliest: ElapsedNs | null = null;
  for (const event of events) {
    const at = parseNs(event.monotonicTimestampNs);
    if (at === null) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

export function elapsedOf(event: RunEvent, origin: ElapsedNs | null): ElapsedNs | null {
  if (origin === null) return null;
  const at = parseNs(event.monotonicTimestampNs);
  return at === null ? null : Math.max(0, at - origin);
}

/** Total extent of the run in elapsed ns. Falls back to 1 so a zero-length run still divides. */
export function runExtent(events: RunEvent[]): ElapsedNs {
  const origin = timeOrigin(events);
  if (origin === null) return 1;
  let last = 0;
  for (const event of events) {
    const elapsed = elapsedOf(event, origin);
    if (elapsed !== null && elapsed > last) last = elapsed;
  }
  return Math.max(1, last);
}

/** Full-run extent from the host-owned segment overview, independent of the loaded detail. */
export function overviewExtent(overview: TraceOverview | undefined, events: RunEvent[] = []): ElapsedNs {
  if (!overview) return runExtent(events);
  const origin = parseNs(overview.originMonotonicTimestampNs);
  const end = parseNs(overview.endMonotonicTimestampNs);
  if (origin === null || end === null) return runExtent(events);
  return Math.max(1, end - origin);
}

export function overviewOrigin(overview: TraceOverview | undefined, events: RunEvent[]): ElapsedNs | null {
  return parseNs(overview?.originMonotonicTimestampNs) ?? timeOrigin(events);
}

/** Convert a viewport fraction into the absolute monotonic timestamp understood by the host. */
export function timestampAtOffset(
  overview: TraceOverview,
  scale: TimeScale,
  offset: number,
): string {
  const origin = BigInt(overview.originMonotonicTimestampNs);
  const clamped = Math.min(Math.max(offset, 0), 1);
  const elapsed = Math.round(scale.from + (scale.to - scale.from) * clamped);
  return String(origin + BigInt(elapsed));
}

/** Project an elapsed time onto 0..1 across the visible window. */
export function offsetIn(scale: TimeScale, at: ElapsedNs): number {
  const span = scale.to - scale.from;
  if (span <= 0) return 0;
  return (at - scale.from) / span;
}

/**
 * Zoom around a focal point, keeping whatever is under the playhead where it is.
 *
 * Zooming to the centre instead is the small detail that makes a timeline feel wrong: the thing
 * you were looking at slides away exactly when you try to look closer.
 */
export function zoomScale(scale: TimeScale, factor: number, focus: ElapsedNs): TimeScale {
  const span = scale.to - scale.from;
  const nextSpan = Math.min(scale.duration, Math.max(scale.duration / 5000, span / factor));
  const ratio = span > 0 ? (focus - scale.from) / span : 0.5;
  let from = focus - nextSpan * ratio;
  let to = from + nextSpan;
  if (from < 0) { from = 0; to = nextSpan; }
  if (to > scale.duration) { to = scale.duration; from = Math.max(0, to - nextSpan); }
  return { from, to, duration: scale.duration };
}

/** Slide the window without changing its span, clamped to the run. */
export function panScale(scale: TimeScale, byNs: ElapsedNs): TimeScale {
  const span = scale.to - scale.from;
  let from = scale.from + byNs;
  if (from < 0) from = 0;
  if (from + span > scale.duration) from = Math.max(0, scale.duration - span);
  return { from, to: from + span, duration: scale.duration };
}

/**
 * Frames for the filmstrip, one per observation that has a visual artifact.
 *
 * An observation carries a cursor (a sequence number), not a timestamp, so its position comes
 * from the event it points at. Observations whose event is outside the loaded window are dropped
 * rather than guessed at — a frame in the wrong place is worse than a missing one, because it
 * makes the strip lie about when something was captured.
 */
export function filmstripFrames(
  observations: ObservationBundle[],
  events: RunEvent[],
  artifacts: Array<{ id: string; url?: string; mediaType?: string }>,
  scale: TimeScale,
  originOverride?: ElapsedNs | null,
): FilmstripFrame[] {
  const origin = originOverride === undefined ? timeOrigin(events) : originOverride;
  if (origin === null) return [];
  const bySequence = new Map<number, RunEvent>();
  for (const event of events) bySequence.set(event.sequenceNumber, event);
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  const frames: FilmstripFrame[] = [];
  for (const observation of observations) {
    const anchor = bySequence.get(observation.cursor.sequenceNumber);
    const cursorAt = parseNs(observation.cursor.monotonicTimestampNs);
    const at = anchor
      ? elapsedOf(anchor, origin)
      : cursorAt !== null && origin !== null ? Math.max(0, cursorAt - origin) : null;
    if (at === null) continue;

    const artifactId = observation.visualArtifactIds[0];
    const artifact = artifactId ? artifactById.get(artifactId) : undefined;
    frames.push({
      id: `frame:${observation.id}`,
      observationId: observation.id,
      sequenceNumber: observation.cursor.sequenceNumber,
      at,
      offset: offsetIn(scale, at),
      ...(artifactId ? { artifactId } : {}),
      ...(artifact?.url ? { url: artifact.url } : {}),
    });
  }
  return frames.sort((left, right) => left.at - right.at);
}

/** Which frame URLs to decode ahead of time: the ones near the playhead in either direction, so
 *  scrubbing lands on an already-decoded image instead of a flash of nothing. */
export function framesToPrefetch(
  frames: FilmstripFrame[],
  playheadNs: ElapsedNs,
  radius = 6,
): string[] {
  if (frames.length === 0) return [];
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const distance = Math.abs(frame.at - playheadNs);
    if (distance < best) { best = distance; nearest = index; }
  });
  const first = Math.max(0, nearest - radius);
  const last = Math.min(frames.length - 1, nearest + radius);
  const urls: string[] = [];
  for (let i = first; i <= last; i += 1) {
    const url = frames[i]?.url;
    if (url) urls.push(url);
  }
  return urls;
}

/** Events positioned within the viewport, grouped by channel — one lane per channel. */
export function laneSegments(
  events: RunEvent[],
  scale: TimeScale,
  originOverride?: ElapsedNs | null,
): Map<string, LaneSegment[]> {
  const origin = originOverride === undefined ? timeOrigin(events) : originOverride;
  const lanes = new Map<string, LaneSegment[]>();
  if (origin === null) return lanes;

  for (const event of events) {
    const at = elapsedOf(event, origin);
    if (at === null) continue;
    const offset = offsetIn(scale, at);
    // Keep a little beyond each edge so a marker partially in view still renders.
    if (offset < -0.05 || offset > 1.05) continue;
    const lane = lanes.get(event.channel) ?? [];
    lane.push({
      id: event.id,
      at,
      offset,
      channel: event.channel,
      ...(event.severity ? { severity: event.severity } : {}),
      label: event.type,
      sequenceNumber: event.sequenceNumber,
    });
    lanes.set(event.channel, lane);
  }
  return lanes;
}

/** Step extents projected onto the viewport, so the ruler shows which step owns which stretch of
 *  time. A step still running has no end cursor and is drawn to the right edge. */
export function stepSpans(
  steps: RunStep[],
  events: RunEvent[],
  scale: TimeScale,
  originOverride?: ElapsedNs | null,
): StepSpan[] {
  const origin = originOverride === undefined ? timeOrigin(events) : originOverride;
  if (origin === null) return [];
  const bySequence = new Map<number, RunEvent>();
  for (const event of events) bySequence.set(event.sequenceNumber, event);

  const elapsedAt = (sequenceNumber: number | undefined): ElapsedNs | null => {
    if (sequenceNumber === undefined) return null;
    const event = bySequence.get(sequenceNumber);
    return event ? elapsedOf(event, origin) : null;
  };

  const elapsedAtCursor = (cursor: RunStep["startCursor"]): ElapsedNs | null => {
    if (!cursor || origin === null) return null;
    const cursorAt = parseNs(cursor.monotonicTimestampNs);
    return cursorAt === null ? elapsedAt(cursor.sequenceNumber) : Math.max(0, cursorAt - origin);
  };

  const spans: StepSpan[] = [];
  for (const step of steps) {
    const start = elapsedAtCursor(step.startCursor);
    if (start === null) continue;
    const end = elapsedAtCursor(step.endCursor) ?? scale.duration;
    spans.push({
      id: step.id,
      ordinal: step.ordinal,
      title: step.title || step.declaredAction?.type || `Step ${step.ordinal + 1}`,
      status: step.status,
      startOffset: offsetIn(scale, start),
      endOffset: offsetIn(scale, Math.max(end, start)),
    });
  }
  return spans;
}

/** Human-readable elapsed label for the ruler. */
export function formatElapsed(ns: ElapsedNs): string {
  const ms = ns / 1_000_000;
  if (ms < 1) return `${Math.round(ns / 1000)}µs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** Adaptive replay delay. Long idle periods are explicit but consume only 500ms. */
export function replayDelayMs(fromTimestampNs: string | undefined, toTimestampNs: string | undefined, rate: number): number {
  const from = parseNs(fromTimestampNs);
  const to = parseNs(toTimestampNs);
  if (from === null || to === null) return 16;
  const gapMs = Math.max(0, (to - from) / 1_000_000);
  if (gapMs > 2_000) return 500;
  return Math.max(16, gapMs / Math.max(0.5, rate));
}

/** Nearest event sequence to a viewport fraction — how a click on the timeline becomes a seek. */
export function sequenceAtOffset(events: RunEvent[], scale: TimeScale, offset: number): number | null {
  const origin = timeOrigin(events);
  if (origin === null || events.length === 0) return null;
  const target = scale.from + (scale.to - scale.from) * Math.min(Math.max(offset, 0), 1);
  let bestSequence: number | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const at = elapsedOf(event, origin);
    if (at === null) continue;
    const distance = Math.abs(at - target);
    if (distance < best) { best = distance; bestSequence = event.sequenceNumber; }
  }
  return bestSequence;
}
