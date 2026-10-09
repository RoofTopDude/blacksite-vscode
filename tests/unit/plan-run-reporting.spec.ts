import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningStore, type PlanStepStatus, type TaskPlan } from "../../src/planning-store.js";
import { activeExecutingPlan, continuationGate, type ContinuationGateInputs } from "../../src/plans/plan-continuation.js";
import { PlanContinuationService, type PlanContinuationRunContext } from "../../src/plans/plan-continuation-service.js";
import { applyPlanRunEvent, createPlanRun, normalizeCharter, setRunStatus } from "../../src/plans/plan-run-model.js";
import { attemptsFor, buildPlanBrief, currentStepOf, describeEvidence } from "../../src/plans/plan-recovery.js";
import { buildPreflight, lintPlan } from "../../src/plans/run-preflight.js";
import { buildRunReport, runReportTitle } from "../../src/plans/run-report.js";
import { presentRun } from "../../src/plans/run-status-text.js";
import { buildPlanRunView } from "../../src/plans/plan-run-model.js";
import { buildContinuationUserPrompt } from "../../src/continuation/continuation-model.js";

function plan(statuses: PlanStepStatus[][], overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan1",
    title: "Ship billing",
    status: "active",
    phases: statuses.map((steps, p) => ({
      id: `p${p + 1}`,
      title: `Phase ${p + 1}`,
      status: "in_progress",
      steps: steps.map((status, s) => ({ id: `s${s + 1}`, title: `Step ${p + 1}.${s + 1}`, status, notes: [], updatedAt: "2026-10-09T00:00:00.000Z" })),
      notes: [], blocks: [], docs: [], linkedTodoIds: [], updatedAt: "2026-10-09T00:00:00.000Z",
    })),
    blocks: [], docs: [], agentCanArchive: false, executionApproved: true, notes: [],
    createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as TaskPlan;
}

describe("lintPlan", () => {
  it("flags the gaps that most often stall an unattended run, and nothing else", () => {
    const p = plan([["pending", "blocked", "pending"], ["pending"]]);
    p.blocks = [{ id: "b1", kind: "open_questions", label: "Questions", body: "Which database?", updatedAt: "" }];
    p.phases[0]!.steps[0]!.acceptanceCriteria = "tests pass";
    const findings = lintPlan(p);
    const messages = findings.map((finding) => finding.message).join("\n");
    expect(messages).toContain("blocked");
    expect(messages).toContain("no definition of done");
    expect(messages).toContain("open questions");
    expect(messages).toContain("name no files");
    expect(findings.filter((finding) => finding.level === "warn").length).toBeGreaterThanOrEqual(3);
  });

  it("is quiet about a plan that says how each step is checked", () => {
    const p = plan([["pending"]]);
    p.phases[0]!.steps[0]!.acceptanceCriteria = "unit tests pass";
    p.phases[0]!.files = ["src/a.ts"];
    expect(lintPlan(p)).toEqual([]);
  });

  it("warns about a plan with nothing left to do", () => {
    expect(lintPlan(plan([["completed"]]))[0]!.message).toMatch(/already done/);
  });

  it("notes oversized phases and dangling dependencies without blocking", () => {
    const p = plan([Array.from({ length: 14 }, () => "pending" as PlanStepStatus)]);
    p.phases[0]!.dependsOn = ["gone"];
    p.phases[0]!.files = ["a.ts"];
    p.phases[0]!.steps.forEach((step) => { step.acceptanceCriteria = "x"; });
    const findings = lintPlan(p);
    expect(findings.every((finding) => finding.level === "info")).toBe(true);
    expect(findings.map((finding) => finding.message).join("\n")).toMatch(/more than 12 steps/);
    expect(findings.map((finding) => finding.message).join("\n")).toMatch(/phases that no longer exist/);
  });
});

