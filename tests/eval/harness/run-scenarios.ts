/** Loads every trace and replays it under each arm, into fresh temp directories. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import type { WorkContractsMode } from "../../../src/orchestration/flags.js";
import { canonicalJson } from "./canonical.js";
import { replayLoop, type LoopReplay } from "./loop-driver.js";
import { replayPlanRun, type PlanRunReplay } from "./plan-run-driver.js";
import type { Arm } from "./scorecard.js";
import { parseTrace, type LoopTraceEvent, type LoopTraceHeader, type PlanRunTraceEvent, type PlanRunTraceHeader, type Trace } from "./trace.js";

export const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TRACE_DIR = path.join(EVAL_ROOT, "traces");
export const GOLDEN_DIR = path.join(EVAL_ROOT, "golden");

/** The arms every scenario replays under: today's behaviour, shadow mode, and enforcement. */
export const ARMS: ReadonlyArray<{ arm: Arm; workContracts: WorkContractsMode }> = [
  { arm: "baseline", workContracts: "off" },
  { arm: "observe", workContracts: "observe" },
  { arm: "enforce", workContracts: "enforce" },
];

export function loadTraces(): Array<{ file: string; trace: Trace }> {
  return fs.readdirSync(TRACE_DIR)
    .filter((name) => name.endsWith(".trace.jsonl"))
    .sort()
    .map((name) => ({ file: name, trace: parseTrace(fs.readFileSync(path.join(TRACE_DIR, name), "utf8")) }));
}

export async function replay(trace: Trace, arm: { arm: Arm; workContracts: WorkContractsMode }): Promise<LoopReplay | PlanRunReplay> {
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

/**
 * The outcome with everything work contracts add taken out: receipts, contract ids and the
 * abandoned-contract hook. Shadow parity says observe mode must equal baseline on this.
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
        if (["receiptId", "receiptStatus", "contractId", "receiptIds", "receipts", "arm"].includes(key)) continue;
        out[key] = strip(entry);
      }
      return out;
    }
    return node;
  };
  return strip(value);
}
