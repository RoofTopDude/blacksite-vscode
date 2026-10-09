import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionCenter } from "../../src/chat/attention.js";
import { PlanRunService, type PlanRunHost, type PlanRunPlanningPort } from "../../src/plans/plan-run-service.js";
import { PlanRunStore } from "../../src/plans/plan-run-store.js";
import type { PlanRunView } from "../../src/plans/plan-run-model.js";
import type { PlanningDocument, PlanStepStatus, StepEvidence, TaskPlan } from "../../src/planning-store.js";
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
      steps: steps.map((status, s) => ({ id: `s${s + 1}`, title: `Step ${p + 1}.${s + 1}`, status, notes: [], updatedAt: "2026-10-09T00:00:00.000Z" })),
      notes: [], blocks: [], docs: [], linkedTodoIds: [], updatedAt: "2026-10-09T00:00:00.000Z",
    })),
    blocks: [], docs: [], agentCanArchive: false, executionApproved: false, notes: [],
    createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as TaskPlan;
}

function setStep(plan: TaskPlan, phase: number, step: number, status: PlanStepStatus): void {
  const target = plan.phases[phase]!;
  target.steps[step]!.status = status;
  target.status = target.steps.every((entry) => entry.status === "completed") ? "completed" : "in_progress";
}

const facts = (overrides: Partial<TurnFacts> = {}): TurnFacts => ({
  changes: [], unverifiedFiles: [], verificationFailed: false, toolCalls: 0, stepMoves: [], ...overrides,
});

interface Harness {
  service: PlanRunService;
  store: PlanRunStore;
  attention: AttentionCenter;
  doc: PlanningDocument;
  plan: TaskPlan;
  host: PlanRunHost & {
    live: boolean;
    launched: Array<{ message: string; origin: string }>;
    views: Array<PlanRunView | null>;
    pauseRequests: number;
    cancels: number;
    grantEnds: number;
    reports: number;
    retries: number;
  };
  approved: string[];
  evidence: Array<[string, string, string]>;
  dir: string;
  /** Announce the plan as the store would: a fresh copy, never the object the test mutates. */
  changed(): void;
}

let dirs: string[] = [];

