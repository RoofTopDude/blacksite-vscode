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

// Pre-approves execution so the shared mechanics tests can advance step/phase status freely —
// the execution-approval gate is exercised on its own, with deliberately unapproved plans, in the
// "execution-approval gate" describe block below.
async function createPlan() {
  const res = await store.dispatch("create", {
    title: "Ship feature",
    executionApproved: true,
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

describe("linked task items", () => {
  it("records a plan/phase link without advancing plan execution", async () => {
    const created = await store.dispatch("create", {
      title: "Plan first",
      phases: [{ title: "Phase A", steps: [{ title: "Implement the feature" }] }],
    }, CTX) as { planId: string; phaseIds: string[] };

    const todo = await store.dispatch("todoCreate", {
      name: "Research checklist",
      planId: created.planId,
      phaseId: created.phaseIds[0],
      steps: [{ label: "Inspect current flow" }, { label: "Write findings" }],
    }, CTX) as { ok: boolean; todoId: string };

    expect(todo.ok).toBe(true);
    await store.dispatch("todoUpdate", { todoId: todo.todoId, stepId: "step-1", status: "running" }, CTX);
    await store.dispatch("todoUpdate", { todoId: todo.todoId, stepId: "step-1", status: "done" }, CTX);
    await store.dispatch("todoUpdate", { todoId: todo.todoId, stepId: "step-2", status: "done" }, CTX);

    const plan = store.read().plans.find((entry) => entry.id === created.planId)!;
    expect(plan.phases[0]!.linkedTodoIds).toContain(todo.todoId);
    expect(plan.phases[0]!.status).toBe("pending");
    expect(plan.phases[0]!.steps[0]!.status).toBe("pending");
    expect(plan.executionApproved).toBe(false);
  });

  it("requires a real, actionable plan and phase for a linked run", async () => {
    const { planId, phaseIds } = await createPlan();

    const phaseWithoutPlan = await store.dispatch("todoCreate", {
      phaseId: phaseIds[0], steps: [{ label: "Inspect" }],
    }, CTX) as { ok: boolean };
    expect(phaseWithoutPlan.ok).toBe(false);

    const missingPlan = await store.dispatch("todoCreate", {
      planId: "plan-missing", phaseId: "phase-1", steps: [{ label: "Inspect" }],
    }, CTX) as { ok: boolean };
    expect(missingPlan.ok).toBe(false);

    const missingPhase = await store.dispatch("todoCreate", {
      planId, phaseId: "phase-missing", steps: [{ label: "Inspect" }],
    }, CTX) as { ok: boolean };
    expect(missingPhase.ok).toBe(false);

    store.setPlanStatus(planId, "on_hold");
    const heldPlan = await store.dispatch("todoCreate", {
      planId, phaseId: phaseIds[0], steps: [{ label: "Inspect" }],
    }, CTX) as { ok: boolean };
    expect(heldPlan.ok).toBe(false);
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

describe("rationale durability on plan deletion", () => {
  function readMemory(): string {
    return fs.readFileSync(path.join(root, ".blacksite", "memory.md"), "utf8");
  }

  it("clearCompleted folds phase rationale into memory.md before the plan is deleted", async () => {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      executionApproved: true,
      phases: [{
        title: "Phase A",
        rationale: "Chose a queue over polling to avoid rate limits",
        steps: [{ title: "Step one" }],
      }],
    }, CTX) as { planId: string; phaseIds: string[] };
    await store.dispatch("update", { planId: res.planId, phaseId: res.phaseIds[0], stepId: "step-1", stepStatus: "done" }, CTX);
    expect(store.read().plans.find((p) => p.id === res.planId)!.status).toBe("completed");

    store.clearCompleted();

    expect(store.read().plans).toHaveLength(0);
    const memory = readMemory();
    expect(memory).toContain("Ship feature");
    expect(memory).toContain("Chose a queue over polling to avoid rate limits");
  });

  it("deletePlan folds phase rationale into memory.md before the plan is deleted", async () => {
    const res = await store.dispatch("create", {
      title: "Refactor auth",
      phases: [{ title: "Phase A", rationale: "Reused the existing token cache instead of a new store" }],
    }, CTX) as { planId: string };

    store.deletePlan(res.planId);

    expect(store.read().plans).toHaveLength(0);
    expect(readMemory()).toContain("Reused the existing token cache instead of a new store");
  });

  it("does not create memory.md when the removed plan has no rationale", async () => {
    const { planId } = await createPlan();
    store.deletePlan(planId);
    expect(fs.existsSync(path.join(root, ".blacksite", "memory.md"))).toBe(false);
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

  it("surfaces phase rationale in the prompt summary", async () => {
    await store.dispatch("create", {
      title: "Ship feature",
      phases: [{ title: "Phase A", rationale: "Chose a queue over polling to avoid rate limits", steps: [{ title: "Step one" }] }],
    }, CTX);
    const summary = summarizePlanningStateForPrompt(root);
    expect(summary).toContain("Rationale: Chose a queue over polling to avoid rate limits");
  });
});

describe("richer phase/step fields (rationale, risks, dependsOn, acceptanceCriteria, complexity)", () => {
  it("accepts the new fields on plan_create and round-trips them through persistence", async () => {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      phases: [{
        title: "Phase A",
        rationale: "Extending the existing sync worker over a new service to reuse its retry/backoff plumbing",
        risks: "Schema might need a migration",
        dependsOn: ["phase-0"],
        acceptanceCriteria: ["All existing tests pass", "New endpoint documented"],
        complexity: "medium",
        steps: [{ title: "Step one", acceptanceCriteria: "Returns 200 with the new shape" }],
      }],
    }, CTX) as { ok: boolean; planId: string; plan: { phases: Array<Record<string, unknown>> } };
    expect(res.ok).toBe(true);
    const phase = res.plan.phases[0]!;
    expect(phase.rationale).toBe("Extending the existing sync worker over a new service to reuse its retry/backoff plumbing");
    expect(phase.risks).toBe("Schema might need a migration");
    expect(phase.dependsOn).toEqual(["phase-0"]);
    expect(phase.acceptanceCriteria).toEqual(["All existing tests pass", "New endpoint documented"]);
    expect(phase.complexity).toBe("medium");
    expect((phase.steps as Array<Record<string, unknown>>)[0]!.acceptanceCriteria).toBe("Returns 200 with the new shape");

    // Re-read from a fresh store instance pointed at the same directory (forces a real disk round-trip).
    const reopened = new PlanningStore(root);
    const reloadedPhase = reopened.read().plans[0]!.phases[0]!;
    expect(reloadedPhase.rationale).toBe("Extending the existing sync worker over a new service to reuse its retry/backoff plumbing");
    expect(reloadedPhase.risks).toBe("Schema might need a migration");
    expect(reloadedPhase.complexity).toBe("medium");
    reopened.dispose();
  });

  it("edits the new phase/step fields via plan_update", async () => {
    const { planId, phaseIds } = await createPlan();
    const res = await store.dispatch("update", {
      planId, phaseId: phaseIds[0],
      phaseRationale: "Switched to optimistic locking after the pessimistic-lock spike showed contention",
      phaseRisks: "Vendor API is flaky", phaseDependsOn: ["phase-x"], phaseAcceptanceCriteria: ["Green CI"], phaseComplexity: "small",
      stepId: "step-1", stepAcceptanceCriteria: "Unit test covers the edge case",
    }, CTX) as { plan: { phases: Array<Record<string, unknown>> } };
    const phase = res.plan.phases[0]!;
    expect(phase.rationale).toBe("Switched to optimistic locking after the pessimistic-lock spike showed contention");
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
    expect(phase.rationale).toBeUndefined();
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

type BlockResult = { ok: boolean; plan: { blocks: Array<{ id: string; kind: string; label?: string; body: string }>; phases: Array<{ blocks: Array<{ id: string; kind: string; label?: string; body: string }> }> } };

describe("modular plan/phase blocks", () => {
  it("plan_create accepts plan-level and phase-level blocks", async () => {
    const res = await store.dispatch("create", {
      title: "Research spike",
      blocks: [{ kind: "open_questions", body: "Do we need a migration?" }],
      phases: [{
        title: "Investigate",
        blocks: [{ kind: "findings", body: "The old client already retries with backoff." }],
        steps: [{ title: "Read the client code" }],
      }],
    }, CTX) as BlockResult;
    expect(res.ok).toBe(true);
    expect(res.plan.blocks).toHaveLength(1);
    expect(res.plan.blocks[0]!.kind).toBe("open_questions");
    expect(res.plan.phases[0]!.blocks).toHaveLength(1);
    expect(res.plan.phases[0]!.blocks[0]!.body).toBe("The old client already retries with backoff.");
  });

  it("normalizes an unrecognized kind to custom instead of rejecting the block", async () => {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      blocks: [{ kind: "totally-unknown-kind", label: "Weird one", body: "Something bespoke" }],
      phases: [{ title: "Phase A" }],
    }, CTX) as BlockResult;
    expect(res.plan.blocks[0]!.kind).toBe("custom");
    expect(res.plan.blocks[0]!.label).toBe("Weird one");
  });

  it("plan_update upserts a block with a matching kind+label instead of duplicating it", async () => {
    const { planId } = await createPlan();
    await store.dispatch("update", { planId, blocks: [{ kind: "deliverables", body: "A CLI flag" }] }, CTX);
    const res = await store.dispatch("update", { planId, blocks: [{ kind: "deliverables", body: "A CLI flag plus docs" }] }, CTX) as BlockResult;
    expect(res.plan.blocks).toHaveLength(1);
    expect(res.plan.blocks[0]!.body).toBe("A CLI flag plus docs");
  });

  it("plan_update keeps two custom blocks with different labels distinct", async () => {
    const { planId } = await createPlan();
    await store.dispatch("update", { planId, blocks: [{ kind: "custom", label: "Cost", body: "Roughly $50/mo" }] }, CTX);
    const res = await store.dispatch("update", { planId, blocks: [{ kind: "custom", label: "Latency", body: "Sub-100ms" }] }, CTX) as BlockResult;
    expect(res.plan.blocks).toHaveLength(2);
    expect(res.plan.blocks.map((b) => b.label).sort()).toEqual(["Cost", "Latency"]);
  });

  it("removeBlockId removes a plan-level block", async () => {
    const { planId } = await createPlan();
    const created = await store.dispatch("update", { planId, blocks: [{ kind: "findings", body: "x" }] }, CTX) as BlockResult;
    const blockId = created.plan.blocks[0]!.id;
    const res = await store.dispatch("update", { planId, removeBlockId: blockId }, CTX) as BlockResult;
    expect(res.plan.blocks).toHaveLength(0);
  });

  it("phaseBlocks upserts and removePhaseBlockId removes a phase-level block", async () => {
    const { planId, phaseIds } = await createPlan();
    const created = await store.dispatch("update", {
      planId, phaseId: phaseIds[0], phaseBlocks: [{ kind: "options_considered", body: "Postgres vs SQLite" }],
    }, CTX) as BlockResult;
    expect(created.plan.phases[0]!.blocks).toHaveLength(1);
    const blockId = created.plan.phases[0]!.blocks[0]!.id;

    const updated = await store.dispatch("update", {
      planId, phaseId: phaseIds[0], phaseBlocks: [{ kind: "options_considered", body: "Went with SQLite for zero-ops" }],
    }, CTX) as BlockResult;
    expect(updated.plan.phases[0]!.blocks).toHaveLength(1);
    expect(updated.plan.phases[0]!.blocks[0]!.body).toBe("Went with SQLite for zero-ops");

    const removed = await store.dispatch("update", { planId, phaseId: phaseIds[0], removePhaseBlockId: blockId }, CTX) as BlockResult;
    expect(removed.plan.phases[0]!.blocks).toHaveLength(0);
  });

  it("old on-disk JSON without blocks still loads cleanly, defaulting to an empty array", () => {
    const legacyDoc = {
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      plans: [{
        id: "plan_legacy", title: "Legacy plan", status: "active",
        phases: [{ id: "phase-1", title: "Old phase", status: "pending", steps: [], notes: [], linkedTodoIds: [], updatedAt: new Date().toISOString() }],
        notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
      todoRuns: [],
    };
    fs.writeFileSync(store.filePath(), JSON.stringify(legacyDoc), "utf8");
    const document = store.read();
    expect(document.plans[0]!.blocks).toEqual([]);
    expect(document.plans[0]!.phases[0]!.blocks).toEqual([]);
  });

  it("surfaces block labels in the prompt summary", async () => {
    await store.dispatch("create", {
      title: "Ship feature",
      blocks: [{ kind: "deliverables", body: "A migration script" }],
      phases: [{ title: "Phase A", blocks: [{ kind: "findings", body: "x" }] }],
    }, CTX);
    const summary = summarizePlanningStateForPrompt(root);
    expect(summary).toContain("Blocks: Deliverables");
    expect(summary).toContain("Blocks: Findings");
  });
});

type StepMaxIterationsResult = { ok: boolean; plan: { phases: Array<{ steps: Array<{ id: string; maxIterations?: number }> }> } };

describe("step-level maxIterations (self-review loop hint)", () => {
  it("plan_create clamps maxIterations to [2, 6]", async () => {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      phases: [{ title: "Phase A", steps: [{ title: "a", maxIterations: 1 }, { title: "b", maxIterations: 9 }, { title: "c", maxIterations: 3 }] }],
    }, CTX) as StepMaxIterationsResult;
    const steps = res.plan.phases[0]!.steps;
    expect(steps[0]!.maxIterations).toBe(2);
    expect(steps[1]!.maxIterations).toBe(6);
    expect(steps[2]!.maxIterations).toBe(3);
  });

  it("plan_update sets stepMaxIterations and 0 clears it", async () => {
    const { planId, phaseIds } = await createPlan();
    const set = await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepMaxIterations: 4 }, CTX) as StepMaxIterationsResult;
    expect(set.plan.phases[0]!.steps.find((s) => s.id === "step-1")!.maxIterations).toBe(4);

    const cleared = await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepMaxIterations: 0 }, CTX) as StepMaxIterationsResult;
    expect(cleared.plan.phases[0]!.steps.find((s) => s.id === "step-1")!.maxIterations).toBeUndefined();
  });

  it("leaves maxIterations unset by default", async () => {
    const { planId, phaseIds } = await createPlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], note: "x" }, CTX) as StepMaxIterationsResult;
    expect(res.plan.phases[0]!.steps[0]!.maxIterations).toBeUndefined();
  });
});

