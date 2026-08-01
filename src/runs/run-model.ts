/**
 * Provider- and adapter-neutral contracts for retained execution runs.
 *
 * Sequence numbers are safe JavaScript integers assigned by the extension host and
 * are the canonical total order. Nanosecond timestamps are decimal strings because
 * SQLite and JSON cannot safely round-trip nanosecond values as JavaScript numbers.
 */

export type DecimalNanoseconds = string;

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

export type TerminalRunStatus =
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RunRetentionClass = "temporary" | "standard" | "pinned";

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

/** Adapters may emit a namespaced channel such as `adapter:three-d.geometry`. */
export type RunEventChannel = CoreRunEventChannel | `adapter:${string}`;

export type CaptureProfileId = string;

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export type EntityRefScheme =
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
  /** A desktop application driven by a run, identified by executable path — the same value its
   *  allow-list entry is keyed on. See src/sequences/desktop-adapter.ts. */
  | "external-app"
  | "artifact";

export interface EntityRef {
  scheme: EntityRefScheme;
  id: string;
  workspacePath?: string;
  range?: TextRange;
  label?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A core target intentionally carries only stable identity. Adapter-specific
 * configuration belongs in `configuration`, not in new core fields.
 */
export interface SequenceTarget {
  adapterId: string;
  type: string;
  id?: string;
  label?: string;
  workspacePath?: string;
  configuration?: Record<string, unknown>;
}

export interface SequenceAction {
  type: string;
  adapterId?: string;
  input?: Record<string, unknown>;
}

export interface ResolvedSequenceAction extends SequenceAction {
  resolvedTarget?: EntityRef;
  resolutionMetadata?: Record<string, unknown>;
}

export interface SequenceStepDefinition {
  id?: string;
  title?: string;
  action: SequenceAction;
  /** Empty/omitted in the linear MVP; retained so later DAG compilation is additive. */
  dependsOn?: string[];
  preconditions?: SequenceAssertion[];
  assertions?: SequenceAssertion[];
  captureProfile?: CaptureProfileId;
  checkpoint?: boolean | string;
}

export interface SequenceAssertion {
  type: string;
  input?: Record<string, unknown>;
  severity?: "warning" | "error";
}

export type SequenceFailurePolicy = "stop" | "continue" | "continue_safe";

export interface SequenceLimits {
  maxSteps: number;
  timeoutMs: number;
  maxEvents?: number;
  maxArtifactBytes?: number;
}

export interface SequenceDefinition {
  id?: string;
  title: string;
  target: SequenceTarget;
  steps: SequenceStepDefinition[];
  captureProfile?: CaptureProfileId;
  failurePolicy: SequenceFailurePolicy;
  limits: SequenceLimits;
  planId?: string;
  phaseId?: string;
  ticketIds?: string[];
  parentRunId?: string;
  baselineRunId?: string;
}

export interface RunCursor {
  sequenceNumber: number;
  monotonicTimestampNs?: DecimalNanoseconds;
  eventId?: string;
}

export type SideEffectClass =
  | "none"
  | "workspace_read"
  | "workspace_write"
  | "process"
  | "network_read"
  | "network_write"
  | "external_mutation"
  | "destructive";

export interface SideEffectRecord {
  id: string;
  class: SideEffectClass;
  description: string;
  entityRefs: EntityRef[];
  reversible: boolean;
  metadata?: Record<string, unknown>;
}

export interface AssertionResult {
  assertionType: string;
  passed: boolean;
  message?: string;
  severity?: "warning" | "error";
  entityRefs?: EntityRef[];
  metadata?: Record<string, unknown>;
}

export type FailureCategory =
  | "precondition"
  | "approval_denied"
  | "timeout"
  | "application_error"
  | "assertion_failure"
  | "permission"
  | "resource_limit"
  | "adapter_error"
  | "environment"
  | "cancelled"
  | "unknown";

export type RunRecoverability =
  | "resume_supported"
  | "restart_required"
  | "manual_intervention"
  | "not_recoverable";

export interface FailureEnvelope {
  category: FailureCategory;
  message: string;
  failedStepId: string;
  lastSuccessfulStepId?: string;
  lastCheckpointId?: string;
  diagnosticObservationId: string;
  relatedEventIds: string[];
  completedSideEffects: SideEffectRecord[];
  unexecutedStepIds: string[];
  recoverability: RunRecoverability;
}

export interface RunStep {
  id: string;
  runId: string;
  ordinal: number;
  declaredAction: SequenceAction;
  /** Original dependency contract retained so a logical resume cannot erase ordering semantics. */
  dependsOnStepIds?: string[];
  /** Original post-action assertions retained so a resumed action is judged identically. */
  declaredAssertions?: SequenceAssertion[];
  resolvedAction?: ResolvedSequenceAction;
  targetEntityRefs: EntityRef[];
  status: RunStepStatus;
  startCursor?: RunCursor;
  endCursor?: RunCursor;
  beforeObservationId?: string;
  afterObservationId?: string;
  assertionResults: AssertionResult[];
  sideEffects: SideEffectRecord[];
  checkpointId?: string;
  failure?: FailureEnvelope;
}

export interface EventSource {
  adapterId: string;
  producer: string;
  instanceId?: string;
  sourceTimestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface RunEvent {
  id: string;
  runId: string;
  stepId?: string;
  laneId?: string;
  sequenceNumber: number;
  monotonicTimestampNs: DecimalNanoseconds;
  wallClockTimestamp: string;
  channel: RunEventChannel;
  type: string;
  severity?: RunEventSeverity;
  source: EventSource;
  entityRefs: EntityRef[];
  causalParentId?: string;
  inlinePayload?: unknown;
  payloadArtifactId?: string;
}

/** Fields supplied by an event producer; ordering fields are always host-assigned. */
export type RunEventInput = Omit<
  RunEvent,
  "id" | "runId" | "sequenceNumber" | "monotonicTimestampNs" | "wallClockTimestamp"
> & {
  id?: string;
  runId?: string;
  wallClockTimestamp?: string;
};

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
  captureProfile: CaptureProfileId;
  previousObservationDiffId?: string;
}

export type ReplayabilityGrade = "R0" | "R1" | "R2" | "R3";

export interface RunSummary {
  title?: string;
  outcome: TerminalRunStatus | RunStatus;
  completedSteps: number;
  totalSteps: number;
  eventCount: number;
  observationCount: number;
  artifactCount: number;
  warningCount: number;
  errorCount: number;
  replayability: ReplayabilityGrade;
  durationMs?: number;
  anomalyTypes?: string[];
  keyFindings?: string[];
  failure?: FailureEnvelope;
  metadata?: Record<string, unknown>;
}

export interface ExecutionRun {
  id: string;
  /** Human-readable sequence title, retained independently of adapter target labels. */
  title?: string;
  sequenceId: string;
  sequenceVersion: number;
  status: RunStatus;
  target: SequenceTarget;
  adapterIds: string[];
  parentRunId?: string;
  baselineRunId?: string;
  branchName?: string;
  planId?: string;
  phaseId?: string;
  ticketIds: string[];
  codeFingerprint?: string;
  workspaceFingerprint: string;
  environmentFingerprint: string;
  startedAt?: string;
  endedAt?: string;
  stepIds: string[];
  checkpointIds: string[];
  keyObservationIds: string[];
  summary?: RunSummary;
  retentionClass: RunRetentionClass;
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  stepId?: string;
  cursor: RunCursor;
  name?: string;
  artifactIds: string[];
  replayability: ReplayabilityGrade;
  metadata?: Record<string, unknown>;
}

export interface RunArtifact {
  id: string;
  sha256: string;
  byteLength: number;
  mediaType?: string;
  kind?: string;
  fileName?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface StoredRunArtifact extends RunArtifact {
  runId: string;
  role?: string;
  stepId?: string;
  observationId?: string;
}

export interface RunSearchQuery {
  status?: RunStatus | RunStatus[];
  retentionClass?: RunRetentionClass;
  planId?: string;
  phaseId?: string;
  ticketId?: string;
  parentRunId?: string;
  filePath?: string;
  surfaceId?: string;
  adapterId?: string;
  anomalyType?: string;
  startedAfter?: string;
  startedBefore?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface RunSearchResult {
  runs: ExecutionRun[];
  matched: number;
  nextOffset?: number;
}

export interface ReadEventsOptions {
  fromSequence?: number;
  toSequence?: number;
  fromMonotonicTimestampNs?: DecimalNanoseconds;
  toMonotonicTimestampNs?: DecimalNanoseconds;
  channels?: RunEventChannel[];
  limit?: number;
}

export interface FinalizeRunInput {
  status: TerminalRunStatus;
  summary?: RunSummary;
  endedAt?: string;
}

export interface RunRetentionPolicy {
  temporaryOlderThan: string;
  standardOlderThan?: string;
  maxRuns?: number;
  /** Runs referenced by active plans/tickets are retained even when their age or count would prune them. */
  protectedRunIds?: string[];
}

export interface RunRetentionResult {
  deletedRunIds: string[];
  deletedArtifactIds: string[];
  freedArtifactBytes: number;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Cursor ordering deliberately ignores producer and wall-clock timestamps. */
export function compareRunCursors(left: RunCursor, right: RunCursor): number {
  return left.sequenceNumber - right.sequenceNumber;
}

export function cursorForEvent(event: RunEvent): RunCursor {
  return {
    sequenceNumber: event.sequenceNumber,
    monotonicTimestampNs: event.monotonicTimestampNs,
    eventId: event.id,
  };
}