function harness(plan = makePlan([["pending", "pending"], ["pending"]]), options: { evidence?: StepEvidence } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-run-"));
  dirs.push(dir);
  const doc = { schemaVersion: 2, plans: [plan], todoRuns: [], updatedAt: "" } as unknown as PlanningDocument;
  const approved: string[] = [];
  const evidence: Array<[string, string, string]> = [];
  const planning: PlanRunPlanningPort = {
    read: () => structuredClone(doc),
    setExecutionApproved: (planId, value) => { if (value) approved.push(planId); plan.executionApproved = value; },
    setPlanStatus: (_planId, status) => { plan.status = status; },
    setStepEvidence: (planId, phaseId, stepId) => { evidence.push([planId, phaseId, stepId]); },
  };
  const host = {
    live: false,
    launched: [] as Array<{ message: string; origin: string }>,
    views: [] as Array<PlanRunView | null>,
    pauseRequests: 0,
    cancels: 0,
    grantEnds: 0,
    reports: 0,
    retries: 0,
    sessionInfo: () => ({ sessionId: "sess1", provider: "anthropic", model: "m", messageCount: 3 }),
    isTurnLive() { return host.live; },
    launchTurn(message: string, launch: { origin: string }) { host.launched.push({ message, origin: launch.origin }); host.live = true; },
    requestPause() { host.pauseRequests += 1; },
    cancelTurn() { host.cancels += 1; host.live = false; },
    retryProviderNow() { host.retries += 1; },
    endGrants() { host.grantEnds += 1; },
    collectEvidence: options.evidence ? () => options.evidence : undefined,
    saveReport() { host.reports += 1; },
    publish(view: PlanRunView | null) { host.views.push(view); },
  };
  const store = new PlanRunStore(dir);
  const attention = new AttentionCenter();
  const service = new PlanRunService(store, planning, host as unknown as PlanRunHost, attention, { newId: () => "run_test" });
  // The service reads its plan from the cached copy the plan store last announced.
  service.notePlanChanged(structuredClone(doc));
  return { service, store, attention, doc, plan, host, approved, evidence, dir, changed: () => service.notePlanChanged(structuredClone(doc)) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00Z")); });
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("PlanRunService.start", () => {
  it("opens a run, approves the plan, writes the ledger and launches the kickoff turn", () => {
    const h = harness();
    const result = h.service.start({ planId: "plan1", charter: { maxUsd: 5 } });
    expect(result.ok).toBe(true);
    expect(h.approved).toEqual(["plan1"]);
    expect(h.host.launched).toHaveLength(1);
    expect(h.host.launched[0]!.origin).toBe("run");
    expect(h.host.launched[0]!.message).toContain('Execute the plan "Ship it"');
    expect(h.service.active?.charter.maxUsd).toBe(5);
    expect(h.store.read("run_test")?.status).toBe("running");
    expect(h.host.views.at(-1)?.stepsTotal).toBe(3);
    expect(fs.existsSync(path.join(h.dir, ".blacksite", "plan-runs", ".gitignore"))).toBe(true);
    h.service.dispose();
  });

  it("does not launch a second turn when one is already live, and refuses a second run", () => {
    const h = harness();
    h.host.live = true;
    expect(h.service.start({ planId: "plan1" }).ok).toBe(true);
    expect(h.host.launched).toHaveLength(0);
    expect(h.service.start({ planId: "plan1" })).toMatchObject({ ok: false });
    h.service.dispose();
  });

  it("refuses a plan that is finished or missing", () => {
    const h = harness(makePlan([["completed"]]));
    expect(h.service.start({ planId: "plan1" })).toMatchObject({ ok: false });
    expect(h.service.start({ planId: "nope" })).toMatchObject({ ok: false });
    h.service.dispose();
  });

  it("activates a draft plan so the conductor has something to drive", () => {
    const h = harness(makePlan([["pending"]], { status: "draft" }));
    h.service.start({ planId: "plan1" });
    expect(h.plan.status).toBe("active");
    h.service.dispose();
  });
});

describe("step tracking", () => {
  it("records transitions with timings and finishes the run when the plan completes", () => {
    const h = harness(makePlan([["pending", "pending"]]), { evidence: { checks: ["npm test"], unverified: [], filesChanged: ["a.ts"], at: "now" } });
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");

    setStep(h.plan, 0, 0, "in_progress");
    h.changed();
    vi.advanceTimersByTime(60_000);
    setStep(h.plan, 0, 0, "completed");
    h.changed();

    const step = h.service.active!.steps[0]!;
    expect(step.startedAt).toBeDefined();
    expect(step.endedAt! - step.startedAt!).toBe(60_000);
    expect(h.evidence).toEqual([["plan1", "p1", "s1"]]);

    setStep(h.plan, 0, 1, "in_progress");
    h.changed();
    setStep(h.plan, 0, 1, "completed");
    h.changed();

    expect(h.service.active).toBeUndefined();
    expect(h.service.current?.status).toBe("completed");
    expect(h.host.grantEnds).toBe(1);
    expect(h.host.reports).toBe(1);
    expect(h.attention.list().map((item) => item.kind)).toContain("run_done");
    h.service.dispose();
  });

  it("stops the run if the plan is cancelled or deleted", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.plan.status = "cancelled";
    h.changed();
    expect(h.service.current?.status).toBe("stopped");
    h.service.dispose();

    const h2 = harness();
    h2.service.start({ planId: "plan1" });
    h2.doc.plans = [];
    h2.service.notePlanChanged(structuredClone(h2.doc));
    expect(h2.service.current?.status).toBe("stopped");
    h2.service.dispose();
  });

  it("pauses when the plan is put on hold and says when it was the spend ceiling", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.plan.status = "on_hold";
    h.plan.budget = { maxUsd: 5, spentUsd: 5, partial: false, exceeded: true, warned: true };
    h.changed();
    expect(h.service.active?.status).toBe("paused");
    expect(h.attention.list().map((item) => item.kind)).toContain("budget");
    h.service.dispose();
  });
});