describe("buildPreflight", () => {
  it("lets a plan with warnings start, but not one that cannot", () => {
    const p = plan([["pending"]]);
    const ok = buildPreflight({ plan: p, projects: [], approvalMode: "ask" });
    expect(ok.canStart).toBe(true);
    expect(ok.stepsOpen).toBe(1);
    expect(buildPreflight({ plan: plan([["pending"]], { status: "on_hold" }), projects: [], approvalMode: "ask" }).blocker).toMatch(/on hold/);
    expect(buildPreflight({ plan: plan([["completed"]]), projects: [], approvalMode: "ask" }).canStart).toBe(false);
    expect(buildPreflight({ plan: p, projects: [], approvalMode: "ask", runOpen: true }).blocker).toMatch(/already open/);
  });

  it("lists projects with problems first and bounds a large workspace", () => {
    const projects = Array.from({ length: 20 }, (_, i) => ({ name: `svc-${i}`, root: `svc-${i}`, files: i, issues: i === 19 ? ["Node 20 needed, 18 installed"] : [] }));
    const report = buildPreflight({ plan: plan([["pending"]]), projects, approvalMode: "auto" });
    expect(report.projects).toHaveLength(12);
    expect(report.moreProjects).toBe(8);
    expect(report.projects[0]!.name).toBe("svc-19");
    expect(report.approvalMode).toBe("auto");
  });

  it("offers the plan's own spend ceiling as the default", () => {
    const p = plan([["pending"]]);
    p.budget = { maxUsd: 7.5, spentUsd: 0, partial: false, exceeded: false, warned: false };
    expect(buildPreflight({ plan: p, projects: [], approvalMode: "ask" }).defaultMaxUsd).toBe(7.5);
  });
});

