import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaneContracts, LaneMeter, LANE_SPEND_CAP_REASON } from "../../src/orchestration/lane-contracts.js";
import { ReceiptStore } from "../../src/orchestration/receipt-store.js";
import { activateContract, createContractEditProvider, createContractLspProvider } from "../../src/orchestration/active-contract.js";
import { contractFromSpawn } from "../../src/orchestration/contract-mapping.js";
import type { WorkContractsMode } from "../../src/orchestration/flags.js";
import type { PlanningDocument, TaskPlan } from "../../src/planning-store.js";
import type { EditProvider, EditProviderOptions } from "../../src/diff-edit-service.js";
import type { EditApprovalRequest } from "../../src/workspace-edit-applier.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const BUDGET = { maxToolRounds: 10, maxRuntimeSeconds: 1200, idleTimeoutSeconds: 240, maxIterations: 14 };

function plan(): TaskPlan {
  return {
    id: "plan-1", title: "P", status: "active", blocks: [], docs: [], agentCanArchive: false, executionApproved: true, notes: [],
    createdAt: "", updatedAt: "",
    phases: [{
      id: "ph-1", title: "Phase", status: "in_progress", files: ["src/graph/layout.ts"], acceptanceCriteria: ["Layout tests pass"],
      blocks: [], docs: [], notes: [], linkedTodoIds: [], updatedAt: "",
      steps: [{ id: "st-1", title: "Rework layout", status: "in_progress", notes: [], updatedAt: "" }],
    }],
  } as TaskPlan;
}

function setup(mode: WorkContractsMode = "enforce") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-contracts-"));
  dirs.push(root);
  let n = 0;
  const store = new ReceiptStore(root);
  const service = new LaneContracts({
    store,
    workspaceRoot: root,
    mode: () => mode,
    planning: () => ({ schemaVersion: 3, updatedAt: null, plans: [plan()], todoRuns: [] }) as PlanningDocument,
    now: () => Date.parse("2026-10-16T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_${++n}`,
  });
  return { root, store, service };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    filesChanged: [], checks: [], uncovered: [], failedFiles: [], owesVerification: false,
    granted: [], refused: [], observedOutOfScope: [], ...overrides,
  };
}

describe("issuing lane contracts", () => {
  it("does nothing while contracts are off, even with a proposal", () => {
    const { service, store } = setup("off");
    const issued = service.issue({ task: "x", proposal: { permissions: "all" }, budget: BUDGET });
    expect(issued).toEqual({ ok: true, budget: BUDGET });
    expect(store.index()).toEqual([]);
  });

  it("derives a linked lane's contract from its plan step and records it", () => {
    const { service, store } = setup("enforce");
    const issued = service.issue({ task: "x", planLink: { planId: "plan-1", phaseId: "ph-1", stepId: "st-1" }, budget: BUDGET });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !issued.active) throw new Error("expected a contract");
    expect(issued.active.contract.origin).toMatchObject({ kind: "plan_step", stepId: "st-1" });
    expect(issued.active.contract.territory.writable).toEqual({ files: ["src/graph/layout.ts"], areas: ["src/graph", "src"] });
    expect(store.getContract(issued.active.contract.id)?.id).toBe(issued.active.contract.id);
  });

  it("refuses the spawn when the model's proposal asks for more than the lane may have", () => {
    const { service } = setup("enforce");
    const wider = service.issue({ task: "x", planLink: { planId: "plan-1", phaseId: "ph-1", stepId: "st-1" }, proposal: { writable: { files: ["docs/x.md"], areas: [] } }, budget: BUDGET });
    expect(wider.ok).toBe(false);
    if (!wider.ok) expect(wider.error).toContain("wider than this lane may be given");
    const bigger = service.issue({ task: "x", proposal: { budget: { maxToolRounds: 99 } }, budget: BUDGET });
    expect(bigger.ok).toBe(false);
    const smuggled = service.issue({ task: "x", proposal: { autoApprove: true }, budget: BUDGET });
    expect(smuggled.ok).toBe(false);
  });

  it("bounds the lane's budget by a narrower proposal", () => {
    const { service } = setup("observe");
    const issued = service.issue({ task: "x", proposal: { budget: { maxToolRounds: 3 } }, budget: BUDGET });
    expect(issued.ok && issued.budget).toEqual({ ...BUDGET, maxToolRounds: 3, maxIterations: 7 });
    expect(issued.ok && issued.active?.contract.enforcement).toBe("observe");
  });

  it("uses a host-issued contract as the base", () => {
    const { service } = setup("enforce");
    const host = contractFromSpawn("ticket work", { id: "wc_host", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "enforce", budget: { maxToolRounds: 4, maxRuntimeSeconds: 100, idleTimeoutSeconds: 50 } });
    const issued = service.issue({ task: "x", hostContract: host, budget: BUDGET });
    expect(issued.ok && issued.active?.contract.id).toBe("wc_host");
    expect(issued.ok && issued.budget.maxToolRounds).toBe(4);
  });
});

