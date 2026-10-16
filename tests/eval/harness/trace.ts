/**
 * Synthetic orchestration traces (JSONL).
 *
 * Line 1 is a header naming the subject (a ticket loop or a plan run) and seeding it; every other
 * line is an event at a virtual time. Replays feed these into the real LoopSupervisor and
 * PlanRunService — only the model, the lanes and the user are scripted — so what is tested is the
 * orchestration state machine as it ships. See docs/orchestration-p0-implementation-plan.md §4.2.
 *
 * Traces are synthetic: written by hand or generated, never copied from a user's project.
 */

import type { LoopCeilings, LoopQueueSpec, LoopWorkerSpec } from "../../../src/loops/loop-model.js";
import type { LoopDispatchResult } from "../../../src/loops/loop-supervisor.js";
import type { PlanStepStatus, StepEvidence } from "../../../src/planning-store.js";
import type { ReceiptStatus } from "../../../src/orchestration/work-receipt.js";

export interface TraceTicket {
  id: string;
  title?: string;
  complexity?: "small" | "medium" | "large";
  priority?: "urgent" | "high" | "normal" | "low";
  files?: string[];
  areas?: string[];
  blockedBy?: string[];
  acceptanceCriteria?: string[];
}

export interface LoopTraceHeader {
  trace: 1;
  scenario: string;
  subject: "loop";
  description: string;
  setup: {
    tickets: TraceTicket[];
    loop: { title?: string; queue?: Partial<LoopQueueSpec>; workers?: Partial<LoopWorkerSpec>; ceilings?: Partial<LoopCeilings> };
  };
}

export interface PlanRunTraceHeader {
  trace: 1;
  scenario: string;
  subject: "plan_run";
  description: string;
  setup: {
    plan: { id?: string; title?: string; phases: Array<{ id: string; title?: string; files?: string[]; steps: Array<{ id: string; title?: string }> }> };
    charter?: Record<string, unknown>;
  };
}

export type TraceHeader = LoopTraceHeader | PlanRunTraceHeader;

/** A scripted lane: what the lane for `ticket`'s `attempt`-th dispatch returns, and when. */
export interface LaneEvent {
  op: "lane";
  ticket: string;
  attempt: number;
  durationMs: number;
  /** [ms after the lane starts, usd] — fed to the supervisor as live spend. */
  spend?: Array<[number, number]>;
  result: Partial<LoopDispatchResult> & { ok: boolean };
  /** The receipt the lane would carry when work contracts are on. Ignored while they are off. */
  receipt?: ReceiptStatus;
}

export type LoopUserAction = "start" | "resume" | "pause" | "stop" | "release";

export type LoopTraceEvent =
  | LaneEvent
  | { op: "user"; at: number; action: LoopUserAction; ticket?: string }
  | { op: "crash"; at: number }
  | { op: "verifier"; subject: string; result: "pass" | "fail" };

export type PlanRunTraceEvent =
  | { op: "start"; at: number }
  | {
    op: "turn";
    at: number;
    origin?: "run" | "conductor" | "resume" | "user";
    durationMs?: number;
    /** [phaseId, stepId, status] in the order the turn made them. */
    moves?: Array<[string, string, PlanStepStatus]>;
    evidence?: Record<string, StepEvidence>;
    spend?: number;
    stopReason?: string;
    errorMessage?: string;
    toolFailures?: Array<[string, string]>;
    events?: Array<{ type: string; [key: string]: unknown }>;
  }
  | { op: "defer"; at: number; id: string; description: string; tier?: string }
  | { op: "answer"; at: number; decision: string; status: "approved" | "declined" | "answered" }
  | { op: "conductor"; at: number; decision: "continue" | "halt" | "ask"; rationale: string }
  | { op: "user"; at: number; action: "pause" | "resume" | "stop" }
  | { op: "crash"; at: number }
  | { op: "verifier"; subject: string; result: "pass" | "fail" };

export interface Trace<H extends TraceHeader = TraceHeader, E = LoopTraceEvent | PlanRunTraceEvent> {
  header: H;
  events: E[];
}

export function parseTrace(text: string): Trace {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("//"));
  if (lines.length === 0) throw new Error("empty trace");
  const header = JSON.parse(lines[0]!) as TraceHeader;
  if (header.trace !== 1) throw new Error(`unsupported trace version ${String((header as { trace?: unknown }).trace)}`);
  if (header.subject !== "loop" && header.subject !== "plan_run") throw new Error("trace subject must be loop or plan_run");
  return { header, events: lines.slice(1).map((line, index) => {
    try {
      return JSON.parse(line) as LoopTraceEvent | PlanRunTraceEvent;
    } catch (error) {
      throw new Error(`trace line ${index + 2}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }) };
}

/** The independent verdicts a trace records (D6: never the agent's own account). */
export function verdicts(events: ReadonlyArray<LoopTraceEvent | PlanRunTraceEvent>): Map<string, "pass" | "fail"> {
  const out = new Map<string, "pass" | "fail">();
  for (const event of events) if (event.op === "verifier") out.set(event.subject, event.result);
  return out;
}
