import { describe, expect, it } from "vitest";
import {
  attemptsFor,
  buildPlanBrief,
  buildResumeBrief,
  canAutoContinue,
  currentStepOf,
  findInterruptedSteps,
  interruptionNote,
  planIsComplete,
} from "../../src/plans/plan-recovery.js";
import type { PlanningDocument, TaskPlan, TaskPlanPhase, TaskPlanStep } from "../../src/planning-store.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function step(id: string, overrides: Partial<TaskPlanStep> = {}): TaskPlanStep {
  return {
    id,
    title: `Step ${id}`,
    status: "pending",
    notes: [],
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as TaskPlanStep;
}

function phase(id: string, steps: TaskPlanStep[], overrides: Partial<TaskPlanPhase> = {}): TaskPlanPhase {
  return {
    id,
    title: `Phase ${id}`,
    status: "in_progress",
    steps,
    notes: [],
    blocks: [],
    docs: [],
    linkedTodoIds: [],
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as TaskPlanPhase;
}

function plan(phases: TaskPlanPhase[], overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan1",
    title: "Ship rate limiting",
    status: "active",
    phases,
    blocks: [],
    docs: [],
    agentCanArchive: false,
    executionApproved: true,
    notes: [],
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as TaskPlan;
}

function document(plans: TaskPlan[]): PlanningDocument {
  return { schemaVersion: 1, updatedAt: null, plans, todoRuns: [] };
}

describe("findInterruptedSteps", () => {
  it("finds a step still claiming to be in progress", () => {
    // No agent session outlives the host, so at activation this claim is provably false.
    const doc = document([plan([phase("p1", [step("s1", { status: "in_progress" })])])]);
    expect(findInterruptedSteps(doc)).toEqual([
      expect.objectContaining({ planId: "plan1", phaseId: "p1", stepId: "s1", stepTitle: "Step s1" }),
    ]);
  });

  it("leaves pending, completed and blocked steps alone", () => {
    const doc = document([plan([phase("p1", [
      step("a", { status: "pending" }),
      step("b", { status: "completed" }),
      step("c", { status: "blocked" }),
    ])])]);
    expect(findInterruptedSteps(doc)).toEqual([]);
  });

  it("ignores plans that are no longer live", () => {
    // An archived plan's stale step is history, not unfinished work.
    for (const status of ["archived", "completed", "cancelled"] as const) {
      const doc = document([plan([phase("p1", [step("s1", { status: "in_progress" })])], { status })]);
      expect(findInterruptedSteps(doc)).toEqual([]);
    }
  });

  it("recovers a draft or on-hold plan, which can still hold a stranded step", () => {
    for (const status of ["draft", "on_hold", "blocked"] as const) {
      const doc = document([plan([phase("p1", [step("s1", { status: "in_progress" })])], { status })]);
      expect(findInterruptedSteps(doc)).toHaveLength(1);
    }
  });

  it("sweeps every plan and phase, not just the first", () => {
    const doc = document([
      plan([phase("p1", [step("s1", { status: "in_progress" })])], { id: "A" }),
      plan([
        phase("p1", [step("s2", { status: "completed" })]),
        phase("p2", [step("s3", { status: "in_progress" })]),
      ], { id: "B" }),
    ]);
    expect(findInterruptedSteps(doc).map((entry) => entry.stepId)).toEqual(["s1", "s3"]);
  });
});

describe("interruptionNote", () => {
  it("says it was interrupted, not that it failed", () => {
    // Interrupted wants resuming; failed wants rethinking. Conflating them sends the next
    // session down the wrong path.
    const note = interruptionNote({
      planId: "p", planTitle: "t", phaseId: "ph", phaseTitle: "Phase",
      stepId: "s", stepTitle: "Step", updatedAt: "2026-08-01T10:00:00.000Z",
    }, NOW);
    expect(note).toContain("2 hours ago");
    expect(note).toContain("no agent was running it");
    expect(note).toContain("check before redoing it");
    expect(note).not.toContain("failed");
  });

  it("degrades to a vague label rather than nonsense on an unparseable timestamp", () => {
    const note = interruptionNote({
      planId: "p", planTitle: "t", phaseId: "ph", phaseTitle: "Phase",
      stepId: "s", stepTitle: "Step", updatedAt: "not a date",
    }, NOW);
    expect(note).toContain("earlier");
    expect(note).not.toContain("NaN");
  });
});

describe("attemptsFor", () => {
  it("counts attempts from the notes the step already carries", () => {
    expect(attemptsFor(step("s", {
      notes: [
        'Delegated to a subagent lane ("first try").',
        "Subagent lane failed: tests did not pass",
        'Delegated to a subagent lane ("second try").',
      ],
    }))).toBe(3);
  });

  it("does not count unrelated notes", () => {
    expect(attemptsFor(step("s", { notes: ["User asked to skip the cache work."] }))).toBe(0);
  });
});

describe("currentStepOf", () => {
  it("prefers an in-progress step over a pending one", () => {
    const p = plan([phase("p1", [step("a", { status: "pending" }), step("b", { status: "in_progress" })])]);
    expect(currentStepOf(p)?.step.id).toBe("b");
  });

  it("falls back to the first pending step", () => {
    const p = plan([phase("p1", [step("a", { status: "completed" }), step("b", { status: "pending" })])]);
    expect(currentStepOf(p)?.step.id).toBe("b");
  });

  it("skips completed phases entirely", () => {
    const p = plan([
      phase("p1", [step("a", { status: "pending" })], { status: "completed" }),
      phase("p2", [step("b", { status: "pending" })]),
    ]);
    expect(currentStepOf(p)?.step.id).toBe("b");
  });

  it("returns null when nothing is outstanding", () => {
    expect(currentStepOf(plan([phase("p1", [step("a", { status: "completed" })])]))).toBeNull();
  });
});

describe("buildPlanBrief", () => {
  const p = plan([
    phase("p1", [
      step("done", { status: "completed", notes: ["Shipped the bucket."] }),
      step("now", { status: "in_progress", acceptanceCriteria: "middleware wired", notes: ["Delegated to a subagent lane."] }),
    ]),
    phase("p2", [step("later", { status: "pending", acceptanceCriteria: "tests cover per-key" })]),
  ]);

  it("separates done, current and not-yet-started without double-counting the current step", () => {
    const brief = buildPlanBrief({
      plan: p,
      userPrompts: ["Add rate limiting."],
      executorLastMessage: "Per-IP or per-key?",
      trigger: "executor_question",
    });
    expect(brief.completed.map((s) => s.title)).toEqual(["Step done"]);
    expect(brief.current?.title).toBe("Step now");
    expect(brief.remaining.map((s) => s.title)).toEqual(["Step later"]);
  });

  it("carries the not-yet-started acceptance criteria, so a forward question is answerable", () => {
    const brief = buildPlanBrief({ plan: p, userPrompts: [], executorLastMessage: "", trigger: "stalled" });
    expect(brief.remaining[0]!.acceptanceCriteria).toBe("tests cover per-key");
  });

  it("reports the current step's attempt count", () => {
    const brief = buildPlanBrief({ plan: p, userPrompts: [], executorLastMessage: "", trigger: "step_failed" });
    expect(brief.attempts).toBe(1);
  });

  it("attaches only the most recent note, not the whole history", () => {
    const noisy = plan([phase("p1", [step("now", {
      status: "in_progress",
      notes: ["first", "second", "third"],
    })])]);
    const brief = buildPlanBrief({ plan: noisy, userPrompts: [], executorLastMessage: "", trigger: "stalled" });
    expect(brief.current?.note).toBe("third");
  });

  it("passes the user's prompts through untouched", () => {
    const prompts = ["Add rate limiting to the public API, but don't touch auth."];
    expect(buildPlanBrief({ plan: p, userPrompts: prompts, executorLastMessage: "", trigger: "stalled" }).userPrompts)
      .toEqual(prompts);
  });
});

describe("canAutoContinue", () => {
  it("refuses a plan the user has not approved for execution", () => {
    // Auto-continuation is strictly more autonomous than execution, so it inherits the gate
    // rather than routing around it.
    const result = canAutoContinue(plan([phase("p1", [step("a")])], { executionApproved: false }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not been approved");
  });

  it("refuses a plan that is not live", () => {
    expect(canAutoContinue(plan([phase("p1", [step("a")])], { status: "archived" })).ok).toBe(false);
  });

  it("refuses a plan with nothing left to do", () => {
    const done = plan([phase("p1", [step("a", { status: "completed" })], { status: "completed" })]);
    expect(canAutoContinue(done)).toMatchObject({ ok: false, reason: "Every phase is complete." });
  });

  it("allows an approved, live, unfinished plan", () => {
    expect(canAutoContinue(plan([phase("p1", [step("a")])])).ok).toBe(true);
  });
});

describe("planIsComplete", () => {
  it("is false for a plan with no phases rather than vacuously true", () => {
    // An empty plan is unwritten, not finished.
    expect(planIsComplete(plan([]))).toBe(false);
  });

  it("requires every phase to be complete", () => {
    expect(planIsComplete(plan([
      phase("p1", [], { status: "completed" }),
      phase("p2", [], { status: "in_progress" }),
    ]))).toBe(false);
  });
});

describe("buildResumeBrief", () => {
  it("states position, current step and blockers", () => {
    const p = plan([
      phase("p1", [step("a", { status: "completed" })], { status: "completed" }),
      phase("p2", [
        step("b", { status: "in_progress", notes: ["Delegated to a subagent lane.", "Subagent lane failed: flaky"] }),
        step("c", { status: "blocked" }),
      ]),
    ]);
    const brief = buildResumeBrief(p);
    expect(brief).toContain("phase 2 of 2");
    expect(brief).toContain("Current step: Step b");
    expect(brief).toContain("attempted 2 times");
    expect(brief).toContain("Subagent lane failed: flaky");
    expect(brief).toContain("Blocked: 1 step(s)");
  });

  it("says so when the plan is finished", () => {
    const p = plan([phase("p1", [step("a", { status: "completed" })], { status: "completed" })]);
    expect(buildResumeBrief(p)).toContain("Every phase is complete.");
  });
});
