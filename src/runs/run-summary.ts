import {
  type ExecutionRun,
  type FailureEnvelope,
  type ObservationBundle,
  type ReplayabilityGrade,
  type RunEvent,
  type RunStep,
  type RunSummary,
} from "./run-model";

export interface BuildRunSummaryInput {
  run: ExecutionRun;
  steps: RunStep[];
  observations?: ObservationBundle[];
  events?: Iterable<RunEvent>;
  eventCount?: number;
  warningCount?: number;
  errorCount?: number;
  artifactCount?: number;
  replayability?: ReplayabilityGrade;
  failure?: FailureEnvelope;
  title?: string;
  anomalyTypes?: string[];
  keyFindings?: string[];
}

/**
 * Builds the compact summary persisted with a finalized run.
 *
 * Callers that retain high-volume traces should pass aggregate `eventCount` and
 * omit `events`; an iterable is accepted for small or already-windowed traces.
 */
export function buildRunSummary(input: BuildRunSummaryInput): RunSummary {
  let countedEvents = 0;
  let warningCount = 0;
  let errorCount = 0;
  if (input.events) {
    for (const event of input.events) {
      countedEvents += 1;
      if (event.severity === "warning") warningCount += 1;
      if (event.severity === "error" || event.severity === "fatal") errorCount += 1;
    }
  }

  const start = parseTimestamp(input.run.startedAt);
  const end = parseTimestamp(input.run.endedAt);
  return {
    ...(input.title ?? input.run.title ? { title: input.title ?? input.run.title } : {}),
    outcome: input.run.status,
    completedSteps: input.steps.filter((step) => step.status === "succeeded").length,
    totalSteps: input.steps.length,
    eventCount: input.eventCount ?? countedEvents,
    observationCount: input.observations?.length ?? 0,
    artifactCount: input.artifactCount ?? 0,
    warningCount: input.warningCount ?? warningCount,
    errorCount: input.errorCount ?? errorCount,
    replayability: input.replayability ?? "R0",
    ...(start !== undefined && end !== undefined && end >= start
      ? { durationMs: end - start }
      : {}),
    ...(input.anomalyTypes?.length
      ? { anomalyTypes: [...new Set(input.anomalyTypes)] }
      : {}),
    ...(input.keyFindings?.length ? { keyFindings: [...input.keyFindings] } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
  };
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
