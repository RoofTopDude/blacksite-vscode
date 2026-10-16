/**
 * The live evaluation hook: runs one scenario in the real extension and exports what happened.
 *
 * Registered only when the Extension Development Host is launched with BLACKSITE_EVAL=1 by
 * tests/integration/eval/run.mjs. Normal activation never sees the command. It drives the same
 * LoopSupervisor and PlanRunService a user does — there is no separate evaluation loop — and
 * writes the ledgers and receipts to `.blacksite/eval/result.json` for the launcher to score
 * against its independent verifier. See docs/orchestration-p0-implementation-plan.md §4.5.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { LoopStore } from "../loops/loop-store.js";
import type { LoopSupervisor } from "../loops/loop-supervisor.js";
import type { PlanRunService } from "../plans/plan-run-service.js";
import { ReceiptStore } from "../orchestration/receipt-store.js";
import type { WorkContractsMode } from "../orchestration/flags.js";
import { SecretStore } from "../secret-store.js";

export const EVAL_COMMAND = "blacksite.eval.runScenario";

export interface EvalScenarioInput {
  subject: "loop" | "plan_run";
  arm: string;
  workContracts: WorkContractsMode;
  timeoutMs: number;
  loop?: { title: string; ticketIds: string[]; concurrency?: number; maxUsd?: number };
  plan?: { planId: string; charter?: Record<string, unknown> };
  /** provider → API key, stored in this throwaway profile's secret storage. */
  credentials?: Record<string, string>;
}

export interface EvalDeps {
  workspaceRoot: string;
  loops: LoopStore;
  loopSupervisor: LoopSupervisor;
  planRuns: PlanRunService;
  secrets: vscode.SecretStorage;
}

export function registerEvalCommands(deps: EvalDeps): vscode.Disposable | undefined {
  if (process.env.BLACKSITE_EVAL !== "1") return undefined;
  return vscode.commands.registerCommand(EVAL_COMMAND, (input: EvalScenarioInput) => runScenario(deps, input));
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return done();
}

async function runScenario(deps: EvalDeps, input: EvalScenarioInput): Promise<string> {
  const secrets = new SecretStore(deps.secrets);
  for (const [provider, key] of Object.entries(input.credentials ?? {})) await secrets.setApiKey(provider, key);
  await vscode.workspace.getConfiguration().update("blacksite.orchestration.workContracts", input.workContracts, vscode.ConfigurationTarget.Workspace);
  const startedAt = Date.now();
  let timedOut = false;
  let loop: unknown;
  let planRun: unknown;

  if (input.subject === "loop" && input.loop) {
    const record = deps.loops.create({
      title: input.loop.title,
      queue: { ids: input.loop.ticketIds },
      workers: { concurrency: input.loop.concurrency ?? 1 },
      ceilings: { maxConsecutiveFailures: 3, ...(input.loop.maxUsd !== undefined ? { maxUsd: input.loop.maxUsd } : {}) },
    });
    deps.loopSupervisor.start(record.definition.id);
    timedOut = !await waitUntil(() => !deps.loopSupervisor.isRunning(record.definition.id), input.timeoutMs);
    if (timedOut) deps.loopSupervisor.stop(record.definition.id, "The evaluation's time limit was reached.");
    loop = deps.loops.get(record.definition.id);
  } else if (input.subject === "plan_run" && input.plan) {
    const started = deps.planRuns.start({ planId: input.plan.planId, ...(input.plan.charter ? { charter: input.plan.charter } : {}) });
    if (!started.ok) throw new Error(started.error);
    const settled = (): boolean => {
      const run = deps.planRuns.current;
      return !run || !["running", "waiting_provider"].includes(run.status);
    };
    timedOut = !await waitUntil(settled, input.timeoutMs);
    if (timedOut) deps.planRuns.stop("The evaluation's time limit was reached.");
    planRun = deps.planRuns.current;
  } else {
    throw new Error("The scenario names neither a loop nor a plan run.");
  }

  const receipts = new ReceiptStore(deps.workspaceRoot);
  const result = {
    subject: input.subject,
    arm: input.arm,
    workContracts: input.workContracts,
    wallMs: Date.now() - startedAt,
    timedOut,
    loop,
    planRun,
    receipts: receipts.index().map((entry) => receipts.getReceipt(entry.id) ?? entry),
  };
  const out = path.join(deps.workspaceRoot, ".blacksite", "eval", "result.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  return out;
}
