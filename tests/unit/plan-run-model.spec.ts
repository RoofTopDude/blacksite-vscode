import { describe, expect, it } from "vitest";
import {
  advanceClock,
  applyPlanRunEvent,
  buildPlanRunView,
  createPlanRun,
  diffPlanSteps,
  formatDuration,
  isTerminalRunStatus,
  normalizeCharter,
  setRunStatus,
  type PlanRun,
} from "../../src/plans/plan-run-model.js";
import type { PlanStepStatus, TaskPlan } from "../../src/planning-store.js";

function plan(statuses: PlanStepStatus[][], overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan1",
    title: "Ship it",
    status: "active",
    phases: statuses.map((steps, p) => ({
      id: `p${p + 1}`,
      title: `Phase ${p + 1}`,
      status: steps.every((s) => s === "completed") ? "completed" : "in_progress",
      steps: steps.map((status, s) => ({ id: `s${s + 1}`, title: `Step ${p + 1}.${s + 1}`, status, notes: [], updatedAt: "2026-10-09T00:00:00.000Z" })),
      notes: [], blocks: [], docs: [], linkedTodoIds: [], updatedAt: "2026-10-09T00:00:00.000Z",
    })),
    blocks: [], docs: [], agentCanArchive: false, executionApproved: true, notes: [],
    createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as TaskPlan;
}

function newRun(p: TaskPlan, now = 1_000): PlanRun {
  return createPlanRun({ id: "run1", plan: p, sessionId: "sess", charter: normalizeCharter({}), now });
}

describe("normalizeCharter", () => {
  it("keeps sane ceilings and drops nonsense", () => {
    const charter = normalizeCharter({ maxUsd: 12.5, maxMinutes: -3, pauseWhenBlockedMinutes: "20", providerWaitMinutes: 99999, notifications: "all" });
    expect(charter.maxUsd).toBe(12.5);
    expect(charter.maxMinutes).toBeUndefined();
    expect(charter.pauseWhenBlockedMinutes).toBe(20);
    expect(charter.providerWaitMinutes).toBe(240);
    expect(charter.notifications).toBe("all");
  });

  it("defaults to a 30 minute provider wait and attention-level notifications", () => {
    expect(normalizeCharter(undefined)).toMatchObject({ providerWaitMinutes: 30, notifications: "attention" });
  });
});

describe("clock accounting", () => {
  it("charges elapsed time to the bucket the run is in", () => {
    const run = newRun(plan([["pending"]]), 0);
    advanceClock(run, 10_000);
    setRunStatus(run, "waiting_user", 10_000);
    advanceClock(run, 40_000);
    setRunStatus(run, "waiting_provider", 40_000);
    advanceClock(run, 45_000);
    setRunStatus(run, "running", 45_000);
    advanceClock(run, 50_000);
    expect(run.activeMs).toBe(15_000);
    expect(run.waitingUserMs).toBe(30_000);
    expect(run.waitingProviderMs).toBe(5_000);
  });

  it("stops charging while paused", () => {
    const run = newRun(plan([["pending"]]), 0);
    setRunStatus(run, "paused", 5_000, "by you");
    advanceClock(run, 500_000);
    expect(run.activeMs).toBe(5_000);
    expect(run.endedAt).toBeUndefined();
  });

  it("ends a terminal run once and treats failed as resumable", () => {
    const run = newRun(plan([["pending"]]), 0);
    setRunStatus(run, "failed", 1_000, "boom");
    expect(isTerminalRunStatus(run.status)).toBe(false);
    expect(run.endedAt).toBeUndefined();
    setRunStatus(run, "completed", 2_000);
    setRunStatus(run, "completed", 9_000, "again");
    expect(run.endedAt).toBe(2_000);
  });
});