describe("waiting", () => {
  it("charges the time a run spends blocked on the user to that bucket", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    vi.advanceTimersByTime(10_000);
    h.service.noteAgentEvent({ type: "approval_pending", toolCallId: "c1", description: "npm install" });
    expect(h.service.active?.status).toBe("waiting_user");
    vi.advanceTimersByTime(90_000);
    h.service.noteAgentEvent({ type: "approval_result", toolCallId: "c1", granted: true });
    expect(h.service.active?.status).toBe("running");
    vi.advanceTimersByTime(5_000);
    const view = h.service.view()!;
    expect(view.waitingUserMs).toBe(90_000);
    expect(view.activeMs).toBe(15_000);
    expect(h.service.active?.gatesAnswered).toBe(1);
    h.service.dispose();
  });

  it("stays blocked until every open gate in a parallel batch is answered", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteAgentEvent({ type: "approval_pending", toolCallId: "a" });
    h.service.noteAgentEvent({ type: "question_card_pending", toolCallId: "b" });
    h.service.noteAgentEvent({ type: "approval_result", toolCallId: "a" });
    expect(h.service.active?.status).toBe("waiting_user");
    h.service.noteAgentEvent({ type: "question_card_result", toolCallId: "b" });
    expect(h.service.active?.status).toBe("running");
    h.service.dispose();
  });

  it("waits out a provider outage and resumes on the first sign of life", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    const retryAt = Date.now() + 30_000;
    h.service.noteAgentEvent({ type: "provider_activity", phase: "retrying", message: "anthropic is unavailable", outage: true, retryAt });
    expect(h.service.active?.status).toBe("waiting_provider");
    expect(h.service.view()?.providerRetryAt).toBe(retryAt);
    expect(h.service.providerOutageWaitMs()).toBe(30 * 60_000);
    expect(h.attention.list().map((item) => item.kind)).toContain("provider_wait");
    vi.advanceTimersByTime(30_000);
    h.service.noteAgentEvent({ type: "text_delta", text: "hi" });
    expect(h.service.active?.status).toBe("running");
    expect(h.service.view()?.waitingProviderMs).toBe(30_000);
    expect(h.attention.list().map((item) => item.kind)).not.toContain("provider_wait");
    h.service.dispose();
  });

  it("offers no outage wait without a run", () => {
    const h = harness();
    expect(h.service.providerOutageWaitMs()).toBe(0);
    h.service.dispose();
  });

  it("passes Retry now through to the session only while waiting", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.retryProvider();
    expect(h.host.retries).toBe(0);
    h.service.noteAgentEvent({ type: "provider_activity", phase: "retrying", message: "x", outage: true, retryAt: 1 });
    h.service.retryProvider();
    expect(h.host.retries).toBe(1);
    h.service.dispose();
  });

  it("counts compactions and provider retries", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteAgentEvent({ type: "runtime_state", state: { compressionCount: 1 } });
    h.service.noteAgentEvent({ type: "runtime_state", state: { compressionCount: 3 } });
    h.service.noteAgentEvent({ type: "provider_activity", phase: "retrying", message: "retrying in 1s" });
    expect(h.service.active?.compactions).toBe(3);
    expect(h.service.active?.retries).toBe(1);
    h.service.dispose();
  });
});

describe("pause, stop and turn ends", () => {
  it("asks a live turn to pause at its next boundary and settles when it does", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.service.pause();
    expect(h.host.pauseRequests).toBe(1);
    expect(h.service.view()?.pauseRequested).toBe(true);
    expect(h.service.conductorContext().active()).toBeUndefined();
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "paused", iterations: 4, errored: false, facts: facts() });
    h.host.live = false;
    expect(h.service.active?.status).toBe("paused");
    expect(h.service.active?.lastHandoff).toContain("Stopped: Paused at the end of a step.");
    expect(h.service.view()?.pauseRequested).toBe(false);
    h.service.dispose();
  });

  it("pauses at once between turns", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.host.live = false;
    h.service.pause();
    expect(h.service.active?.status).toBe("paused");
    expect(h.host.pauseRequests).toBe(0);
    h.service.dispose();
  });

  it("treats a cancelled turn as a pause, not the end of the run", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "cancelled", iterations: 2, errored: false, facts: facts() });
    expect(h.service.active?.status).toBe("paused");
    h.service.dispose();
  });

  it("stops for good on request, cancelling the turn and dropping the run's approvals", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.service.stop();
    expect(h.host.cancels).toBe(1);
    expect(h.host.grantEnds).toBe(1);
    expect(h.service.active).toBeUndefined();
    expect(h.service.current?.status).toBe("stopped");
    expect(h.service.current?.lastHandoff).toContain("Stopped");
    h.service.dispose();
  });

  it("turns an error stop into a resumable failure with an attention item", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "error", iterations: 1, errored: true, errorMessage: "529 overloaded", facts: facts() });
    expect(h.service.active?.status).toBe("failed");
    expect(h.attention.list().map((item) => item.kind)).toContain("run_failed");
    expect(h.service.resume().ok).toBe(true);
    expect(h.service.active?.status).toBe("running");
    expect(h.attention.list().map((item) => item.kind)).not.toContain("run_failed");
    h.service.dispose();
  });

  it("keeps a run going past the iteration limit, with a handoff for the next turn", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "max_iterations", iterations: 40, maxIterations: 40, errored: false, facts: facts({ changes: [{ path: "a.ts", additions: 1, deletions: 0 }] }) });
    expect(h.service.active?.status).toBe("running");
    expect(h.service.active?.lastHandoff).toContain("Reached the 40-round limit");
    h.service.dispose();
  });

  it("does not resume a plan that is on hold", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.host.live = false;
    h.service.pause();
    h.plan.status = "on_hold";
    h.changed();
    expect(h.service.resume()).toMatchObject({ ok: false });
    h.service.dispose();
  });

  it("keeps a paused run paused when the user asks a side question", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.host.live = false;
    h.service.pause();
    h.service.noteTurnStart("t9", "user");
    expect(h.service.active?.status).toBe("paused");
    h.service.dispose();
  });
});