type DocResult = { ok: boolean; docId?: string; doc?: { id: string; kind: string; title: string; source: string; byteSize: number }; error?: string };
type DocReadResult = { ok: boolean; doc?: { id: string }; body?: string; error?: string };
type DocListResult = { ok: boolean; docs?: Array<{ id: string }>; phaseDocs?: Array<{ phaseId: string; docs: Array<{ id: string }> }>; error?: string };

describe("plan documentation docs (plan_doc_write / read / list)", () => {
  it("writes a plan-level doc and reads its body back", async () => {
    const { planId } = await createPlan();
    const written = await store.dispatch("docWrite", { planId, kind: "research", title: "Findings", body: "# Findings\n\nInteresting." }, CTX) as DocResult;
    expect(written.ok).toBe(true);
    expect(written.doc?.kind).toBe("research");

    const read = await store.dispatch("docRead", { planId, docId: written.docId }, CTX) as DocReadResult;
    expect(read.ok).toBe(true);
    expect(read.body).toBe("# Findings\n\nInteresting.");
  });

  it("writes a phase-scoped doc, kept separate from the plan-level list", async () => {
    const { planId, phaseIds } = await createPlan();
    await store.dispatch("docWrite", { planId, phaseId: phaseIds[0], kind: "spec", title: "Phase spec", body: "spec body" }, CTX);
    const planLevel = await store.dispatch("docList", { planId }, CTX) as DocListResult;
    expect(planLevel.docs).toHaveLength(0);
    expect(planLevel.phaseDocs?.find((p) => p.phaseId === phaseIds[0])?.docs).toHaveLength(1);

    const phaseLevel = await store.dispatch("docList", { planId, phaseId: phaseIds[0] }, CTX) as DocListResult;
    expect(phaseLevel.docs).toHaveLength(1);
  });

  it("tolerantly coerces an unrecognized kind to custom", async () => {
    const { planId } = await createPlan();
    const res = await store.dispatch("docWrite", { planId, kind: "something-weird", title: "T", body: "b" }, CTX) as DocResult;
    expect(res.doc?.kind).toBe("custom");
  });

  it("updates an existing doc in place when docId is passed, without duplicating it", async () => {
    const { planId } = await createPlan();
    const first = await store.dispatch("docWrite", { planId, kind: "notes", title: "V1", body: "one" }, CTX) as DocResult;
    await store.dispatch("docWrite", { planId, docId: first.docId, kind: "notes", title: "V2", body: "two" }, CTX);

    const list = await store.dispatch("docList", { planId }, CTX) as DocListResult;
    expect(list.docs).toHaveLength(1);
    const read = await store.dispatch("docRead", { planId, docId: first.docId }, CTX) as DocReadResult;
    expect(read.body).toBe("two");
  });

  it("errors when docId is given but doesn't exist", async () => {
    const { planId } = await createPlan();
    const res = await store.dispatch("docWrite", { planId, docId: "nope", kind: "notes", title: "T", body: "b" }, CTX) as DocResult;
    expect(res.ok).toBe(false);
  });

  it("errors past the MAX_DOCS cap for a scope", async () => {
    const { planId } = await createPlan();
    let lastOk = true;
    for (let i = 0; i < 21; i += 1) {
      const res = await store.dispatch("docWrite", { planId, kind: "notes", title: `Doc ${i}`, body: `body ${i}` }, CTX) as DocResult;
      lastOk = res.ok;
    }
    expect(lastOk).toBe(false);
    const list = await store.dispatch("docList", { planId }, CTX) as DocListResult;
    expect(list.docs).toHaveLength(20);
  });

  it("errors reading a file-attachment doc's body as text", async () => {
    const { planId } = await createPlan();
    const attached = store.attachDocFile(planId, undefined, __filename) as DocResult;
    expect(attached.ok).toBe(true);
    const read = await store.dispatch("docRead", { planId, docId: attached.doc!.id }, CTX) as DocReadResult;
    expect(read.ok).toBe(false);
  });

  it("deleteDoc removes a doc from whichever scope holds it", async () => {
    const { planId, phaseIds } = await createPlan();
    const doc = await store.dispatch("docWrite", { planId, phaseId: phaseIds[0], kind: "notes", title: "T", body: "b" }, CTX) as DocResult;
    store.deleteDoc(planId, doc.docId!);
    const list = await store.dispatch("docList", { planId, phaseId: phaseIds[0] }, CTX) as DocListResult;
    expect(list.docs).toHaveLength(0);
  });

  it("createDoc seeds a blank doc the user can open directly, distinct from an agent-written one", async () => {
    const { planId } = await createPlan();
    const res = store.createDoc(planId, undefined, "notes", "My note") as DocResult;
    expect(res.ok).toBe(true);
    expect(res.doc?.source).toBe("user");
    const read = await store.dispatch("docRead", { planId, docId: res.doc!.id }, CTX) as DocReadResult;
    expect(read.body).toContain("My note");
  });

  it("resolveDocPath returns the real .md file for a markdown doc", async () => {
    const { planId } = await createPlan();
    const res = await store.dispatch("docWrite", { planId, kind: "notes", title: "T", body: "b" }, CTX) as DocResult;
    const resolved = store.resolveDocPath(planId, res.docId!);
    expect(resolved?.isAttachment).toBe(false);
    expect(fs.existsSync(resolved!.path)).toBe(true);
  });

  it("resolveDocPath returns the attached file for a reference doc", async () => {
    const { planId } = await createPlan();
    const attached = store.attachDocFile(planId, undefined, __filename) as DocResult;
    const resolved = store.resolveDocPath(planId, attached.doc!.id);
    expect(resolved?.isAttachment).toBe(true);
    expect(fs.existsSync(resolved!.path)).toBe(true);
  });
});

