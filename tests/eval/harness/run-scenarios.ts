/** Loads every trace and replays it under each arm, into fresh temp directories. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { BASELINE_ORCHESTRATION_FLAGS, SHADOW_ORCHESTRATION_FLAGS, type OrchestrationFlags } from "../../../src/orchestration/flags.js";
import { canonicalJson } from "./canonical.js";
import { replayLoop, type LoopReplay } from "./loop-driver.js";
import { replayPlanRun, type PlanRunReplay } from "./plan-run-driver.js";
import type { Arm } from "./scorecard.js";
import { parseTrace, type LoopTraceEvent, type LoopTraceHeader, type PlanRunTraceEvent, type PlanRunTraceHeader, type Trace } from "./trace.js";

export const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TRACE_DIR = path.join(EVAL_ROOT, "traces");
export const GOLDEN_DIR = path.join(EVAL_ROOT, "golden");

export interface ArmSpec {
  arm: Arm;
  flags: OrchestrationFlags;
}

/**
 * The arms every scenario replays under: today's behaviour; every flag at its shadow value at once
 * (records everything, must change nothing); and enforced work contracts. The work graph is on in
 * the observe arm because the shadow scheduler reads it; the graph itself changes no outcome.
 */
export const ARMS: readonly ArmSpec[] = [
  { arm: "baseline", flags: BASELINE_ORCHESTRATION_FLAGS },
  { arm: "observe", flags: { ...SHADOW_ORCHESTRATION_FLAGS, workGraph: true } },
  { arm: "enforce", flags: { ...BASELINE_ORCHESTRATION_FLAGS, workContracts: "enforce" } },
];

/** Arms a trace opts into by name (header `arms`), for additions that only some scenarios exercise. */
export const EXTRA_ARMS: Readonly<Record<string, ArmSpec>> = {
  "signals-act": { arm: "signals-act", flags: { ...BASELINE_ORCHESTRATION_FLAGS, workContracts: "observe", signals: "act" } },
  "scheduler-graph": { arm: "scheduler-graph", flags: { ...BASELINE_ORCHESTRATION_FLAGS, workGraph: true, scheduler: "graph" } },
};

export function armsFor(trace: Trace): ArmSpec[] {
  const extra = (trace.header.arms ?? []).map((name) => {
    const spec = EXTRA_ARMS[name];
    if (!spec) throw new Error(`${trace.header.scenario} asks for an unknown arm "${name}"`);
    return spec;
  });
  return [...ARMS, ...extra];
}

export function loadTraces(): Array<{ file: string; trace: Trace }> {
  return fs.readdirSync(TRACE_DIR)
    .filter((name) => name.endsWith(".trace.jsonl"))
    .sort()
    .map((name) => ({ file: name, trace: parseTrace(fs.readFileSync(path.join(TRACE_DIR, name), "utf8")) }));
}

export async function replay(trace: Trace, arm: ArmSpec): Promise<LoopReplay | PlanRunReplay> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${trace.header.scenario}-`));
  try {
    return trace.header.subject === "loop"
      ? await replayLoop(trace as Trace<LoopTraceHeader, LoopTraceEvent>, { dir, ...arm })
      : await replayPlanRun(trace as Trace<PlanRunTraceHeader, PlanRunTraceEvent>, { dir, ...arm });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function goldenPath(scenario: string, arm: Arm): string {
  return path.join(GOLDEN_DIR, `${scenario}.${arm}.json`);
}

/** Keys only shadow-mode additions write: receipts and contracts (#11), signals and what consumers
 *  would have done (#14), recorded scheduling decisions (#15). */
const SHADOW_RECORD_KEYS = [
  "receiptId", "receiptStatus", "contractId", "receiptIds", "receipts", "arm",
  "signals", "reconciliations", "reassessments", "schedulingDecisions", "scheduledBecause", "passedOver",
];

/**
 * The outcome with everything shadow modes add taken out: receipts, contract ids, the
 * abandoned-contract hook, signals, reconciliations and scheduling decisions. Shadow parity says
 * observe mode must equal baseline on this.
 */
export function withoutContractRecords(replay: LoopReplay | PlanRunReplay): unknown {
  const value = JSON.parse(canonicalJson(replay)) as Record<string, unknown>;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node
        .filter((entry) => !(entry && typeof entry === "object" && (entry as { hook?: unknown }).hook === "abandoned_contract"))
        .map(strip);
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) {
        if (SHADOW_RECORD_KEYS.includes(key)) continue;
        out[key] = strip(entry);
      }
      return out;
    }
    return node;
  };
  return strip(value);
}
