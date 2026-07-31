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
  RunEvent,
  RunStep,
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
}

export interface TheaterErrorMessage {
  type: "theater_error";
  message: string;
}

export type TheaterHostMessage =
  | TheaterAttachMessage
  | TheaterDeltaMessage
  | TheaterWindowMessage
  | TheaterErrorMessage;

export type TheaterWebviewMessage =
  | { type: "theater_ready" }
  | { type: "theater_resync" }
  | { type: "theater_select_run"; runId: string }
  | { type: "theater_window"; runId: string; from: number; to: number }
  | { type: "theater_cancel" };

/** Shallow guard, matching the sidebar's `isRunsHostMessage` in shape and intent: enough to
 *  reject anything that is not ours, without pretending to validate the payload. */
export function isTheaterHostMessage(value: unknown): value is TheaterHostMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "theater_attach"
    || type === "theater_delta"
    || type === "theater_window"
    || type === "theater_error";
}
