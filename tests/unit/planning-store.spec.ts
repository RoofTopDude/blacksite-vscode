import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PlanningStore, normalizePhaseStatus, normalizePlanStatus, summarizePlanningStateForPrompt,
} from "../../src/planning-store.js";

const CTX = { sessionId: "s1", requestId: "r1" };

let root: string;
let store: PlanningStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-plan-"));
  store = new PlanningStore(root);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

async function createPlan() {
  const res = await store.dispatch("create", {
    title: "Ship feature",
    phases: [{ title: "Phase A", steps: [{ title: "Step one" }, { title: "Step two" }] }],
  }, CTX);
  return res as { ok: boolean; planId: string; phaseIds: string[] };
}

describe("status normalizers", () => {
  it("normalizePlanStatus accepts natural synonyms", () => {
    expect(normalizePlanStatus("paused")).toBe("on_hold");
    expect(normalizePlanStatus("on hold")).toBe("on_hold");
    expect(normalizePlanStatus("in progress")).toBe("active");
    expect(normalizePlanStatus("done")).toBe("completed");
    expect(normalizePlanStatus("abandoned")).toBe("cancelled");
    expect(normalizePlanStatus("nonsense")).toBeNull();
  });
  it("normalizePhaseStatus maps synonyms to the canonical set", () => {
    expect(normalizePhaseStatus("done")).toBe("completed");
    expect(normalizePhaseStatus("in progress")).toBe("in_progress");
    expect(normalizePhaseStatus("wip")).toBe("in_progress");
    expect(normalizePhaseStatus("todo")).toBe("pending");
    expect(normalizePhaseStatus("stuck")).toBe("blocked");
  });
});

describe("plan_update forgiving step status", () => {
  it("accepts a synonym and reconciles the phase", async () => {
    const { planId, phaseIds } = await createPlan();
    await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "done" }, CTX);
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-2", stepStatus: "in progress" }, CTX);
    const plan = (res as { plan: { phases: Array<{ status: string; steps: Array<{ id: string; status: string }> }> } }).plan;
    expect(plan.phases[0]!.steps.find((s) => s.id === "step-1")!.status).toBe("completed");
    expect(plan.phases[0]!.status).toBe("in_progress");
  });
});

describe("plan_update add/remove", () => {
  it("appends steps to a phase with fresh sequential ids", async () => {
    const { planId, phaseIds } = await createPlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], addSteps: [{ title: "Step three" }] }, CTX);
    const steps = (res as { plan: { phases: Array<{ steps: Array<{ id: string; title: string }> }> } }).plan.phases[0]!.steps;
    expect(steps.map((s) => s.id)).toEqual(["step-1", "step-2", "step-3"]);
    expect(steps[2]!.title).toBe("Step three");
  });

  it("appends a whole new phase", async () => {
    const { planId } = await createPlan();
    const res = await store.dispatch("update", { planId, addPhases: [{ title: "Phase B", steps: [{ title: "b1" }] }] }, CTX);
    const phases = (res as { plan: { phases: Array<{ id: string; title: string }> } }).plan.phases;
    expect(phases).toHaveLength(2);
    expect(phases[1]!.id).toBe("phase-2");
  });

  it("removes a step and a phase", async () => {
    const { planId, phaseIds } = await createPlan();
    await store.dispatch("update", { planId, phaseId: phaseIds[0], removeStepId: "step-1" }, CTX);
    let plan = (await store.dispatch("update", { planId, note: "x" }, CTX) as { plan: { phases: Array<{ steps: unknown[] }> } }).plan;
    expect(plan.phases[0]!.steps).toHaveLength(1);
    await store.dispatch("update", { planId, addPhases: [{ title: "Phase B" }] }, CTX);
    const res = await store.dispatch("update", { planId, removePhaseId: "phase-1" }, CTX);
    plan = (res as { plan: { phases: Array<{ id: string }> } }).plan;
    expect(plan.phases.map((p) => p.id)).toEqual(["phase-2"]);
  });

  it("errors when addSteps is given without a phaseId", async () => {
    const { planId } = await createPlan();
    const res = await store.dispatch("update", { planId, addSteps: [{ title: "orphan" }] }, CTX);
    expect((res as { ok: boolean }).ok).toBe(false);
  });
});

describe("user hold / resume", () => {
  it("keeps a held plan on hold even though steps would reconcile to active", async () => {
    const { planId, phaseIds } = await createPlan();
    await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "in_progress" }, CTX);
    store.setPlanStatus(planId, "on_hold");
    const held = store.read().plans.find((p) => p.id === planId)!;
    expect(held.status).toBe("on_hold");
    // Resuming lets reconciliation re-derive the real state from step progress.
    store.setPlanStatus(planId, "active");
    const resumed = store.read().plans.find((p) => p.id === planId)!;
    expect(resumed.status).toBe("active");
  });
});

describe("summarizePlanningStateForPrompt", () => {
  it("separates active plans from on-hold plans", async () => {
    const a = await createPlan();
    const b = await createPlan();
    store.setPlanStatus(b.planId, "on_hold");
    const summary = summarizePlanningStateForPrompt(root);
    expect(summary).toContain("Active plans");
    expect(summary).toContain("Plans ON HOLD");
    expect(summary).toContain(a.planId);
    expect(summary).toContain(b.planId);
    // The held plan must appear under the ON HOLD block, after the active block.
    expect(summary.indexOf("Plans ON HOLD")).toBeGreaterThan(summary.indexOf("Active plans"));
  });
});
