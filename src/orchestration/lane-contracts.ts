/**
 * The contract lifecycle of one delegated lane: issue a contract before it starts, meter what it
 * spends, and write a receipt when it ends.
 *
 * ChatProvider calls this from its lane runner and stays the owner of everything else about a
 * lane. Nothing here imports vscode, so the whole lifecycle is testable against a temp directory.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { PlanningDocument, StepEvidence, TaskPlan } from "../planning-store.js";
import type { WorkContractsMode } from "./flags.js";
import { activateContract, type ActiveWorkContract } from "./active-contract.js";
import { contractFromPlanStep, contractFromSpawn } from "./contract-mapping.js";
import { narrowContract, pathInScope, type ContractBudget, type WorkContract } from "./work-contract.js";
import {
  buildReceipt,
  type CheckEvidence,
  type LaneEnd,
  type ObservedChange,
  type ReceiptSubject,
  type WorkReceipt,
} from "./work-receipt.js";
import type { ReceiptStore } from "./receipt-store.js";
import { LANE_SPEND_CAP_REASON } from "../chat/subagent-lanes.js";

const MAX_HASHED_FILES = 200;
const MAX_HASHED_BYTES = 2 * 1024 * 1024;

/** The slice of a resolved lane budget a contract can bound. */
export interface LaneBudget {
  maxToolRounds: number;
  maxRuntimeSeconds: number;
  idleTimeoutSeconds: number;
  maxIterations: number;
}

export interface IssueLaneRequest {
  task: string;
  /** A model's proposed narrowing, straight from the subagent_spawn arguments. Validated here. */
  proposal?: unknown;
  /** A contract the host already issued (a loop ticket). Takes precedence over everything else. */
  hostContract?: WorkContract;
  /** The contract of the session that spawned this lane, if it runs under one. */
  parentContract?: WorkContract;
  planLink?: { planId: string; phaseId: string; stepId: string };
  budget: LaneBudget;
}

export type IssueLaneResult =
  | { ok: true; active?: ActiveWorkContract; budget: LaneBudget }
  | { ok: false; error: string };

/** Contract budgets only ever lower the lane's own; this applies one to the other. */
export function boundBudget<T extends LaneBudget>(budget: T, contract: ContractBudget): T {
  const maxToolRounds = Math.min(budget.maxToolRounds, contract.maxToolRounds);
  return {
    ...budget,
    maxToolRounds,
    maxRuntimeSeconds: Math.min(budget.maxRuntimeSeconds, contract.maxRuntimeSeconds),
    idleTimeoutSeconds: Math.min(budget.idleTimeoutSeconds, contract.idleTimeoutSeconds),
    maxIterations: Math.min(budget.maxIterations, maxToolRounds + 4),
  };
}

export interface LaneEndFacts {
  ended: LaneEnd;
  endDetail?: string;
  /** The approval the lane was stopped on, when it was stopped by one. */
  gate?: { gate: string; detail: string };
  observation: {
    filesChanged: ObservedChange[];
    checks: CheckEvidence[];
    uncovered: string[];
    failedFiles: string[];
    owesVerification: boolean;
    granted: string[];
    refused: Array<{ toolName: string; reason: string }>;
    observedOutOfScope: string[];
  };
  /** Files the parent saw change through the lane's edit diffs. */
  filesTouched: readonly string[];
  /** What concurrency claims saw (#19), when they were on. */
  claims?: {
    /** Files the lane's own shell commands changed (git status before and after each one). */
    shellChanged: readonly string[];
    /** Every shell command was diffed, so the receipt can say shell writes were covered. */
    shellCovered: boolean;
    conflicts: readonly string[];
    unattributed: readonly string[];
  };
  answer: string;
  toolRounds: number;
  elapsedMs: number;
  /** What the false-progress monitor saw (#20), when it was on. */
  progress?: WorkReceipt["progress"];
  usd?: number;
  spendTracked: boolean;
  budgetHit?: WorkReceipt["usage"]["budgetHit"];
  subject: ReceiptSubject;
}

export interface LaneContractsOptions {
  store: ReceiptStore;
  workspaceRoot: string;
  mode: () => WorkContractsMode;
  planning?: () => PlanningDocument | undefined;
  now?: () => number;
  newId?: (prefix: string) => string;
  /** A contract was issued; `live` is every other contract still running (#14 overlap signals). */
  onIssued?: (contract: WorkContract, live: readonly WorkContract[]) => void;
}

