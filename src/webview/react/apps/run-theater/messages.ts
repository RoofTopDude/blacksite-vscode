/**
 * The theater's own message union.
 *
 * Deliberately separate from apps/runs/protocol.ts's `RunsHostMessage`: the sidebar can never
 * receive these, and widening its union would force `isRunsHostMessage` to reason about messages
 * that will never arrive. The *domain* types are shared from there — this file only describes the
 * envelope.
 */
import type {
  ExecutionRun,
  ObservationBundle,
  RunArtifact,
  RunAnnotation,
  RunComparison,
  RunEvent,
  RunFocus,
  RunStep,
  TraceOverview,
} from "../runs/protocol";

/** Where the run's trace stands, mirroring RunWatermark in src/runs/run-store.ts. */
export interface RunWatermark {
  lastSequenceNumber: number;
  eventCount: number;
  warningCount: number;
  errorCount: number;
}

/** A complete baseline. Every attach carries a fresh `generation`; deltas stamped with an older
 *  one are stale and must be discarded. */
export interface TheaterAttachMessage {
  type: "theater_attach";
  runId: string;
  generation: number;
  run: ExecutionRun;
  steps: RunStep[];
  observations: ObservationBundle[];
  artifacts: RunArtifact[];
  overview: TraceOverview;
  annotations: RunAnnotation[];
  /** Bounded live tail. It is never the source of full-run geometry. */
  events: RunEvent[];
  totalEvents: number;
  watermark: RunWatermark;
}

/** An incremental update. `droppedBefore` means the host truncated an oversized burst and the
 *  events start there rather than where the client left off. */
export interface TheaterDeltaMessage {
  type: "theater_delta";
  runId: string;
  generation: number;
  events: RunEvent[];
  droppedBefore?: number;
  steps?: RunStep[];
  observations?: ObservationBundle[];
  artifacts?: RunArtifact[];
  run?: ExecutionRun;
  watermark?: RunWatermark;
}

/** Reply to a scrub into history — the one read path that goes back to disk. */
export interface TheaterWindowMessage {
  type: "theater_window";
  runId: string;
  generation: number;
  events: RunEvent[];
  from: number;
  to: number;
  totalEvents: number;
  /** Exact event selected by the host after resolving a timestamp or stable sequence anchor. */
  anchorSequence?: number;
}

export interface TheaterFocusMessage {
  type: "theater_agent_focus";
  focus: RunFocus;
}

export interface TheaterAnnotationsMessage {
  type: "theater_annotations";
  runId: string;
  annotations: RunAnnotation[];
}

export interface TheaterComparisonMessage {
  type: "theater_comparison";
  runId: string;
  comparison: RunComparison;
  environmentMismatch: boolean;
}

/** Post-run report: what the run touched, and whether it matched what it promised. Mirrors
 *  InspectionReport in src/runs/run-inspection.ts. */
export interface TheaterInspectionMessage {
  type: "theater_inspection";
  runId: string;
  report: InspectionReport;
}

export interface InspectionReport {
  runId: string;
  verdict: string;
  dirty: boolean;
  blastRadius: Array<{
    class: string;
    count: number;
    irreversibleCount: number;
    entities: Array<{ scheme: string; id: string; workspacePath?: string }>;
    descriptions: string[];
  }>;
  promise?: { asDeclared: string[]; beyondDeclaration: string[]; neverHappened: string[] };
  evidence: Array<{
    kind: "assertion" | "diagnostic" | "anomaly";
    label: string;
    detail?: string;
    severity?: string;
    stepId?: string;
    sequenceNumber?: number;
    eventId?: string;
  }>;
  perspectives: Array<{
    observationId: string;
    sequenceNumber: number;
    frameCount: number;
    artifactIds: string[];
  }>;
}

export interface TheaterErrorMessage {
  type: "theater_error";
  message: string;
}

export type TheaterHostMessage =
  | TheaterAttachMessage
  | TheaterDeltaMessage
  | TheaterWindowMessage
  | TheaterFocusMessage
  | TheaterAnnotationsMessage
  | TheaterComparisonMessage
  | TheaterInspectionMessage
  | TheaterErrorMessage;

export type TheaterWebviewMessage =
  | { type: "theater_ready" }
  | { type: "theater_resync" }
  | { type: "theater_select_run"; runId: string }
  | { type: "theater_window"; runId: string; from: number; to: number }
  | { type: "theater_seek"; runId: string; sequenceNumber?: number; monotonicTimestampNs?: string }
  | { type: "theater_ask_agent"; runId: string; sequenceNumber: number; eventId?: string; observationId?: string }
  | { type: "theater_annotate"; runId: string; body: string; kind: RunAnnotation["kind"]; sequenceNumber: number; eventId?: string; observationId?: string; stepId?: string }
  | { type: "theater_keep_run"; runId: string }
  | { type: "theater_set_baseline"; runId: string }
  | { type: "theater_compare_baseline"; runId: string }
  | { type: "theater_open_map"; runId: string; sequenceNumber: number }
  | { type: "theater_file_anomaly"; runId: string; eventId?: string; observationId?: string }
  | { type: "theater_preserve_artifact"; runId: string; artifactId: string; preserved: boolean }
  | { type: "theater_flag_video_frame"; runId: string; artifactId: string; observationId: string; sequenceNumber: number; timeMs: number; dataUrl: string }
  | { type: "theater_cancel" };

/** Shallow guard, matching the sidebar's `isRunsHostMessage` in shape and intent: enough to
 *  reject anything that is not ours, without pretending to validate the payload. */
export function isTheaterHostMessage(value: unknown): value is TheaterHostMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "theater_attach"
    || type === "theater_delta"
    || type === "theater_window"
    || type === "theater_agent_focus"
    || type === "theater_annotations"
    || type === "theater_comparison"
    || type === "theater_inspection"
    || type === "theater_error";
}
