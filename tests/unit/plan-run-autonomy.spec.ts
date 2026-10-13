import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionCenter } from "../../src/chat/attention.js";
import { PlanRunService, type PlanRunHost, type PlanRunPlanningPort } from "../../src/plans/plan-run-service.js";
import { PlanRunStore } from "../../src/plans/plan-run-store.js";
import { normalizeCharter, type PlanRunView } from "../../src/plans/plan-run-model.js";
import type { PlanningDocument, PlanStepStatus, TaskPlan } from "../../src/planning-store.js";
import type { StepChange } from "../../src/plans/run-tripwires.js";
import type { TurnFacts } from "../../src/plans/run-handoff.js";

function makePlan(statuses: PlanStepStatus[][], overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan1",
    title: "Ship it",
    status: "active",
    phases: statuses.map((steps, p) => ({
      id: `p${p + 1}`,
      title: `Phase ${p + 1}`,
      status: "in_progress",
      files: ["src/plans/a.ts"],
      steps: steps.map((status, s) => ({ id: `s${s + 1}`, title: `Step ${p + 1}.${s + 1}`, status, notes: [], updatedAt: "2026-10-12T00:00:00.000Z" })),
      notes: [], blocks: [], docs: [], linkedTodoIds: [], updatedAt: "2026-10-12T00:00:00.000Z",
    })),
    blocks: [], docs: [], agentCanArchive: false, executionApproved: false, notes: [],
    createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  } as TaskPlan;
}

function setStep(plan: TaskPlan, phase: number, step: number, status: PlanStepStatus): void {
  const target = plan.phases[phase]!;
  target.steps[step]!.status = status;
  target.status = target.steps.every((entry) => entry.status === "completed") ? "completed" : "in_progress";
}

const facts = (): TurnFacts => ({ changes: [], unverifiedFiles: [], verificationFailed: false, toolCalls: 0, stepMoves: [] });

interface HostExtras {
  live: boolean;
  launched: Array<{ message: string; origin: string }>;
  views: Array<PlanRunView | null>;
  pauseRequests: number;
  failing?: string;
  changes: StepChange[];
  captures: number;
}

let dirs: string[] = [];

