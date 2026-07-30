import type {
  ExecutionRun,
  ObservationBundle,
  RunArtifact,
  RunEvent,
  RunEventChannel,
  RunStep,
} from "./protocol";

export const DEFAULT_EVENT_WINDOW_SIZE = 240;

export interface RunCoverage {
  completed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface EventTrack {
  channel: RunEventChannel;
  label: string;
  events: RunEvent[];
}

export interface NavigationAnchor {
  id: string;
  kind: "anomaly" | "checkpoint";
  sequenceNumber: number;
  label: string;
  eventId?: string;
  stepId?: string;
  observationId?: string;
}

const TRACK_ORDER: RunEventChannel[] = [
  "visual",
  "action",
  "log",
  "application_event",
  "network",
  "state",
  "diagnostic",
  "assertion",
  "metric",
  "filesystem",
  "artifact",
];

function normalizedType(type: string): string {
  return type.replace(/[_:.-]+/g, " ").trim();
}

export function humanize(value: string): string {
  const normalized = normalizedType(value);
  if (!normalized) return "Unknown";
  return normalized.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function runTitle(run: ExecutionRun): string {
  return run.title
    || run.summary?.title
    || run.target?.label
    || run.branchName
    || `Run ${run.id}`;
}

export function runCoverage(run: ExecutionRun, steps: RunStep[] = []): RunCoverage {
  const matching = steps.filter((step) => step.runId === run.id);
  if (matching.length > 0) {
    return {
      completed: matching.filter((step) => step.status === "succeeded").length,
      failed: matching.filter((step) => step.status === "failed").length,
      skipped: matching.filter((step) => step.status === "skipped" || step.status === "cancelled").length,
      total: matching.length,
    };
  }
  return {
    completed: Math.max(0, run.summary?.completedSteps ?? 0),
    failed: run.summary?.failure ? 1 : 0,
    skipped: 0,
    total: Math.max(0, run.summary?.totalSteps ?? run.stepIds?.length ?? 0),
  };
}

export function windowAround(
  sequenceNumber: number,
  totalEvents: number,
  size = DEFAULT_EVENT_WINDOW_SIZE,
): { from: number; to: number } {
  const safeTotal = Math.max(0, Math.floor(totalEvents));
  if (safeTotal === 0) return { from: 0, to: 0 };
  const safeSize = Math.max(1, Math.min(Math.floor(size), safeTotal));
  const maximumStart = Math.max(1, safeTotal - safeSize + 1);
  const centeredStart = Math.floor(sequenceNumber - safeSize / 2);
  const from = Math.min(maximumStart, Math.max(1, centeredStart));
  return { from, to: Math.min(safeTotal, from + safeSize - 1) };
}

export function eventWindowFromEvents(events: RunEvent[], totalEvents: number): { from: number; to: number } {
  if (events.length === 0) return windowAround(0, totalEvents);
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const event of events) {
    from = Math.min(from, event.sequenceNumber);
    to = Math.max(to, event.sequenceNumber);
  }
  return { from: Number.isFinite(from) ? from : 0, to };
}

export function observationForSequence(
  observations: ObservationBundle[],
  sequenceNumber: number,
): ObservationBundle | undefined {
  const exact = observations.find((observation) =>
    sequenceNumber >= observation.eventRange.firstSequenceNumber
      && sequenceNumber <= observation.eventRange.lastSequenceNumber);
  if (exact) return exact;
  let nearest: ObservationBundle | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const observation of observations) {
    const distance = Math.abs(observation.cursor.sequenceNumber - sequenceNumber);
    if (distance < nearestDistance) {
      nearest = observation;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function eventsForObservation(
  observation: ObservationBundle | undefined,
  events: RunEvent[],
): RunEvent[] {
  if (!observation) return [];
  return events.filter((event) =>
    event.runId === observation.runId
      && event.sequenceNumber >= observation.eventRange.firstSequenceNumber
      && event.sequenceNumber <= observation.eventRange.lastSequenceNumber);
}

export function buildEventTracks(events: RunEvent[]): EventTrack[] {
  const grouped = new Map<RunEventChannel, RunEvent[]>();
  for (const event of events) {
    const group = grouped.get(event.channel);
    if (group) group.push(event);
    else grouped.set(event.channel, [event]);
  }
  const channels = [...grouped.keys()].sort((left, right) => {
    const leftIndex = TRACK_ORDER.indexOf(left);
    const rightIndex = TRACK_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
  return channels.map((channel) => ({
    channel,
    label: humanize(channel),
    events: [...(grouped.get(channel) ?? [])].sort((left, right) => left.sequenceNumber - right.sequenceNumber),
  }));
}

export function isAnomalyEvent(event: RunEvent): boolean {
  if (event.severity === "warning" || event.severity === "error" || event.severity === "fatal") return true;
  const marker = `${event.channel}:${event.type}`.toLowerCase();
  return marker.includes("anomaly")
    || marker.includes("exception")
    || marker.includes("assertion_failure")
    || marker.includes("request_failed");
}

/** Diagnostics are ticketable even at info severity; adapters often emit the
 * structured failure envelope separately from the severity-bearing event. */
export function isTicketableEvent(event: RunEvent): boolean {
  return event.channel === "diagnostic"
    || event.channel === "assertion"
    || isAnomalyEvent(event);
}

function relatedObservation(
  observations: ObservationBundle[],
  sequenceNumber: number,
): string | undefined {
  return observationForSequence(observations, sequenceNumber)?.id;
}

export function navigationAnchors(
  steps: RunStep[],
  observations: ObservationBundle[],
  events: RunEvent[],
): NavigationAnchor[] {
  const anchors: NavigationAnchor[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    const isCheckpoint = event.type.toLowerCase().includes("checkpoint");
    if (!isCheckpoint && !isAnomalyEvent(event)) continue;
    const kind = isCheckpoint ? "checkpoint" : "anomaly";
    const id = `${kind}:event:${event.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    anchors.push({
      id,
      kind,
      sequenceNumber: event.sequenceNumber,
      label: humanize(event.type),
      eventId: event.id,
      stepId: event.stepId,
      observationId: relatedObservation(observations, event.sequenceNumber),
    });
  }

  for (const step of steps) {
    if (step.checkpointId) {
      const sequenceNumber = step.endCursor?.sequenceNumber
        ?? step.startCursor?.sequenceNumber
        ?? observations.find((observation) => observation.stepId === step.id)?.cursor.sequenceNumber
        ?? 0;
      const id = `checkpoint:step:${step.id}:${step.checkpointId}`;
      if (!seen.has(id)) {
        seen.add(id);
        anchors.push({
          id,
          kind: "checkpoint",
          sequenceNumber,
          label: `Checkpoint ${step.ordinal + 1}`,
          stepId: step.id,
          observationId: relatedObservation(observations, sequenceNumber),
        });
      }
    }
    if (step.status === "failed") {
      const sequenceNumber = step.endCursor?.sequenceNumber
        ?? step.startCursor?.sequenceNumber
        ?? observations.find((observation) => observation.stepId === step.id)?.cursor.sequenceNumber
        ?? 0;
      const id = `anomaly:step:${step.id}`;
      if (!seen.has(id)) {
        seen.add(id);
        anchors.push({
          id,
          kind: "anomaly",
          sequenceNumber,
          label: step.failure?.message || `Failed step ${step.ordinal + 1}`,
          stepId: step.id,
          observationId: relatedObservation(observations, sequenceNumber),
        });
      }
    }
  }

  return anchors.sort((left, right) =>
    left.sequenceNumber - right.sequenceNumber || left.id.localeCompare(right.id));
}

export function nextAnchor(
  anchors: NavigationAnchor[],
  kind: NavigationAnchor["kind"],
  sequenceNumber: number,
  direction: 1 | -1,
): NavigationAnchor | undefined {
  const matching = anchors.filter((anchor) => anchor.kind === kind);
  if (matching.length === 0) return undefined;
  if (direction === 1) {
    return matching.find((anchor) => anchor.sequenceNumber > sequenceNumber) ?? matching[0];
  }
  return [...matching].reverse().find((anchor) => anchor.sequenceNumber < sequenceNumber)
    ?? matching[matching.length - 1];
}

export function artifactById(artifacts: RunArtifact[], id: string): RunArtifact | undefined {
  return artifacts.find((artifact) => artifact.id === id);
}

export function visualArtifactsForObservation(
  observation: ObservationBundle | undefined,
  artifacts: RunArtifact[],
): RunArtifact[] {
  if (!observation) return [];
  return observation.visualArtifactIds
    .map((id) => artifactById(artifacts, id))
    .filter((artifact): artifact is RunArtifact => Boolean(artifact));
}

export function eventLabel(event: RunEvent): string {
  const payload = event.inlinePayload;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "label", "url", "path", "name"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return humanize(event.type);
}

export function formatRunDuration(run: ExecutionRun): string {
  const duration = run.summary?.durationMs
    ?? (run.startedAt && run.endedAt
      ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
      : undefined);
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return "—";
  if (duration < 1_000) return `${Math.round(duration)}ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(duration >= 10_000 ? 0 : 1)}s`;
  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.round((duration % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