describe("ceilings", () => {
  it("stops the run and the turn when the spend ceiling is reached", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { maxUsd: 1 } });
    h.host.live = true;
    h.service.noteSpend(0.6, false);
    expect(h.service.active?.status).toBe("running");
    h.service.noteSpend(0.5, false);
    expect(h.host.cancels).toBe(1);
    expect(h.service.current?.status).toBe("budget_exhausted");
    expect(h.attention.list().map((item) => item.kind)).toContain("budget");
    h.service.dispose();
  });

  it("stops at the time ceiling, counting waits but not pauses", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { maxMinutes: 10 } });
    vi.advanceTimersByTime(9 * 60_000);
    expect(h.service.active?.status).toBe("running");
    vi.advanceTimersByTime(90_000);
    expect(h.service.current?.status).toBe("budget_exhausted");
    h.service.dispose();
  });

  it("pauses a run that has waited too long on the user", () => {
    const h = harness();
    h.service.start({ planId: "plan1", charter: { pauseWhenBlockedMinutes: 5 } });
    h.host.live = true;
    h.service.noteAgentEvent({ type: "approval_pending", toolCallId: "a", description: "rm -rf build" });
    vi.advanceTimersByTime(6 * 60_000);
    expect(h.host.cancels).toBe(1);
    expect(h.service.active?.status).toBe("paused");
    expect(h.service.active?.lastHandoff).toContain("Waiting on you");
    h.service.dispose();
  });

  it("flags a run that has gone quiet, and clears it when output returns", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.host.live = true;
    vi.advanceTimersByTime(11 * 60_000);
    expect(h.attention.list().map((item) => item.kind)).toContain("run_stalled");
    h.service.noteProgress();
    expect(h.attention.list().map((item) => item.kind)).not.toContain("run_stalled");
    h.service.dispose();
  });
});

describe("recovery", () => {
  it("marks a run left working by a dead host as interrupted and resumes it with the brief", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    setStep(h.plan, 0, 0, "in_progress");
    h.changed();
    h.service.dispose();

    const fresh = new PlanRunService(
      h.store,
      { read: () => structuredClone(h.doc), setExecutionApproved: () => undefined, setPlanStatus: () => undefined, setStepEvidence: () => undefined },
      h.host,
      new AttentionCenter(),
      { newId: () => "run_other" },
    );
    const recovered = fresh.recover();
    expect(recovered?.id).toBe("run_test");
    expect(fresh.active?.status).toBe("interrupted");
    expect(fresh.attention.list().map((item) => item.kind)).toContain("run_interrupted");

    h.host.live = false;
    h.host.launched.length = 0;
    expect(fresh.resume().ok).toBe(true);
    expect(h.host.launched[0]!.origin).toBe("resume");
    expect(h.host.launched[0]!.message).toContain("[Plan run resumed]");
    expect(fresh.conductorContext().triggerHint()).toBe("interrupted");
    expect(fresh.conductorContext().triggerHint()).toBeUndefined();
    fresh.dispose();
  });

  it("finds nothing to recover when every run has ended", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.stop();
    h.service.dispose();
    const fresh = new PlanRunService(h.store, { read: () => structuredClone(h.doc), setExecutionApproved: () => undefined, setPlanStatus: () => undefined, setStepEvidence: () => undefined }, h.host, new AttentionCenter());
    expect(fresh.recover()).toBeUndefined();
    fresh.dispose();
  });
});