function harness(plan = makePlan([["pending", "pending"], ["pending"]]), withSnapshots = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-autonomy-"));
  dirs.push(dir);
  const doc = { schemaVersion: 2, plans: [plan], todoRuns: [], updatedAt: "" } as unknown as PlanningDocument;
  const planning: PlanRunPlanningPort = {
    read: () => structuredClone(doc),
    setExecutionApproved: (_planId, value) => { plan.executionApproved = value; },
    setPlanStatus: (_planId, status) => { plan.status = status; },
    setStepEvidence: () => undefined,
  };
  const host: PlanRunHost & HostExtras = {
    live: false,
    launched: [],
    views: [],
    pauseRequests: 0,
    changes: [],
    captures: 0,
    sessionInfo: () => ({ sessionId: "sess1", provider: "anthropic", model: "m", messageCount: 3 }),
    isTurnLive() { return host.live; },
    launchTurn(message, launch) { host.launched.push({ message, origin: launch.origin }); host.live = true; },
    requestPause() { host.pauseRequests += 1; },
    cancelTurn() { host.live = false; },
    retryProviderNow() { /* not used */ },
    endGrants() { /* not used */ },
    failingCheck: () => host.failing,
    ...(withSnapshots ? {
      captureSnapshot: async () => { host.captures += 1; return { projects: { "/w": `tree${host.captures}` } }; },
      compareSnapshots: async () => host.changes,
    } : {}),
    publish(view) { host.views.push(view); },
  };
  const store = new PlanRunStore(dir);
  const attention = new AttentionCenter();
  const service = new PlanRunService(store, planning, host, attention, { newId: () => "run_test" });
  service.notePlanChanged(structuredClone(doc));
  return { service, store, attention, plan, host, changed: () => service.notePlanChanged(structuredClone(doc)) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T10:00:00Z")); });
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("charter", () => {
  it("reads the new fields with safe defaults, and old charters as they were meant", () => {
    expect(normalizeCharter({})).toMatchObject({ whenBlocked: "wait", allow: [], tripwires: true });
    expect(normalizeCharter({ pauseWhenBlockedMinutes: 20 })).toMatchObject({ whenBlocked: "pause", pauseWhenBlockedMinutes: 20 });
    expect(normalizeCharter({ whenBlocked: "defer" })).toMatchObject({ whenBlocked: "defer", deferAfterMinutes: 2, pauseWhenBlockedMinutes: undefined });
    expect(normalizeCharter({ whenBlocked: "defer", deferAfterMinutes: 0 }).deferAfterMinutes).toBe(0);
    expect(normalizeCharter({ allow: ["git_commit", "format_disk"], tripwires: false })).toMatchObject({ allow: ["git_commit"], tripwires: false });
  });
});

describe("deferring gates", () => {
  it("only queues for a working run set to defer", () => {
    const waiting = harness();
    waiting.service.start({ planId: "plan1", charter: {} });
    expect(waiting.service.deferralGraceMs()).toBeUndefined();
    expect(waiting.service.deferDecision({ kind: "approval", toolCallId: "t", description: "x" })).toBeUndefined();
    waiting.service.dispose();

    const h = harness();
    h.service.start({ planId: "plan1", charter: { whenBlocked: "defer", deferAfterMinutes: 3 } });
    expect(h.service.deferralGraceMs()).toBe(180_000);
    h.service.pause();
    expect(h.service.deferralGraceMs()).toBeUndefined();
    h.service.dispose();
  });

  it("queues a decision, asks for attention once, and records the answer", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { whenBlocked: "defer" } });
    h.service.noteTurnStart("t1", "run");
    setStep(h.plan, 0, 0, "in_progress");
    h.changed();

    const first = h.service.deferDecision({ kind: "approval", toolCallId: "c1", toolName: "shell_run", description: "Run `git push origin main`", tier: "network", fingerprint: "fp1" });
    expect(first).toMatchObject({ id: "D1", status: "open", stepTitle: "Step 1.1" });
    h.service.deferDecision({ kind: "question", toolCallId: "c2", description: "Which database?", questions: [{ question: "Which database?", options: [{ key: "pg", label: "Postgres" }] }] });

    const view = h.service.view()!;
    expect(view.openDecisions).toBe(2);
    expect(view.decisions.map((decision) => decision.id)).toEqual(["D1", "D2"]);
    expect(h.attention.list().find((item) => item.kind === "run_decisions")?.title).toBe("2 decisions are waiting for you");

    expect(h.service.resolveDecision("D1", "declined", "Declined")?.id).toBe("D1");
    expect(h.service.resolveDecision("D1", "approved")).toBeUndefined();
    expect(h.service.view()!.openDecisions).toBe(1);
    expect(h.attention.list().find((item) => item.kind === "run_decisions")?.title).toBe("1 decision is waiting for you");
    h.service.resolveDecision("D2", "answered", "Which database? → Postgres");
    expect(h.attention.list().some((item) => item.kind === "run_decisions")).toBe(false);
    // The ledger keeps them, answered.
    expect(h.store.read("run_test")?.decisions?.map((decision) => decision.status)).toEqual(["declined", "answered"]);
    h.service.dispose();
  });

  it("keeps the queued-decisions badge through a resume, and drops it when the run ends", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { whenBlocked: "defer" } });
    h.service.noteTurnStart("t1", "run");
    h.service.deferDecision({ kind: "approval", toolCallId: "c1", description: "x" });
    h.host.live = false;
    h.service.pause();
    h.service.resume();
    expect(h.attention.list().some((item) => item.kind === "run_decisions")).toBe(true);
    h.service.stop();
    expect(h.attention.list().some((item) => item.kind === "run_decisions")).toBe(false);
    h.service.dispose();
  });

  it("tells a resumed run what is still waiting, so it works around it", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { whenBlocked: "defer" } });
    h.service.noteTurnStart("t1", "run");
    h.service.deferDecision({ kind: "approval", toolCallId: "c1", description: "Run `npm publish`" });
    h.host.live = false;
    h.service.pause();
    h.service.resume();
    expect(h.host.launched.at(-1)?.message).toContain("Still waiting for the user");
    expect(h.host.launched.at(-1)?.message).toContain("D1 Run `npm publish`");
    h.service.dispose();
  });

  it("lets the conductor stop when everything left is waiting on the user", () => {
    const h = harness(makePlan([["completed", "blocked"], ["blocked"]]));
    h.service.start({ planId: "plan1", charter: { whenBlocked: "defer" } });
    const context = h.service.conductorContext();
    expect(context.waitingOnUserOnly?.()).toBeUndefined(); // blocked, but nothing queued
    h.service.deferDecision({ kind: "approval", toolCallId: "c1", description: "x" });
    expect(context.waitingOnUserOnly?.()).toMatch(/Everything left in the plan is waiting on you: 1 decision is queued \(D1\)/);
    h.plan.phases[1]!.steps[0]!.status = "pending";
    h.changed();
    expect(context.waitingOnUserOnly?.()).toBeUndefined();
    h.service.dispose();
  });
});

describe("records", () => {
  it("counts what ran without asking and keeps the isolation it was started with", () => {
    const h = harness();
    const isolation = { branch: "blacksite/run-ship-it-a1b2c3", baseBranch: "main", baseHead: "abc1234", sourceRoot: "/w", worktreePath: "/home/u/.blacksite/worktrees/w-a1b2c3" };
    h.service.start({ planId: "plan1", charter: { allow: ["project_scripts"] }, isolation });
    h.service.noteAutoAllowed({ by: "charter", toolName: "shell_run", description: "Run `npm test`", reason: "run the project's test, build and lint scripts" });
    h.service.noteAutoAllowed({ by: "reviewer", toolName: "shell_run", description: "Run `tsc`", reason: "type check" });
    const view = h.service.view()!;
    expect(view.autoAllowed).toBe(2);
    expect(view.allow).toEqual(["project_scripts"]);
    expect(view.isolation?.branch).toBe("blacksite/run-ship-it-a1b2c3");
    expect(h.service.runBranch()).toBe("blacksite/run-ship-it-a1b2c3");
    h.service.dispose();
  });
});