describe("receipts for lanes", () => {
  it("writes a verified receipt only when checks covered every change, with content hashes", () => {
    const { service, root, store } = setup("enforce");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const active = activateContract(contractFromSpawn("x", { id: "wc_1", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "enforce", budget: { maxToolRounds: 1, maxRuntimeSeconds: 1, idleTimeoutSeconds: 1 } }));
    const receipt = service.complete(active, {
      ended: "ok",
      observation: observation({
        filesChanged: [{ path: "src/a.ts", change: "M" }],
        checks: [{ kind: "check", method: "npm test", passed: ["src/a.ts"], failed: [], at: "t" }],
        owesVerification: true,
      }),
      filesTouched: [],
      answer: "done",
      toolRounds: 2,
      elapsedMs: 100,
      spendTracked: false,
      subject: { laneId: "lane_1" },
    });
    expect(receipt?.status).toBe("verified");
    expect(receipt?.observed.filesChanged[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getReceipt(receipt!.id)?.status).toBe("verified");
  });

  it("flags a change outside a declared territory that only the parent's diffs saw", () => {
    const { service } = setup("enforce");
    const active = activateContract({
      ...contractFromSpawn("x", { id: "wc_2", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "enforce", budget: { maxToolRounds: 1, maxRuntimeSeconds: 1, idleTimeoutSeconds: 1 } }),
      territory: { writable: { files: ["src/a.ts"], areas: [] }, readable: "workspace", source: "declared" },
    });
    const receipt = service.complete(active, {
      ended: "ok", observation: observation(), filesTouched: ["src/other.ts"], answer: "done",
      toolRounds: 1, elapsedMs: 1, spendTracked: false, subject: {},
    });
    expect(receipt?.status).toBe("failed");
    expect(receipt?.failure?.kind).toBe("scope_violation");
  });

  it("records a lane lost to a restart as abandoned", () => {
    const { service, store } = setup("enforce");
    store.putContract(contractFromSpawn("x", { id: "wc_lost", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "enforce", budget: { maxToolRounds: 1, maxRuntimeSeconds: 1, idleTimeoutSeconds: 1 } }));
    const receipt = service.recordAbandoned("wc_lost", { loopId: "loop_1", ticketId: "BLK-1", iterationSeq: 3 });
    expect(receipt?.status).toBe("abandoned");
    expect(receipt?.observed.coverage).toBe("none");
    expect(service.recordAbandoned("wc_unknown", {})).toBeUndefined();
  });

  it("describes a finished plan step from its evidence, observe only", () => {
    const { service, store } = setup("enforce");
    const recorded = service.recordStepReceipt({
      runId: "run_1", plan: plan(), phaseId: "ph-1", stepId: "st-1", title: "Rework layout",
      evidence: { checks: ["npm test"], unverified: [], filesChanged: ["src/graph/layout.ts"], at: "2026-10-16T00:00:00.000Z" },
    });
    expect(recorded?.status).toBe("verified");
    const receipt = store.getReceipt(recorded!.id);
    expect(receipt?.enforcement).toBe("observe");
    expect(receipt?.subject).toMatchObject({ planRunId: "run_1", stepId: "st-1" });

    const unverified = service.recordStepReceipt({
      runId: "run_1", plan: plan(), phaseId: "ph-1", stepId: "st-1", title: "Rework layout",
      evidence: { checks: [], unverified: ["src/graph/layout.ts"], filesChanged: ["src/graph/layout.ts"], at: "t" },
    });
    expect(unverified?.status).toBe("succeeded_unverified");
    expect(setup("off").service.recordStepReceipt({ runId: "r", plan: plan(), phaseId: "ph-1", stepId: "st-1", title: "x" })).toBeUndefined();
  });
});

describe("lane meter", () => {
  it("stops the lane once its spend ceiling is reached and remembers the last refusal", () => {
    const stop = vi.fn();
    const meter = new LaneMeter(1, (usage) => Number(usage.cost), stop);
    meter.note({ type: "usage_update", cost: 0.6 });
    expect(stop).not.toHaveBeenCalled();
    meter.note({ type: "usage_update", cost: 0.6 });
    expect(stop).toHaveBeenCalledWith(LANE_SPEND_CAP_REASON);
    meter.note({ type: "usage_update", cost: 5 });
    expect(stop).toHaveBeenCalledTimes(1);
    meter.note({ type: "approval_pending", toolCallId: "t1", tier: "scope", description: "Write outside" });
    meter.note({ type: "approval_result", toolCallId: "t1", granted: false });
    expect(meter.lastRefusal).toEqual({ gate: "scope", detail: "Write outside" });
    expect(meter.spendTracked).toBe(true);
  });
});

describe("contract edit provider", () => {
  function delegate(paths: string[], resourceOperations = 0) {
    const seen: EditProviderOptions[] = [];
    const provider: EditProvider = {
      applyEdit: async (_input, opts) => {
        seen.push(opts);
        const request = { summary: "edit", fileCount: paths.length, paths, ...(resourceOperations ? { resourceOperations } : {}) } as EditApprovalRequest;
        const decision = opts.autoApprove ? "apply" : await opts.approvalProvider?.(request);
        return { applied: decision === "apply" || decision === "all", decision } as never;
      },
      applyBatchEdits: async () => ({}) as never,
      applyJsonEdit: async () => ({}) as never,
    };
    return { provider, seen };
  }
  const context = { toRelative: (file: string) => file, isScratch: () => false };
  const active = () => activateContract({
    ...contractFromSpawn("x", { id: "wc_e", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "enforce", budget: { maxToolRounds: 1, maxRuntimeSeconds: 1, idleTimeoutSeconds: 1 } }),
    territory: { writable: { files: [], areas: ["src"] }, readable: "workspace", source: "declared" },
  });

  it("applies an in-territory edit as the caller asked, without a prompt", async () => {
    const { provider } = delegate(["src/a.ts"]);
    const gate = vi.fn(async () => true);
    const result = await createContractEditProvider(provider, active(), context, gate).applyEdit({} as never, { autoApprove: true });
    expect((result as unknown as { decision: string }).decision).toBe("apply");
    expect(gate).not.toHaveBeenCalled();
  });

  it("puts the files a rename actually touches to the gate, and rejects on refusal", async () => {
    const { provider } = delegate(["src/a.ts", "test/a.spec.ts"]);
    const contract = active();
    const gate = vi.fn(async () => false);
    const lsp = createContractLspProvider({ dispatch: async (_op, _payload, ctx) => ({ decision: await ctx.approvalProvider?.({ summary: "rename", fileCount: 2, paths: ["src/a.ts", "test/a.spec.ts"] }) }) }, contract, context, gate);
    expect(await lsp.dispatch("rename", {}, { autoApprove: true })).toEqual({ decision: "reject" });
    expect(gate.mock.calls[0]?.[0]).toBe("code_rename");
    expect(contract.refused).toHaveLength(1);
    // The edit path asks the same way, and a granted path is not asked about again.
    const allow = vi.fn(async () => true);
    const edits = createContractEditProvider(provider, contract, context, allow);
    await edits.applyEdit({} as never, { autoApprove: true });
    await edits.applyEdit({} as never, { autoApprove: true });
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it("still sends a resource operation to the caller's own approver", async () => {
    const { provider } = delegate(["src/a.ts"], 1);
    const inner = vi.fn(async () => "reject" as const);
    const result = await createContractEditProvider(provider, active(), context, vi.fn(async () => true))
      .applyEdit({} as never, { autoApprove: true, approvalProvider: inner });
    expect(inner).toHaveBeenCalledTimes(1);
    expect((result as unknown as { decision: string }).decision).toBe("reject");
  });
});
