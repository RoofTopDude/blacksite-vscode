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

  it("surfaces phase risks and complexity in the prompt summary", async () => {
    await store.dispatch("create", {
      title: "Ship feature",
      phases: [{ title: "Phase A", risks: "API contract might change", complexity: "large", steps: [{ title: "Step one" }] }],
    }, CTX);
    const summary = summarizePlanningStateForPrompt(root);
    expect(summary).toContain("API contract might change");
    expect(summary).toContain("(large)");
  });
});

describe("richer phase/step fields (risks, dependsOn, acceptanceCriteria, complexity)", () => {
  it("accepts the new fields on plan_create and round-trips them through persistence", async () => {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      phases: [{
        title: "Phase A",
        risks: "Schema might need a migration",
        dependsOn: ["phase-0"],
        acceptanceCriteria: ["All existing tests pass", "New endpoint documented"],
        complexity: "medium",
        steps: [{ title: "Step one", acceptanceCriteria: "Returns 200 with the new shape" }],
      }],
    }, CTX) as { ok: boolean; planId: string; plan: { phases: Array<Record<string, unknown>> } };
    expect(res.ok).toBe(true);
    const phase = res.plan.phases[0]!;
    expect(phase.risks).toBe("Schema might need a migration");
    expect(phase.dependsOn).toEqual(["phase-0"]);
    expect(phase.acceptanceCriteria).toEqual(["All existing tests pass", "New endpoint documented"]);
    expect(phase.complexity).toBe("medium");
    expect((phase.steps as Array<Record<string, unknown>>)[0]!.acceptanceCriteria).toBe("Returns 200 with the new shape");

    // Re-read from a fresh store instance pointed at the same directory (forces a real disk round-trip).
    const reopened = new PlanningStore(root);
    const reloadedPhase = reopened.read().plans[0]!.phases[0]!;
    expect(reloadedPhase.risks).toBe("Schema might need a migration");
    expect(reloadedPhase.complexity).toBe("medium");
    reopened.dispose();
  });

  it("edits the new phase/step fields via plan_update", async () => {
    const { planId, phaseIds } = await createPlan();
    const res = await store.dispatch("update", {
      planId, phaseId: phaseIds[0],
      phaseRisks: "Vendor API is flaky", phaseDependsOn: ["phase-x"], phaseAcceptanceCriteria: ["Green CI"], phaseComplexity: "small",
      stepId: "step-1", stepAcceptanceCriteria: "Unit test covers the edge case",
    }, CTX) as { plan: { phases: Array<Record<string, unknown>> } };
    const phase = res.plan.phases[0]!;
    expect(phase.risks).toBe("Vendor API is flaky");
    expect(phase.dependsOn).toEqual(["phase-x"]);
    expect(phase.complexity).toBe("small");
    expect((phase.steps as Array<Record<string, unknown>>)[0]!.acceptanceCriteria).toBe("Unit test covers the edge case");
  });

  it("ignores an invalid complexity value instead of corrupting the field", async () => {
    const { planId, phaseIds } = await createPlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], phaseComplexity: "gigantic" }, CTX) as { plan: { phases: Array<Record<string, unknown>> } };
    expect(res.plan.phases[0]!.complexity).toBeUndefined();
  });

  it("clears phaseComplexity via an explicit empty string, matching how phaseRisks/phaseObjective clear", async () => {
    const { planId, phaseIds } = await createPlan();
    await store.dispatch("update", { planId, phaseId: phaseIds[0], phaseComplexity: "large" }, CTX);
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], phaseComplexity: "" }, CTX) as { plan: { phases: Array<Record<string, unknown>> } };
    expect(res.plan.phases[0]!.complexity).toBeUndefined();
  });

  it("old on-disk JSON without the new fields still loads cleanly", () => {
    const legacyDoc = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      plans: [{
        id: "plan_legacy", title: "Legacy plan", status: "active",
        phases: [{ id: "phase-1", title: "Old phase", status: "pending", steps: [{ id: "step-1", title: "Old step", status: "pending", notes: [], updatedAt: new Date().toISOString() }], notes: [], linkedTodoIds: [], updatedAt: new Date().toISOString() }],
        notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
      todoRuns: [],
    };
    fs.writeFileSync(store.filePath(), JSON.stringify(legacyDoc), "utf8");
    const document = store.read();
    expect(document.plans).toHaveLength(1);
    const phase = document.plans[0]!.phases[0]!;
    expect(phase.title).toBe("Old phase");
    expect(phase.risks).toBeUndefined();
    expect(phase.complexity).toBeUndefined();
    // Array-typed optional fields default to an empty array rather than undefined.
    expect(phase.dependsOn).toEqual([]);
    expect(phase.acceptanceCriteria).toEqual([]);
  });
});