describe("tripwires", () => {
  it("pauses at the next boundary when the same failure keeps coming back, and says why", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: {} });
    h.service.noteTurnStart("t1", "run");
    for (let i = 0; i < 5; i += 1) h.service.noteToolFailure("shell_run", `Error: tests failed after ${100 + i}ms`);
    expect(h.host.pauseRequests).toBe(0);
    h.service.noteToolFailure("shell_run", "Error: tests failed after 999ms");
    expect(h.host.pauseRequests).toBe(1);
    expect(h.attention.list().find((item) => item.kind === "run_tripwire")?.title).toBe("Paused: the same failure keeps coming back");

    h.host.live = false;
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "paused", iterations: 3, errored: false, facts: facts() });
    const run = h.service.active!;
    expect(run.status).toBe("paused");
    expect(run.endReason).toMatch(/^The same failure keeps coming back/);
    expect(run.lastHandoff).toMatch(/^Stopped: Paused by a tripwire/);
    expect(h.service.view()!.tripwires).toHaveLength(1);
    h.service.dispose();
  });

  it("still pauses when the turn ends on its own before reaching the pause it was asked for", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: {} });
    h.service.noteTurnStart("t1", "run");
    for (let i = 0; i < 6; i += 1) h.service.noteToolFailure("shell_run", "boom");
    expect(h.service.pauseRequested).toBe(true);
    h.host.live = false;
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "end_turn", iterations: 2, errored: false, facts: facts() });
    expect(h.service.active?.status).toBe("paused");
    expect(h.service.pauseRequested).toBe(false);
    expect(h.service.active?.endReason).toMatch(/^The same failure keeps coming back/);
    expect(h.service.conductorContext().holds()).toBe(true);
    h.service.dispose();
  });

  it("does not count different failures together, and starts over at each step", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: {} });
    h.service.noteTurnStart("t1", "run");
    for (let i = 0; i < 5; i += 1) h.service.noteToolFailure("shell_run", "Error A");
    setStep(h.plan, 0, 0, "in_progress");
    h.changed();
    h.service.noteToolFailure("shell_run", "Error A");
    for (let i = 0; i < 5; i += 1) h.service.noteToolFailure("file_write", "Error A");
    expect(h.host.pauseRequests).toBe(0);
    h.service.dispose();
  });

  it("stays quiet when the user turned tripwires off", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { tripwires: false } });
    h.service.noteTurnStart("t1", "run");
    for (let i = 0; i < 10; i += 1) h.service.noteToolFailure("shell_run", "boom");
    expect(h.host.pauseRequests).toBe(0);
    expect(h.service.view()!.tripwires).toHaveLength(0);
    h.service.dispose();
  });

  it("pauses when a step is marked done while a check that passed earlier fails", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: {} });
    h.service.noteTurnStart("t1", "run");
    h.service.notePassedCheck("npm test");
    setStep(h.plan, 0, 0, "in_progress");
    h.changed();
    h.host.failing = "npm test";
    setStep(h.plan, 0, 0, "completed");
    h.changed();
    expect(h.host.pauseRequests).toBe(1);
    expect(h.service.view()!.tripwires[0]?.kind).toBe("check_regressed");
    h.service.dispose();
  });

  it("pauses when spending suddenly runs far ahead of the run's own pace", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: {} });
    h.service.noteTurnStart("t1", "run");
    for (let minute = 0; minute < 30; minute += 1) {
      vi.advanceTimersByTime(60_000);
      h.service.noteSpend(0.05, false);
    }
    expect(h.host.pauseRequests).toBe(0);
    for (let minute = 0; minute < 6; minute += 1) {
      vi.advanceTimersByTime(60_000);
      h.service.noteSpend(1, false);
    }
    expect(h.host.pauseRequests).toBe(1);
    expect(h.service.view()!.tripwires[0]?.kind).toBe("spend_spike");
    h.service.dispose();
  });

  it("compares what a finished step left on disk and pauses on a mass deletion", async () => {
    const h = harness(makePlan([["pending", "pending"]]), true);
    h.service.start({ planId: "plan1", charter: {} });
    h.service.noteTurnStart("t1", "run");
    await h.service.settleSnapshots();
    h.host.changes = Array.from({ length: 30 }, (_, i) => ({ status: "D", path: `src/plans/f${i}.ts` }));
    setStep(h.plan, 0, 0, "in_progress");
    h.changed();
    setStep(h.plan, 0, 0, "completed");
    h.changed();
    await h.service.settleSnapshots();
    expect(h.host.pauseRequests).toBe(1);
    expect(h.service.view()!.tripwires[0]).toMatchObject({ kind: "mass_delete", title: "Many files were deleted" });
    h.service.dispose();
  });
});