describe("applyPlanRunEvent", () => {
  it("records step starts, attempts and completions against the turn that did the work", () => {
    const run = newRun(plan([["pending", "pending"]]), 0);
    applyPlanRunEvent(run, { type: "turn_started", at: 100, turnId: "t1", origin: "run" });
    applyPlanRunEvent(run, { type: "step_started", at: 200, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    applyPlanRunEvent(run, { type: "step_completed", at: 900, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    applyPlanRunEvent(run, { type: "step_started", at: 1_000, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    const step = run.steps.find((entry) => entry.stepId === "s1")!;
    expect(step.attempts).toBe(2);
    expect(step.startedAt).toBe(200);
    expect(step.turnIds).toEqual(["t1"]);
    expect(run.turns[0]!.stepTransitions).toBe(3);
  });

  it("counts an automatic turn that moved nothing as a turn without progress", () => {
    const run = newRun(plan([["pending"]]), 0);
    applyPlanRunEvent(run, { type: "turn_started", at: 1, turnId: "t1", origin: "conductor" });
    applyPlanRunEvent(run, { type: "turn_ended", at: 2, turnId: "t1", stopReason: "end_turn", iterations: 3 });
    applyPlanRunEvent(run, { type: "turn_started", at: 3, turnId: "t2", origin: "conductor" });
    applyPlanRunEvent(run, { type: "turn_ended", at: 4, turnId: "t2", stopReason: "end_turn", iterations: 3 });
    expect(run.turnsWithoutProgress).toBe(2);
    applyPlanRunEvent(run, { type: "turn_started", at: 5, turnId: "t3", origin: "conductor" });
    applyPlanRunEvent(run, { type: "step_started", at: 6, phaseId: "p1", stepId: "s1", title: "x" });
    expect(run.turnsWithoutProgress).toBe(0);
  });

  it("does not count the user's own turns against the run", () => {
    const run = newRun(plan([["pending"]]), 0);
    applyPlanRunEvent(run, { type: "turn_started", at: 1, turnId: "t1", origin: "user" });
    applyPlanRunEvent(run, { type: "turn_ended", at: 2, turnId: "t1", stopReason: "end_turn", iterations: 1 });
    expect(run.turnsWithoutProgress).toBe(0);
  });

  it("tracks spend, retries, compactions and a step added mid-run", () => {
    const run = newRun(plan([["pending"]]), 0);
    applyPlanRunEvent(run, { type: "spend", at: 1, usd: 0.25, partial: false });
    applyPlanRunEvent(run, { type: "spend", at: 2, usd: 0.5, partial: true });
    applyPlanRunEvent(run, { type: "provider_retry", at: 3 });
    applyPlanRunEvent(run, { type: "compaction", at: 4 });
    applyPlanRunEvent(run, { type: "step_started", at: 5, phaseId: "p1", stepId: "s9", title: "Added later" });
    expect(run.spentUsd).toBeCloseTo(0.75);
    expect(run.spendPartial).toBe(true);
    expect(run.retries).toBe(1);
    expect(run.compactions).toBe(1);
    expect(run.steps.some((entry) => entry.stepId === "s9")).toBe(true);
  });

  it("stores snapshots against a step and the baseline against the run", () => {
    const run = newRun(plan([["pending"]]), 0);
    applyPlanRunEvent(run, { type: "snapshot", at: 1, projects: { "/ws": "tree0" }, messageCount: 4 });
    applyPlanRunEvent(run, { type: "snapshot", at: 2, phaseId: "p1", stepId: "s1", projects: { "/ws": "tree1" }, messageCount: 9 });
    applyPlanRunEvent(run, { type: "snapshot", at: 3, projects: {}, skipped: "git is not installed" });
    expect(run.baseline).toEqual({ "/ws": "tree0" });
    expect(run.steps[0]!.snapshots).toEqual({ "/ws": "tree1" });
    expect(run.steps[0]!.messageCount).toBe(9);
    expect(run.snapshotNote).toBe("git is not installed");
  });
});

describe("diffPlanSteps", () => {
  it("reports transitions and ignores steps that merely appeared pending", () => {
    const before = plan([["pending", "in_progress", "pending"]]);
    const after = plan([["in_progress", "completed", "blocked", "pending"]]);
    const kinds = diffPlanSteps(before, after, 5).map((event) => `${event.type}:${(event as { stepId: string }).stepId}`);
    expect(kinds).toEqual(["step_started:s1", "step_completed:s2", "step_blocked:s3"]);
  });

  it("treats a step that returned to pending as a reset", () => {
    const events = diffPlanSteps(plan([["in_progress"]]), plan([["pending"]]), 1);
    expect(events.map((event) => event.type)).toEqual(["step_reset"]);
  });

  it("reports nothing without a plan", () => {
    expect(diffPlanSteps(plan([["pending"]]), undefined, 1)).toEqual([]);
  });
});

describe("buildPlanRunView", () => {
  it("shows the step in progress as current and the next pending step after it", () => {
    const p = plan([["completed", "in_progress", "pending"], ["pending"]]);
    const run = newRun(p, 0);
    applyPlanRunEvent(run, { type: "step_started", at: 100, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    applyPlanRunEvent(run, { type: "step_completed", at: 4_100, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    applyPlanRunEvent(run, { type: "step_started", at: 4_200, phaseId: "p1", stepId: "s2", title: "Step 1.2" });
    const view = buildPlanRunView(run, p, { now: 10_000 });
    expect(view.stepPosition).toBe(2);
    expect(view.stepsTotal).toBe(4);
    expect(view.stepsDone).toBe(1);
    expect(view.phaseIndex).toBe(1);
    expect(view.currentStep).toMatchObject({ stepId: "s2" });
    expect(view.nextStep).toMatchObject({ stepId: "s3" });
    expect(view.medianStepMs).toBe(4_000);
    expect(view.phases[0]!.steps[1]!.durationMs).toBe(5_800);
    expect(view.liveState).toBe("working");
  });

  it("falls back to the first open step when nothing is in progress", () => {
    const p = plan([["completed", "pending"]]);
    const view = buildPlanRunView(newRun(p, 0), p, { now: 5 });
    expect(view.currentStep).toMatchObject({ stepId: "s2" });
    expect(view.stepPosition).toBe(2);
  });

  it("reports needs_you, provider, quiet and the terminal states in one word each", () => {
    const p = plan([["in_progress"]]);
    const run = newRun(p, 0);
    expect(buildPlanRunView(run, p, { now: 400_000, lastProgressAt: 0 }).liveState).toBe("quiet");
    setRunStatus(run, "waiting_user", 10);
    expect(buildPlanRunView(run, p, { now: 20 }).liveState).toBe("needs_you");
    setRunStatus(run, "waiting_provider", 20);
    const waiting = buildPlanRunView(run, p, { now: 30, providerRetryAt: 99, providerWaitReason: "overloaded" });
    expect(waiting.liveState).toBe("provider");
    expect(waiting.providerRetryAt).toBe(99);
    setRunStatus(run, "failed", 40);
    expect(buildPlanRunView(run, p, { now: 50 }).liveState).toBe("failed");
    setRunStatus(run, "completed", 60);
    expect(buildPlanRunView(run, p, { now: 70 }).liveState).toBe("done");
  });

  it("charges the live stretch to the current bucket without mutating the run", () => {
    const p = plan([["in_progress"]]);
    const run = newRun(p, 0);
    const view = buildPlanRunView(run, p, { now: 7_000 });
    expect(view.activeMs).toBe(7_000);
    expect(run.activeMs).toBe(0);
  });

  it("uses the plan as the source of truth for what is done", () => {
    const p = plan([["completed", "completed"]]);
    const view = buildPlanRunView(newRun(p, 0), p, { now: 1 });
    expect(view.stepsDone).toBe(2);
    expect(view.currentStep).toBeUndefined();
    expect(view.stepPosition).toBe(2);
  });
});

describe("formatDuration", () => {
  it("is compact at every scale", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(7 * 60_000 + 12_000)).toBe("7m 12s");
    expect(formatDuration(65 * 60_000)).toBe("1h 05m");
  });
});