describe("archiving is non-destructive; deletePlan is the only permanent removal", () => {
  it("set_plan_status('archived') keeps the plan (and its docs) fully intact", async () => {
    const { planId } = await createPlan();
    await store.dispatch("docWrite", { planId, kind: "research", title: "Findings", body: "keep me" }, CTX);
    store.setPlanStatus(planId, "archived");

    const plan = store.read().plans.find((p) => p.id === planId)!;
    expect(plan).toBeDefined();
    expect(plan.status).toBe("archived");
    expect(plan.docs).toHaveLength(1);
  });

  it("excludes archived plans from the active listing and prompt summary, but not from the full listing", async () => {
    const { planId } = await createPlan();
    store.setPlanStatus(planId, "archived");

    const activeList = await store.dispatch("list", { activeOnly: true }, CTX) as { plans: Array<{ id: string }> };
    expect(activeList.plans.find((p) => p.id === planId)).toBeUndefined();

    const fullList = await store.dispatch("list", { activeOnly: false }, CTX) as { plans: Array<{ id: string }> };
    expect(fullList.plans.find((p) => p.id === planId)).toBeDefined();

    expect(summarizePlanningStateForPrompt(root)).not.toContain(planId);
  });

  it("plan_update cannot archive a plan without agentCanArchive permission", async () => {
    const { planId } = await createPlan();
    const res = await store.dispatch("update", { planId, status: "archived" }, CTX) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(store.read().plans.find((p) => p.id === planId)!.status).not.toBe("archived");
  });

  it("plan_update can archive once agentCanArchive is granted (at creation or later)", async () => {
    const created = await store.dispatch("create", { title: "Trusted plan", agentCanArchive: true, phases: [{ title: "A", steps: [{ title: "s" }] }] }, CTX) as { planId: string };
    const res = await store.dispatch("update", { planId: created.planId, status: "archived" }, CTX) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store.read().plans.find((p) => p.id === created.planId)!.status).toBe("archived");

    // Granting it later via plan_update works too, on a plan created without it.
    const { planId: laterId } = await createPlan();
    let rejected = await store.dispatch("update", { planId: laterId, status: "archived" }, CTX) as { ok: boolean };
    expect(rejected.ok).toBe(false);
    await store.dispatch("update", { planId: laterId, agentCanArchive: true }, CTX);
    rejected = await store.dispatch("update", { planId: laterId, status: "archived" }, CTX) as { ok: boolean };
    expect(rejected.ok).toBe(true);
  });

  it("setAgentCanArchive lets the user revoke permission the agent doesn't need to ask about", async () => {
    const created = await store.dispatch("create", { title: "Trusted plan", agentCanArchive: true, phases: [{ title: "A", steps: [{ title: "s" }] }] }, CTX) as { planId: string };
    store.setAgentCanArchive(created.planId, false);
    const res = await store.dispatch("update", { planId: created.planId, status: "archived" }, CTX) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("deletePlan removes the plan and its entire doc/attachment folder from disk", async () => {
    const { planId } = await createPlan();
    await store.dispatch("docWrite", { planId, kind: "research", title: "Findings", body: "gone soon" }, CTX);
    store.deletePlan(planId);
    expect(store.read().plans.find((p) => p.id === planId)).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".blacksite", "plans", planId))).toBe(false);
  });
});