describe("conductor context", () => {
  it("is active only while running, and counts automatic turns that moved nothing", () => {
    const h = harness();
    expect(h.service.conductorContext().active()).toBeUndefined();
    h.service.start({ planId: "plan1" });
    const ctx = h.service.conductorContext();
    expect(ctx.active()).toEqual({ planId: "plan1", consecutive: 0 });
    h.service.noteTurnStart("t1", "conductor");
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "end_turn", iterations: 2, errored: false, facts: facts() });
    expect(ctx.active()).toEqual({ planId: "plan1", consecutive: 1 });
    h.service.dispose();
  });

  it("hands the conductor the harness's own account of the turn", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    const ctx = h.service.conductorContext();
    h.service.noteTurnStart("t1", "run");
    setStep(h.plan, 0, 0, "in_progress");
    h.changed();
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "end_turn", iterations: 2, errored: false, facts: facts({ toolCalls: 5, changes: [{ path: "a.ts", additions: 4, deletions: 0 }], unverifiedFiles: ["a.ts"] }) });
    const digest = ctx.digest()!;
    expect(digest).toContain('in progress "Step 1.1"');
    expect(digest).toContain("Not checked: a.ts");
    expect(ctx.ledgerAttempts().get("p1/s1")).toBe(1);
    expect(ctx.ledgerAttempts().get("p2/s1")).toBe(0);
    h.service.dispose();
  });

  it("hints step_failed after a turn that blocked a step", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    const ctx = h.service.conductorContext();
    h.service.noteTurnStart("t1", "run");
    setStep(h.plan, 0, 0, "blocked");
    h.changed();
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "end_turn", iterations: 2, errored: false, facts: facts() });
    expect(ctx.triggerHint()).toBe("step_failed");
    h.service.dispose();
  });

  it("remembers what it decided so it is not asked twice", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    const ctx = h.service.conductorContext();
    ctx.record({ trigger: "executor_question", kind: "continue", text: "Use the existing schema." });
    ctx.record({ trigger: "stalled", kind: "halt", text: "Stopped for safety." });
    expect(ctx.priorDecisions()).toEqual(["Continued (executor_question): Use the existing schema."]);
    h.service.dispose();
  });

  it("holds the run for a question and pauses it for a halt", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    const ctx = h.service.conductorContext();
    ctx.stopped("ask", "Which database should this use?");
    expect(h.service.active?.status).toBe("waiting_user");
    expect(h.attention.list().map((item) => item.kind)).toContain("conductor_ask");
    h.service.noteTurnStart("t2", "user");
    expect(h.service.active?.status).toBe("running");

    ctx.stopped("halt", "Stopped for safety: would delete data.");
    expect(h.service.active?.status).toBe("paused");
    expect(h.attention.list().map((item) => item.kind)).toContain("conductor_halt");
    h.service.dispose();
  });
});

describe("persistence", () => {
  it("writes the ledger and an event log that survive the service", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.noteTurnStart("t1", "run");
    h.service.noteTurnEnd({ turnId: "t1", stopReason: "end_turn", iterations: 1, errored: false, facts: facts() });
    h.service.dispose();
    const events = h.store.readEvents("run_test").map((event) => event.type);
    expect(events).toContain("run_started");
    expect(events).toContain("turn_started");
    expect(events).toContain("turn_ended");
    expect(h.store.read("run_test")?.turns).toHaveLength(1);
  });

  it("prunes old finished runs and keeps unfinished ones", () => {
    const h = harness();
    h.service.start({ planId: "plan1" });
    h.service.stop();
    h.service.dispose();
    expect(h.store.prune(30)).toBe(0);
    vi.setSystemTime(new Date("2026-12-31T00:00:00Z"));
    expect(h.store.prune(30)).toBe(1);
    expect(h.store.list()).toHaveLength(0);
  });

  it("rejects a run id that could escape the folder", () => {
    const h = harness();
    expect(() => h.store.runDir("../x")).toThrow();
    expect(h.store.read("../x")).toBeNull();
    h.service.dispose();
  });
});