describe("plan_update editing ergonomics (reorder, move, insert)", () => {
  async function createTwoPhasePlan() {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      phases: [
        { title: "Phase A", steps: [{ title: "a1" }, { title: "a2" }] },
        { title: "Phase B", steps: [{ title: "b1" }] },
      ],
    }, CTX) as { ok: boolean; planId: string; phaseIds: string[] };
    return res;
  }

  it("reorderPhaseIds accepts a valid permutation", async () => {
    const { planId } = await createTwoPhasePlan();
    const res = await store.dispatch("update", { planId, reorderPhaseIds: ["phase-2", "phase-1"] }, CTX) as { ok: boolean; plan: { phases: Array<{ id: string }> } };
    expect(res.ok).toBe(true);
    expect(res.plan.phases.map((p) => p.id)).toEqual(["phase-2", "phase-1"]);
  });

  it("reorderPhaseIds rejects a list that isn't an exact permutation", async () => {
    const { planId } = await createTwoPhasePlan();
    const missing = await store.dispatch("update", { planId, reorderPhaseIds: ["phase-1"] }, CTX) as { ok: boolean };
    expect(missing.ok).toBe(false);
    const duplicate = await store.dispatch("update", { planId, reorderPhaseIds: ["phase-1", "phase-1"] }, CTX) as { ok: boolean };
    expect(duplicate.ok).toBe(false);
    const unknown = await store.dispatch("update", { planId, reorderPhaseIds: ["phase-1", "phase-9"] }, CTX) as { ok: boolean };
    expect(unknown.ok).toBe(false);
  });

  it("reorderStepIds reorders steps within a phase", async () => {
    const { planId, phaseIds } = await createTwoPhasePlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], reorderStepIds: ["step-2", "step-1"] }, CTX) as { plan: { phases: Array<{ steps: Array<{ id: string }> }> } };
    expect(res.plan.phases[0]!.steps.map((s) => s.id)).toEqual(["step-2", "step-1"]);
  });

  it("moveStepId moves a step to a different phase", async () => {
    const { planId, phaseIds } = await createTwoPhasePlan();
    const res = await store.dispatch("update", {
      planId, phaseId: phaseIds[0], moveStepId: "step-1", moveStepToPhaseId: phaseIds[1],
    }, CTX) as { ok: boolean; plan: { phases: Array<{ id: string; steps: Array<{ id: string; title: string }> }> } };
    expect(res.ok).toBe(true);
    expect(res.plan.phases[0]!.steps.map((s) => s.title)).toEqual(["a2"]);
    // Destination phase already had its own "step-1" — the moved step must be reassigned a fresh id, not collide.
    const destSteps = res.plan.phases[1]!.steps;
    expect(destSteps.map((s) => s.title)).toEqual(["b1", "a1"]);
    expect(new Set(destSteps.map((s) => s.id)).size).toBe(destSteps.length);
  });

  it("moveStepId errors when the destination phase is missing", async () => {
    const { planId, phaseIds } = await createTwoPhasePlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], moveStepId: "step-1", moveStepToPhaseId: "phase-nope" }, CTX) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("insertPhaseBeforeId inserts new phases before an existing phase instead of appending", async () => {
    const { planId, phaseIds } = await createTwoPhasePlan();
    const res = await store.dispatch("update", {
      planId, addPhases: [{ title: "Phase inserted" }], insertPhaseBeforeId: phaseIds[1],
    }, CTX) as { plan: { phases: Array<{ title: string }> } };
    expect(res.plan.phases.map((p) => p.title)).toEqual(["Phase A", "Phase inserted", "Phase B"]);
  });

  it("addPhases still appends when insertPhaseBeforeId is omitted", async () => {
    const { planId } = await createTwoPhasePlan();
    const res = await store.dispatch("update", { planId, addPhases: [{ title: "Phase C" }] }, CTX) as { plan: { phases: Array<{ title: string }> } };
    expect(res.plan.phases.map((p) => p.title)).toEqual(["Phase A", "Phase B", "Phase C"]);
  });

  it("insertPhaseBeforeId errors on an unknown id instead of silently falling back to append", async () => {
    const { planId } = await createTwoPhasePlan();
    const res = await store.dispatch("update", {
      planId, addPhases: [{ title: "Phase inserted" }], insertPhaseBeforeId: "phase-does-not-exist",
    }, CTX) as { ok: boolean; plan?: { phases: Array<{ title: string }> } };
    expect(res.ok).toBe(false);
    // And the new phase must not have been silently appended either — the whole call is a no-op.
    const after = await store.dispatch("update", { planId, note: "x" }, CTX) as { plan: { phases: Array<{ title: string }> } };
    expect(after.plan.phases.map((p) => p.title)).toEqual(["Phase A", "Phase B"]);
  });
});