describe("buildRunReport", () => {
  function finishedRun() {
    const p = plan([["completed", "completed"], ["completed", "blocked"]]);
    p.phases[0]!.steps[0]!.evidence = { checks: ["npm test"], unverified: [], filesChanged: ["a.ts"], at: "t" };
    p.phases[0]!.steps[1]!.evidence = { checks: [], unverified: ["b.ts", "c.ts"], filesChanged: ["b.ts", "c.ts"], at: "t" };
    const run = createPlanRun({ id: "run1", plan: p, sessionId: "s", model: "m", charter: normalizeCharter({ maxUsd: 10 }), now: Date.parse("2026-10-09T10:00:00Z") });
    applyPlanRunEvent(run, { type: "step_started", at: run.startedAt + 1_000, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    applyPlanRunEvent(run, { type: "step_completed", at: run.startedAt + 61_000, phaseId: "p1", stepId: "s1", title: "Step 1.1" });
    applyPlanRunEvent(run, { type: "step_blocked", at: run.startedAt + 90_000, phaseId: "p2", stepId: "s2", title: "Step 2.2", reason: "needs an API key" });
    applyPlanRunEvent(run, { type: "spend", at: run.startedAt + 91_000, usd: 1.5, partial: false });
    applyPlanRunEvent(run, { type: "conductor_decision", at: run.startedAt + 92_000, trigger: "stalled", decision: "continue", rationale: "Next step is clear." });
    setRunStatus(run, "paused", run.startedAt + 120_000, "Paused by you.");
    run.lastHandoff = "Stopped: Paused at the end of a step.";
    return { run, p };
  }

  it("states what was done, what was never checked, and what needs a decision", () => {
    const { run, p } = finishedRun();
    const text = buildRunReport(run, p, { filesChanged: [{ path: "src/a.ts", additions: 5, deletions: 1 }], unverifiedNow: ["src/z.ts"] });
    expect(text).toContain("# Plan run report — Ship billing");
    expect(text).toContain("Paused with 3 of 4 steps done");
    expect(text).toContain("$1.50 of a $10.00 ceiling");
    expect(text).toContain("| 1 | Phase 1: Step 1.1 | done |");
    expect(text).toContain("npm test");
    expect(text).toContain("## Not checked");
    expect(text).toContain("b.ts, c.ts");
    expect(text).toContain("Still owing a check now: src/z.ts");
    expect(text).toContain("## Needs a decision");
    expect(text).toContain("needs an API key");
    expect(text).toContain("`src/a.ts` (+5 −1)");
    expect(text).toContain("**continue** (stalled): Next step is clear.");
    expect(text).toContain("## Where it stopped");
    expect(text).toContain("Stopped: Paused at the end of a step.");
  });

  it("omits what does not apply and survives a pipe in a title", () => {
    const p = plan([["completed"]]);
    p.phases[0]!.steps[0]!.title = "Split a|b";
    const run = createPlanRun({ id: "r", plan: p, sessionId: "s", charter: normalizeCharter({}), now: 0 });
    setRunStatus(run, "completed", 5_000);
    const text = buildRunReport(run, p, { filesChanged: [], unverifiedNow: [] });
    expect(text).toContain("Finished: all 1 steps are done.");
    expect(text).not.toContain("## Not checked");
    expect(text).not.toContain("## Where it stopped");
    expect(text).toContain("Split a\\|b");
  });

  it("gives the report a title that sorts by start time", () => {
    const { run } = finishedRun();
    expect(runReportTitle(run)).toBe("Run report 2026-10-09 10:00");
  });
});

describe("presentRun", () => {
  function view(liveStateStatus: Parameters<typeof setRunStatus>[1], extra: { quiet?: boolean } = {}) {
    const p = plan([["completed", "in_progress", "pending"]]);
    const run = createPlanRun({ id: "r", plan: p, sessionId: "s", charter: normalizeCharter({ maxUsd: 5 }), now: 0 });
    if (liveStateStatus !== "running") setRunStatus(run, liveStateStatus, 90_000, "because");
    return buildPlanRunView(run, p, { now: 400_000, lastProgressAt: extra.quiet ? 0 : 399_000 });
  }

  it("shows position and clock while working, and the other states in a word", () => {
    expect(presentRun(view("running"))).toMatchObject({ icon: "$(loading~spin)", text: expect.stringContaining("2/3"), ended: false, pressing: false });
    expect(presentRun(view("running", { quiet: true })).text).toContain("quiet");
    expect(presentRun(view("waiting_user"))).toMatchObject({ icon: "$(bell)", pressing: true });
    expect(presentRun(view("paused")).text).toContain("Paused");
    expect(presentRun(view("interrupted"))).toMatchObject({ pressing: true });
  });

  it("marks a run that has ended, so the item can stay until it is seen", () => {
    expect(presentRun(view("completed"))).toMatchObject({ icon: "$(check)", ended: true });
    expect(presentRun(view("stopped"))).toMatchObject({ ended: true });
    expect(presentRun(view("budget_exhausted"))).toMatchObject({ ended: true, pressing: true });
    expect(presentRun(view("failed"))).toMatchObject({ ended: false, pressing: true });
  });

  it("never offers a click that cancels the run", () => {
    expect(presentRun(view("waiting_user")).tooltip).toContain("Click to open Blacksite.");
    expect(presentRun(view("waiting_user")).tooltip).not.toMatch(/cancel/i);
  });
});

describe("conductor with a plan run", () => {
  const gate = (overrides: Partial<ContinuationGateInputs> = {}): ContinuationGateInputs => ({
    enabled: true, plan: plan([["in_progress", "pending"]]), stopReason: "end_turn", errored: false, awaitingUser: false, consecutive: 0, lastMessage: "Done with the step.", ...overrides,
  });

  it("prefers the harness's own account of why it is being asked", () => {
    expect(continuationGate(gate({ triggerHint: "step_failed" }))).toMatchObject({ ask: true, trigger: "step_failed" });
    expect(continuationGate(gate({ triggerHint: "interrupted", lastMessage: "Should I use Postgres?" }))).toMatchObject({ trigger: "interrupted" });
    // A question still wins over a failed step: it needs an answer first.
    expect(continuationGate(gate({ triggerHint: "step_failed", lastMessage: "Should I use Postgres?" }))).toMatchObject({ trigger: "executor_question" });
  });

  it("drives the run's plan, not whichever plan changed last", () => {
    const mine = plan([["pending"]], { id: "mine", updatedAt: "2026-10-01T00:00:00.000Z" });
    const other = plan([["pending"]], { id: "other", updatedAt: "2026-10-09T00:00:00.000Z" });
    expect(activeExecutingPlan([mine, other])!.id).toBe("other");
    expect(activeExecutingPlan([mine, other], "mine")!.id).toBe("mine");
    expect(activeExecutingPlan([mine, { ...mine, status: "on_hold" } as TaskPlan], "mine")).not.toBeNull();
    expect(activeExecutingPlan([plan([["pending"]], { id: "mine", status: "on_hold" })], "mine")).toBeNull();
  });

  it("reports a blocked step as the current one when it is all that is left", () => {
    const p = plan([["completed", "blocked"]]);
    expect(currentStepOf(p)!.step.id).toBe("s2");
    const brief = buildPlanBrief({ plan: p, userPrompts: ["ship it"], executorLastMessage: "stuck", trigger: "step_failed" });
    expect(brief.current).toMatchObject({ title: "Step 1.2", status: "blocked" });
  });

  it("counts attempts from the run ledger as well as from notes", () => {
    const p = plan([["in_progress"]]);
    const step = p.phases[0]!.steps[0]!;
    expect(attemptsFor(step)).toBe(0);
    expect(attemptsFor(step, 3)).toBe(3);
    step.notes = ["Delegated to a subagent lane x", "Subagent lane failed y"];
    expect(attemptsFor(step, 1)).toBe(2);
    const brief = buildPlanBrief({ plan: p, userPrompts: [], executorLastMessage: "", trigger: "stalled", ledgerAttempts: new Map([["p1/s1", 4]]) });
    expect(brief.attempts).toBe(4);
  });

  it("shows the conductor what the harness saw, and what finished steps were checked by", () => {
    const p = plan([["completed", "in_progress"]]);
    p.phases[0]!.steps[0]!.evidence = { checks: ["npm test"], unverified: ["x.ts"], filesChanged: ["x.ts", "y.ts"], at: "t" };
    const brief = buildPlanBrief({ plan: p, userPrompts: ["do it"], executorLastMessage: "ok", trigger: "stalled", turnDigest: "Steps: no step changed state.\nFiles changed: none." });
    const prompt = buildContinuationUserPrompt(brief);
    expect(prompt).toContain("WHAT THE HARNESS OBSERVED IN THAT TURN");
    expect(prompt).toContain("Files changed: none.");
    expect(prompt).toContain("evidence: checked by npm test; 1 changed file not checked; 2 files changed");
    expect(describeEvidence({ checks: [], unverified: [], filesChanged: [], at: "t" })).toBe("nothing needed checking");
  });

  it("never continues a run that is paused, whatever the global setting says", async () => {
    const calls: string[] = [];
    const run: PlanContinuationRunContext = {
      active: () => undefined,
      holds: () => true,
      digest: () => undefined,
      priorDecisions: () => [],
      ledgerAttempts: () => new Map(),
      triggerHint: () => undefined,
      record: () => undefined,
      stopped: () => undefined,
    };
    const planning = { read: () => ({ plans: [plan([["pending"]])] }) } as never;
    const service = new PlanContinuationService(
      planning,
      () => ({ decide: async () => { calls.push("asked"); return "{}"; } }),
      () => ["go"],
      () => ({ enabled: true, maxConsecutive: 5 }),
      { continueWith: async () => { calls.push("sent"); }, report: () => undefined },
      run,
    );
    const result = await service.afterTurn({ stopReason: "end_turn", errored: false, awaitingUser: false, lastMessage: "done" });
    expect(result).toMatchObject({ ask: false });
    expect(calls).toEqual([]);
  });

  it("counts only turns that moved nothing when a run drives the conductor", async () => {
    const stops: string[] = [];
    const run: PlanContinuationRunContext = {
      active: () => ({ planId: "plan1", consecutive: 5 }),
      holds: () => false,
      digest: () => undefined,
      priorDecisions: () => [],
      ledgerAttempts: () => new Map(),
      triggerHint: () => undefined,
      record: () => undefined,
      stopped: (kind) => { stops.push(kind); },
    };
    const planning = { read: () => ({ plans: [plan([["pending"]])] }) } as never;
    const reports: string[] = [];
    const service = new PlanContinuationService(
      planning,
      () => ({ decide: async () => "{}" }),
      () => ["go"],
      () => ({ enabled: false, maxConsecutive: 5 }),
      { continueWith: async () => undefined, report: (kind) => { reports.push(kind); } },
      run,
    );
    const result = await service.afterTurn({ stopReason: "end_turn", errored: false, awaitingUser: false, lastMessage: "done" });
    expect(result).toMatchObject({ ask: false, reason: "budget_exhausted" });
    expect(stops).toEqual(["budget"]);
    expect(reports).toEqual(["ask"]);
  });
});

describe("plan store: timings, evidence and restore points", () => {
  let dir = "";
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

  function store(): PlanningStore {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-store-"));
    return new PlanningStore(dir);
  }

  async function createApproved(s: PlanningStore): Promise<string> {
    const created = await s.dispatch("create", {
      title: "Plan", executionApproved: true,
      phases: [{ title: "P1", steps: [{ title: "a" }, { title: "b" }, { title: "c" }] }, { title: "P2", steps: [{ title: "d" }] }],
    }, { sessionId: "s" });
    return String((created as { plan: { id: string } }).plan.id);
  }

  it("stamps when a step started and finished, and keeps the first start across retries", async () => {
    const s = store();
    const id = await createApproved(s);
    await s.dispatch("update", { planId: id, phaseId: "phase-1", stepId: "step-1", stepStatus: "in_progress" }, { sessionId: "s" });
    const started = s.read().plans[0]!.phases[0]!.steps[0]!.startedAt;
    expect(started).toBeDefined();
    await s.dispatch("update", { planId: id, phaseId: "phase-1", stepId: "step-1", stepStatus: "completed" }, { sessionId: "s" });
    const done = s.read().plans[0]!.phases[0]!.steps[0]!;
    expect(done.startedAt).toBe(started);
    expect(done.completedAt).toBeDefined();
    await s.dispatch("update", { planId: id, phaseId: "phase-1", stepId: "step-1", stepStatus: "in_progress" }, { sessionId: "s" });
    const reopened = s.read().plans[0]!.phases[0]!.steps[0]!;
    expect(reopened.startedAt).toBe(started);
    expect(reopened.completedAt).toBeUndefined();
  });

  it("stores the evidence for a step and drops garbage in it", async () => {
    const s = store();
    const id = await createApproved(s);
    s.setStepEvidence(id, "phase-1", "step-1", { checks: ["npm test", ""], unverified: ["x.ts"], filesChanged: ["x.ts", "y.ts"], diagnostics: { errors: 2, warnings: -4 }, at: "now" });
    const evidence = s.read().plans[0]!.phases[0]!.steps[0]!.evidence!;
    expect(evidence.checks).toEqual(["npm test"]);
    expect(evidence.unverified).toEqual(["x.ts"]);
    expect(evidence.diagnostics).toEqual({ errors: 2, warnings: 0 });
  });

  it("puts every step after a restore point back to pending, and nothing before it", async () => {
    const s = store();
    const id = await createApproved(s);
    for (const [phase, step] of [["phase-1", "step-1"], ["phase-1", "step-2"], ["phase-1", "step-3"], ["phase-2", "step-1"]] as const) {
      await s.dispatch("update", { planId: id, phaseId: phase, stepId: step, stepStatus: "completed" }, { sessionId: "s" });
    }
    expect(s.read().plans[0]!.status).toBe("completed");
    const outcome = s.resetStepsAfter(id, "phase-1", "step-2", "Reset: restored.");
    expect(outcome.reset).toBe(2);
    const after = s.read().plans[0]!;
    expect(after.phases[0]!.steps.map((step) => step.status)).toEqual(["completed", "completed", "pending"]);
    expect(after.phases[1]!.steps[0]!.status).toBe("pending");
    expect(after.phases[1]!.steps[0]!.notes.at(-1)).toBe("Reset: restored.");
    expect(after.status).toBe("active");
    expect(after.completedAt).toBeUndefined();
  });
});