describe("execution-approval gate", () => {
  async function unapprovedPlan() {
    const res = await store.dispatch("create", {
      title: "Ship feature",
      phases: [{ title: "Phase A", steps: [{ title: "Step one" }, { title: "Step two" }] }],
    }, CTX) as { ok: boolean; planId: string; phaseIds: string[]; executionApproved: boolean; notice?: string };
    return res;
  }

  it("plan_create defaults to unapproved and returns a notice telling the agent to wait", async () => {
    const res = await unapprovedPlan();
    expect(res.executionApproved).toBe(false);
    expect(res.notice).toMatch(/not yet approved/i);
  });

  it("plan_create can start approved when the user pre-authorized", async () => {
    const res = await store.dispatch("create", {
      title: "Ship feature", executionApproved: true,
      phases: [{ title: "Phase A", steps: [{ title: "Step one" }] }],
    }, CTX) as { executionApproved: boolean; notice?: string };
    expect(res.executionApproved).toBe(true);
    expect(res.notice).toBeUndefined();
  });

  it("blocks advancing a step to in_progress/completed while unapproved", async () => {
    const { planId, phaseIds } = await unapprovedPlan();
    const inProgress = await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "in_progress" }, CTX) as { ok: boolean; error?: string };
    expect(inProgress.ok).toBe(false);
    expect(inProgress.error).toMatch(/approv/i);
    const done = await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "done" }, CTX) as { ok: boolean };
    expect(done.ok).toBe(false);
    // The step must not have advanced.
    expect(store.read().plans.find((p) => p.id === planId)!.phases[0]!.steps[0]!.status).toBe("pending");
  });

  it("blocks advancing a phase to in_progress/completed while unapproved", async () => {
    const { planId, phaseIds } = await unapprovedPlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], phaseStatus: "in_progress" }, CTX) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it("still allows authoring/refinement (add/remove/reorder, notes, docs, blocking) while unapproved", async () => {
    const { planId, phaseIds } = await unapprovedPlan();
    // Adding a phase, adding steps, notes, and even marking a step blocked are all fine — none
    // of these claim implementation progress.
    expect((await store.dispatch("update", { planId, addPhases: [{ title: "Phase B" }] }, CTX) as { ok: boolean }).ok).toBe(true);
    expect((await store.dispatch("update", { planId, phaseId: phaseIds[0], addSteps: [{ title: "Step three" }] }, CTX) as { ok: boolean }).ok).toBe(true);
    expect((await store.dispatch("update", { planId, phaseId: phaseIds[0], phaseNote: "learned something" }, CTX) as { ok: boolean }).ok).toBe(true);
    expect((await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "blocked" }, CTX) as { ok: boolean }).ok).toBe(true);
    expect((await store.dispatch("docWrite", { planId, kind: "research", title: "Findings", body: "notes" }, CTX) as { ok: boolean }).ok).toBe(true);
  });

  it("does not allow added steps or phases to bypass execution approval with completed statuses", async () => {
    const { planId, phaseIds } = await unapprovedPlan();
    const step = await store.dispatch("update", {
      planId, phaseId: phaseIds[0], addSteps: [{ title: "Already running", status: "in_progress" }],
    }, CTX) as { ok: boolean; error?: string };
    expect(step.ok).toBe(false);
    expect(step.error).toMatch(/approv/i);

    const phase = await store.dispatch("update", {
      planId, addPhases: [{ title: "Already done", steps: [{ title: "Finished", status: "completed" }] }],
    }, CTX) as { ok: boolean; error?: string };
    expect(phase.ok).toBe(false);
    expect(phase.error).toMatch(/approv/i);
  });

  it("lets the agent approve-and-start in one update when the user just said go", async () => {
    const { planId, phaseIds } = await unapprovedPlan();
    const res = await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "in_progress", executionApproved: true }, CTX) as { ok: boolean };
    expect(res.ok).toBe(true);
    const plan = store.read().plans.find((p) => p.id === planId)!;
    expect(plan.executionApproved).toBe(true);
    expect(plan.phases[0]!.steps[0]!.status).toBe("in_progress");
  });

  it("setExecutionApproved (the panel button) lifts the gate, and pausing re-applies it", async () => {
    const { planId, phaseIds } = await unapprovedPlan();
    store.setExecutionApproved(planId, true);
    expect(store.read().plans.find((p) => p.id === planId)!.executionApproved).toBe(true);
    expect((await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-1", stepStatus: "done" }, CTX) as { ok: boolean }).ok).toBe(true);

    store.setExecutionApproved(planId, false);
    expect((await store.dispatch("update", { planId, phaseId: phaseIds[0], stepId: "step-2", stepStatus: "in_progress" }, CTX) as { ok: boolean }).ok).toBe(false);
  });

  it("flags an unapproved plan in the prompt summary", async () => {
    await unapprovedPlan();
    expect(summarizePlanningStateForPrompt(root)).toMatch(/AWAITING EXECUTION APPROVAL/);
  });

  it("grandfathers plans persisted before the field existed (missing executionApproved reads as approved)", async () => {
    // Simulate an old planning.json with no executionApproved on the plan.
    const legacy = {
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      plans: [{
        id: "plan_legacy", title: "Old plan", status: "active",
        phases: [{ id: "phase-1", title: "Phase A", status: "pending", steps: [{ id: "step-1", title: "Step one", status: "pending" }] }],
      }],
      todoRuns: [],
    };
    fs.writeFileSync(store.filePath(), JSON.stringify(legacy), "utf8");
    // The gate must NOT retroactively block an in-flight legacy plan.
    const res = await store.dispatch("update", { planId: "plan_legacy", phaseId: "phase-1", stepId: "step-1", stepStatus: "done" }, CTX) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(store.read().plans.find((p) => p.id === "plan_legacy")!.executionApproved).toBe(true);
  });
});
