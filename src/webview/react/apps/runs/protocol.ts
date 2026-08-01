/**
 * Run Explorer protocol.
 *
 * The extension host owns all retained run data. The webview receives a compact
 * run snapshot plus one bounded event window and only keeps UI selection state
 * locally. Sequence numbers are the canonical timeline order.
 */

export type RunStatus =
  | "created"
  | "validating"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RunStepStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type RunEventSeverity = "debug" | "info" | "warning" | "error" | "fatal";

export type CoreRunEventChannel =
  | "action"
  | "visual"
  | "log"
  | "application_event"
  | "network"
  | "state"
  | "filesystem"
  | "diagnostic"
  | "assertion"
  | "metric"
  | "artifact";

export type RunEventChannel = CoreRunEventChannel | `adapter:${string}`;
export type RunRetentionClass = "temporary" | "standard" | "pinned";

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface EntityRef {
  scheme:
    | "workspace-file"
    | "code-symbol"
    | "dom-node"
    | "ui-component"
    | "route"
    | "browser-request"
    | "process"
    | "test"
    | "scene"
    | "scene-object"
    | "mesh"
    | "material"
    | "external-app"
    | "artifact";
  id: string;
  workspacePath?: string;
  range?: TextRange;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface RunCursor {
  sequenceNumber: number;
  monotonicTimestampNs?: string;
  eventId?: string;
}

/** Side effects a step performed, mirroring `SideEffectRecord` in src/runs/run-model.ts.
 *  `reversible: false` is the field that answers "is my workspace dirty right now?". */
export interface SideEffectRecord {
  id: string;
  class:
    | "none" | "workspace_read" | "external_read" | "workspace_write" | "process"
    | "network_read" | "network_write" | "external_mutation" | "destructive";
  description: string;
  entityRefs: EntityRef[];
  reversible: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunFailure {
  category: string;
  message: string;
  failedStepId: string;
  lastSuccessfulStepId?: string;
  lastCheckpointId?: string;
  diagnosticObservationId?: string;
  relatedEventIds?: string[];
  /** Effects that had already landed when the run failed — the ones still in the workspace. */
  completedSideEffects?: SideEffectRecord[];
  unexecutedStepIds?: string[];
  recoverability?: string;
}

export interface RunSummary {
  title?: string;
  outcome?: RunStatus;
  completedSteps: number;
  totalSteps: number;
  eventCount: number;
  observationCount: number;
  artifactCount: number;
  warningCount: number;
  errorCount: number;
  replayability?: "R0" | "R1" | "R2" | "R3";
  durationMs?: number;
  anomalyTypes?: string[];
  keyFindings?: string[];
  failure?: RunFailure;
  metadata?: Record<string, unknown>;
}

export interface ExecutionRun {
  id: string;
  title?: string;
  sequenceId?: string;
  sequenceVersion?: number;
  status: RunStatus;
  target?: {
    adapterId?: string;
    type?: string;
    id?: string;
    label?: string;
    workspacePath?: string;
    configuration?: Record<string, unknown>;
  };
  adapterIds?: string[];
  parentRunId?: string;
  baselineRunId?: string;
  branchName?: string;
  planId?: string;
  phaseId?: string;
  ticketIds?: string[];
  codeFingerprint?: string;
  workspaceFingerprint?: string;
  environmentFingerprint?: string;
  startedAt?: string;
  endedAt?: string;
  stepIds?: string[];
  checkpointIds?: string[];
  keyObservationIds?: string[];
  summary?: RunSummary;
  retentionClass: RunRetentionClass;
}

export interface AssertionResult {
  assertionType: string;
  passed: boolean;
  message?: string;
  severity?: "warning" | "error";
  entityRefs?: EntityRef[];
  metadata?: Record<string, unknown>;
}

export interface RunStep {
  id: string;
  runId: string;
  ordinal: number;
  title?: string;
  declaredAction?: {
    type: string;
    adapterId?: string;
    input?: Record<string, unknown>;
  };
  targetEntityRefs: EntityRef[];
  status: RunStepStatus;
  startCursor?: RunCursor;
  endCursor?: RunCursor;
  beforeObservationId?: string;
  afterObservationId?: string;
  assertionResults: AssertionResult[];
  /** What this step actually did to the world. The host has always posted these — `_postState`
   *  sends `getSteps()` verbatim — but the field was missing here, so the blast-radius data was
   *  arriving in the webview and being discarded by a type declaration. */
  sideEffects: SideEffectRecord[];
  checkpointId?: string;
  failure?: RunFailure;
}

export interface RunEvent {
  id: string;
  runId: string;
  stepId?: string;
  laneId?: string;
  sequenceNumber: number;
  monotonicTimestampNs?: string;
  wallClockTimestamp?: string;
  channel: RunEventChannel;
  type: string;
  severity?: RunEventSeverity;
  source?: {
    adapterId?: string;
    producer?: string;
    instanceId?: string;
    sourceTimestamp?: string;
    metadata?: Record<string, unknown>;
  };
  entityRefs: EntityRef[];
  causalParentId?: string;
  inlinePayload?: unknown;
  payloadArtifactId?: string;
}

export interface ObservationBundle {
  id: string;
  runId: string;
  stepId?: string;
  cursor: RunCursor;
  visualArtifactIds: string[];
  structuralArtifactIds: string[];
  stateArtifactIds: string[];
  eventRange: {
    firstSequenceNumber: number;
    lastSequenceNumber: number;
  };
  entityRefs: EntityRef[];
  stateDigest?: string;
  captureProfile?: string;
  previousObservationDiffId?: string;
}

/**
 * URLs are webview-safe URIs produced by the host. A thumbnail may be included
 * in the initial state; the full URL is only attached to the selected
 * observation/comparison so the webview does not eagerly decode every image.
 */
export interface RunArtifact {
  id: string;
  runId?: string;
  observationId?: string;
  stepId?: string;
  role?: string;
  kind?: string;
  mediaType?: string;
  fileName?: string;
  byteLength?: number;
  createdAt?: string;
  thumbnailUrl?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

/** Coarse, full-run geometry. Detailed events are fetched separately in bounded windows. */
export interface TraceSegmentSummary {
  firstSequence: number;
  lastSequence: number;
  firstMonotonicTimestampNs: string;
  lastMonotonicTimestampNs: string;
  eventCount: number;
  warningCount: number;
  errorCount: number;
  channelCounts: Partial<Record<RunEventChannel, number>>;
}

export interface TraceOverview {
  runId: string;
  firstSequence: number;
  lastSequence: number;
  originMonotonicTimestampNs: string;
  endMonotonicTimestampNs: string;
  eventCount: number;
  warningCount: number;
  errorCount: number;
  segments: TraceSegmentSummary[];
}

export type RunAnnotationKind = "note" | "finding" | "decision" | "false_positive";
export type RunAnnotationStatus = "open" | "accepted" | "dismissed";

export interface RunAnnotation {
  id: string;
  runId: string;
  kind: RunAnnotationKind;
  status: RunAnnotationStatus;
  body: string;
  author: "user" | "agent";
  anchor: {
    sequenceNumber?: number;
    stepId?: string;
    eventId?: string;
    observationId?: string;
    entity?: EntityRef;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RunFocus {
  runId: string;
  source: "agent" | "user";
  reason: string;
  sequenceNumber?: number;
  eventId?: string;
  observationId?: string;
  stepId?: string;
  updatedAt: string;
}

export interface RunComparisonChange {
  channel: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  summary: string;
  severity?: RunEventSeverity;
}

export interface RunComparisonSide {
  runId: string;
  step?: RunStep;
  observation?: ObservationBundle;
  events: RunEvent[];
  artifacts: RunArtifact[];
}

export interface RunComparisonAlignment {
  id: string;
  label: string;
  confidence?: number;
  left?: RunComparisonSide;
  right?: RunComparisonSide;
  changes: RunComparisonChange[];
}

export interface RunComparison {
  leftRunId: string;
  rightRunId: string;
  summary?: {
    changed: number;
    added: number;
    removed: number;
    unchanged?: number;
    findings?: string[];
  };
  alignments: RunComparisonAlignment[];
}

export type RunsHostMessage =
  | {
      type: "runs_state";
      runs: ExecutionRun[];
      selectedRun?: ExecutionRun;
      steps: RunStep[];
      observations: ObservationBundle[];
      events: RunEvent[];
      totalEvents: number;
      artifacts: RunArtifact[];
    }
  | {
      type: "run_event_window";
      runId: string;
      events: RunEvent[];
      totalEvents: number;
      from: number;
      to: number;
    }
  | {
      type: "run_comparison";
      comparison: RunComparison;
    }
  | {
      type: "run_error";
      message: string;
      operation?: RunsWebviewMessage["type"];
      runId?: string;
    };

export type RunsWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "select_run"; runId: string }
  | { type: "request_event_window"; runId: string; from: number; to: number }
  | { type: "select_observation"; runId: string; observationId: string }
  | { type: "compare_runs"; leftRunId: string; rightRunId: string }
  | { type: "pin_run"; runId: string; pinned: boolean }
  | { type: "open_workbench"; runId: string }
  | { type: "cancel_run"; runId: string }
  | { type: "file_anomaly_ticket"; runId: string; eventId?: string; observationId?: string }
  | { type: "open_entity"; entity: EntityRef }
  | {
      type: "open_on_map";
      runId: string;
      sequenceNumber?: number;
      entity?: EntityRef;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]);
}

/** A deliberately shallow boundary guard; detailed data remains host-owned. */
export function isRunsHostMessage(value: unknown): value is RunsHostMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "runs_state":
      return hasArray(value, "runs")
        && hasArray(value, "steps")
        && hasArray(value, "observations")
        && hasArray(value, "events")
        && hasArray(value, "artifacts")
        && typeof value.totalEvents === "number";
    case "run_event_window":
      return hasString(value, "runId")
        && hasArray(value, "events")
        && typeof value.totalEvents === "number"
        && typeof value.from === "number"
        && typeof value.to === "number";
    case "run_comparison":
      return isRecord(value.comparison) && Array.isArray(value.comparison.alignments);
    case "run_error":
      return hasString(value, "message");
    default:
      return false;
  }
}