export class LaneContracts {
  private readonly _now: () => number;
  private readonly _newId: (prefix: string) => string;
  /** Contracts issued and not yet settled by a receipt, by id. */
  private readonly _live = new Map<string, WorkContract>();

  constructor(private readonly _options: LaneContractsOptions) {
    this._now = _options.now ?? (() => Date.now());
    this._newId = _options.newId ?? ((prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  }

  /** The store contracts and receipts are written to, shared with whoever reads them. */
  get store(): ReceiptStore {
    return this._options.store;
  }

  get mode(): WorkContractsMode {
    return this._options.mode();
  }

  /**
   * Decide the contract a lane runs under. With contracts off, nothing changes and nothing is
   * written. A model's proposal that fails validation, or asks for more than the base allows,
   * refuses the spawn: the lane never starts.
   */
  issue(request: IssueLaneRequest): IssueLaneResult {
    const mode = this._options.mode();
    // Off: a proposal is accepted and ignored. Nothing is enforced, so nothing can be widened.
    if (mode === "off") return { ok: true, budget: request.budget };
    const enforcement = mode === "enforce" ? "enforce" : "observe";
    const createdAt = new Date(this._now()).toISOString();
    const budget: ContractBudget = {
      maxToolRounds: request.budget.maxToolRounds,
      maxRuntimeSeconds: request.budget.maxRuntimeSeconds,
      idleTimeoutSeconds: request.budget.idleTimeoutSeconds,
    };
    let base: WorkContract;
    if (request.hostContract) {
      base = request.hostContract;
    } else {
      const options = { id: this._newId("wc"), createdAt, enforcement, budget } as const;
      const link = request.planLink;
      const plan = link ? this._options.planning?.()?.plans.find((candidate) => candidate.id === link.planId) : undefined;
      const phase = plan?.phases.find((candidate) => candidate.id === link?.phaseId);
      const step = phase?.steps.find((candidate) => candidate.id === link?.stepId);
      base = plan && phase && step
        ? contractFromPlanStep(plan, phase, step, options)
        : contractFromSpawn(request.task, options);
      if (request.parentContract) {
        // A lane spawned under a contract may not reach further than its parent could.
        base = {
          ...base,
          territory: request.parentContract.territory,
          budget: {
            maxToolRounds: Math.min(base.budget.maxToolRounds, request.parentContract.budget.maxToolRounds),
            maxRuntimeSeconds: Math.min(base.budget.maxRuntimeSeconds, request.parentContract.budget.maxRuntimeSeconds),
            idleTimeoutSeconds: Math.min(base.budget.idleTimeoutSeconds, request.parentContract.budget.idleTimeoutSeconds),
            ...(request.parentContract.budget.maxUsd !== undefined ? { maxUsd: request.parentContract.budget.maxUsd } : {}),
          },
          origin: { ...base.origin, parentContractId: request.parentContract.id },
        };
      }
    }

    let contract = base;
    if (request.proposal !== undefined && request.proposal !== null) {
      const narrowed = narrowContract(base, request.proposal, { id: this._newId("wc"), createdAt });
      if (!narrowed.ok) {
        return {
          ok: false,
          error: `The lane was not started: its contract was refused. ${narrowed.errors.slice(0, 6).join("; ")}. `
            + "Propose a contract within what this lane may be given, or omit it.",
        };
      }
      contract = narrowed.contract;
    }
    try {
      this._options.store.putContract(contract);
    } catch {
      // A contract that cannot be recorded still bounds the lane; the receipt says so.
    }
    try {
      this._options.onIssued?.(contract, [...this._live.values()]);
    } catch { /* a listener must never stop a lane starting */ }
    this._live.set(contract.id, contract);
    return { ok: true, active: activateContract(contract), budget: boundBudget(request.budget, contract.budget) };
  }

  /** Write the receipt for a lane that ran under `active`. Never throws. */
  complete(active: ActiveWorkContract, facts: LaneEndFacts): WorkReceipt | undefined {
    this._live.delete(active.contract.id);
    try {
      const contract = active.contract;
      const changes = new Map<string, ObservedChange>();
      for (const change of facts.observation.filesChanged) changes.set(change.path, { ...change });
      for (const file of [...facts.filesTouched, ...(facts.claims?.shellChanged ?? [])]) {
        const key = this._relative(file);
        if (key && !changes.has(key)) changes.set(key, { path: key, change: "M" });
      }
      const filesChanged = this._fingerprint([...changes.values()]);
      // Out-of-scope: what observe mode let through, and anything else that changed outside the
      // territory without an approval (a path reported only by the parent's edit diffs).
      const granted = new Set(facts.observation.granted);
      const outOfScope = new Set(facts.observation.observedOutOfScope);
      for (const change of filesChanged) {
        if (!granted.has(change.path) && !pathInScope(change.path, contract.territory.writable) && !isOwnedByHarness(change.path)) {
          outOfScope.add(change.path);
        }
      }
      const changedPaths = new Set(filesChanged.filter((change) => change.change !== "D").map((change) => change.path));
      const missingOutputs = contract.outputs
        .filter((output) => output.kind === "file_change" && output.ref && !changedPaths.has(output.ref))
        .map((output) => output.ref!);
      const receipt = buildReceipt({
        id: this._newId("receipt"),
        contract,
        subject: facts.subject,
        facts: {
          ended: facts.ended,
          ...(facts.endDetail ? { endDetail: facts.endDetail } : {}),
          ...(facts.gate ? { gate: facts.gate } : {}),
          filesChanged,
          coverage: facts.claims?.shellCovered ? "tool_edits+shell_delta" : "tool_edits",
          outOfScope: [...outOfScope],
          ...(facts.claims?.conflicts.length ? { conflicts: [...facts.claims.conflicts] } : {}),
          ...(facts.claims?.unattributed.length ? { unattributed: [...facts.claims.unattributed] } : {}),
          granted: [...granted],
          refused: facts.observation.refused,
          checks: facts.observation.checks,
          uncovered: facts.observation.uncovered,
          failedFiles: facts.observation.failedFiles,
          missingOutputs,
          partialAnswer: facts.ended !== "ok" && !!facts.answer.trim(),
          verificationRequired: contract.verification.required && facts.observation.owesVerification,
        },
        usage: {
          ...(facts.spendTracked && facts.usd !== undefined ? { usd: facts.usd } : {}),
          spendPartial: !facts.spendTracked,
          toolRounds: facts.toolRounds,
          elapsedMs: facts.elapsedMs,
          ...(facts.budgetHit ? { budgetHit: facts.budgetHit } : {}),
        },
        ...(facts.progress ? { progress: facts.progress } : {}),
        answer: facts.answer,
        createdAt: new Date(this._now()).toISOString(),
      });
      this._options.store.putReceipt(receipt);
      return receipt;
    } catch {
      return undefined;
    }
  }

  /**
   * A receipt for a plan step the main agent finished during a plan run. Observe only: the main
   * agent is not a bounded delegate, so the step's contract describes it and never gates it.
   * Built from the step's evidence, which the host measured.
   */
  recordStepReceipt(context: {
    runId: string;
    plan: Pick<TaskPlan, "id" | "phases"> | undefined;
    phaseId: string;
    stepId: string;
    title: string;
    evidence?: StepEvidence;
  }): { id: string; status: string } | undefined {
    if (this._options.mode() === "off" || !context.plan) return undefined;
    const phase = context.plan.phases.find((candidate) => candidate.id === context.phaseId);
    const step = phase?.steps.find((candidate) => candidate.id === context.stepId);
    if (!phase || !step) return undefined;
    try {
      const createdAt = new Date(this._now()).toISOString();
      const contract = contractFromPlanStep(context.plan, phase, step, {
        id: this._newId("wc"),
        createdAt,
        enforcement: "observe",
        budget: { maxToolRounds: 60, maxRuntimeSeconds: 4 * 60 * 60, idleTimeoutSeconds: 60 * 60 },
      });
      this._options.store.putContract(contract);
      const evidence = context.evidence;
      const changed = (evidence?.filesChanged ?? []).map((file) => file.replace(/\\/g, "/"));
      const unverified = new Set((evidence?.unverified ?? []).map((file) => file.replace(/\\/g, "/")));
      const covered = changed.filter((file) => !unverified.has(file));
      const at = evidence?.at ?? createdAt;
      const receipt = buildReceipt({
        id: this._newId("receipt"),
        contract,
        subject: { planRunId: context.runId, planId: context.plan.id, phaseId: context.phaseId, stepId: context.stepId },
        facts: {
          ended: "ok",
          filesChanged: this._fingerprint(changed.map((file) => ({ path: file, change: "M" as const }))),
          coverage: "tool_edits",
          outOfScope: changed.filter((file) => !pathInScope(file, contract.territory.writable) && !isOwnedByHarness(file)),
          checks: (evidence?.checks ?? []).map((method) => ({ kind: "check" as const, method, passed: covered, failed: [], at })),
          uncovered: [...unverified],
          failedFiles: [],
          missingOutputs: [],
          verificationRequired: changed.length > 0,
        },
        evidence: [
          ...(evidence?.diagnostics ? [{ kind: "diagnostics" as const, errors: evidence.diagnostics.errors, warnings: evidence.diagnostics.warnings }] : []),
          ...(evidence?.runIds ?? []).map((runId) => ({ kind: "run" as const, runId })),
        ],
        usage: { spendPartial: true, toolRounds: 0, elapsedMs: 0 },
        answer: context.title,
        createdAt,
      });
      this._options.store.putReceipt(receipt);
      return { id: receipt.id, status: receipt.status };
    } catch {
      return undefined;
    }
  }

  /** The receipt for a lane lost to a host restart: nothing about it could be observed. */
  recordAbandoned(contractId: string, subject: ReceiptSubject): WorkReceipt | undefined {
    this._live.delete(contractId);
    try {
      const contract = this._options.store.getContract(contractId);
      if (!contract) return undefined;
      const receipt = buildReceipt({
        id: this._newId("receipt"),
        contract,
        subject,
        facts: {
          ended: "abandoned",
          filesChanged: [],
          coverage: "none",
          outOfScope: [],
          checks: [],
          uncovered: [],
          failedFiles: [],
          missingOutputs: [],
          verificationRequired: false,
        },
        usage: { spendPartial: true, toolRounds: 0, elapsedMs: 0 },
        createdAt: new Date(this._now()).toISOString(),
      });
      this._options.store.putReceipt(receipt);
      return receipt;
    } catch {
      return undefined;
    }
  }

  private _relative(file: string): string | null {
    const normalized = file.replace(/\\/g, "/");
    if (!path.isAbsolute(file) && !/^[a-zA-Z]:/.test(normalized)) return normalized.replace(/^\.\//, "");
    const relative = path.relative(this._options.workspaceRoot, file).replace(/\\/g, "/");
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
  }

  private _fingerprint(changes: ObservedChange[]): ObservedChange[] {
    let hashed = 0;
    return changes.map((change) => {
      if (change.change === "D" || hashed >= MAX_HASHED_FILES) return change;
      try {
        const absolute = path.join(this._options.workspaceRoot, change.path);
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > MAX_HASHED_BYTES) return { ...change, sizeBytes: stat.size };
        hashed += 1;
        const sha256 = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
        return { ...change, sha256, sizeBytes: stat.size };
      } catch {
        return change;
      }
    });
  }
}

/** Files the harness itself writes for a lane: never "outside the territory". */
function isOwnedByHarness(file: string): boolean {
  return file.startsWith(".blacksite/") || file.includes(".blacksite-scratch/");
}

/**
 * Follow a lane's events, pricing each model call, and stop the lane once its contract's spend
 * ceiling is reached. Also notes the last approval the lane was refused, so a lane stopped by a
 * refusal can be recorded as blocked rather than failed.
 */
export class LaneMeter {
  usd = 0;
  spendTracked = false;
  exceeded = false;
  lastRefusal: { gate: string; detail: string } | undefined;
  private readonly _pending = new Map<string, { tier: string; description: string }>();

  constructor(
    private readonly _maxUsd: number | undefined,
    private readonly _estimate: ((usage: { type: "usage_update" } & Record<string, unknown>) => number | undefined) | undefined,
    private readonly _stop: (reason: string) => void,
  ) {}

  /** Pass a lane's events through unchanged, noting each one. */
  async *watch<T extends { type: string }>(events: AsyncGenerator<T>): AsyncGenerator<T> {
    for await (const event of events) {
      this.note(event as unknown as { type: string } & Record<string, unknown>);
      yield event;
    }
  }

  note(event: { type: string } & Record<string, unknown>): void {
    if (event.type === "usage_update") {
      const cost = this._estimate?.(event as { type: "usage_update" } & Record<string, unknown>);
      if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
        this.usd += cost;
        this.spendTracked = true;
        if (this._maxUsd !== undefined && this.usd >= this._maxUsd && !this.exceeded) {
          this.exceeded = true;
          this._stop(LANE_SPEND_CAP_REASON);
        }
      }
    } else if (event.type === "approval_pending") {
      this._pending.set(String(event.toolCallId), { tier: String(event.tier ?? ""), description: String(event.description ?? "") });
    } else if (event.type === "approval_result") {
      const gate = this._pending.get(String(event.toolCallId));
      this._pending.delete(String(event.toolCallId));
      if (gate && event.granted === false) this.lastRefusal = { gate: gate.tier || "approval", detail: gate.description };
    }
  }
}

export { LANE_SPEND_CAP_REASON };
