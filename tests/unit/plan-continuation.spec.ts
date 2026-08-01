import { describe, expect, it } from "vitest";
import {
  activeExecutingPlan,
  continuationAction,
  continuationGate,
  DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS,
  haltMessage,
  type ContinuationGateInputs,
} from "../../src/plans/plan-continuation.js";
import { PlanContinuationService } from "../../src/plans/plan-continuation-service.js";
import type { PlanningDocument, TaskPlan, TaskPlanPhase, TaskPlanStep } from "../../src/planning-store.js";

function step(id: string, overrides: Partial<TaskPlanStep> = {}): TaskPlanStep {
  return { id, title: `Step ${id}`, status: "pending", notes: [], updatedAt: "2026-08-01T10:00:00.000Z", ...overrides } as TaskPlanStep;
}

function phase(id: string, steps: TaskPlanStep[], overrides: Partial<TaskPlanPhase> = {}): TaskPlanPhase {
  return {
    id, title: `Phase ${id}`, status: "in_progress", steps, notes: [],
    blocks: [], docs: [], linkedTodoIds: [], updatedAt: "2026-08-01T10:00:00.000Z", ...overrides,
  } as TaskPlanPhase;
}

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan1", title: "Ship rate limiting", status: "active",
    phases: [phase("p1", [step("a")])],
    blocks: [], docs: [], agentCanArchive: false, executionApproved: true, notes: [],
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  } as TaskPlan;
}

function gateInputs(overrides: Partial<ContinuationGateInputs> = {}): ContinuationGateInputs {
  return {
    enabled: true,
    plan: plan(),
    stopReason: "end_turn",
    errored: false,
    awaitingUser: false,
    consecutive: 0,
    lastMessage: "Finished the middleware.",
    ...overrides,
  };
}

describe("continuationGate", () => {
  it("asks when an approved, incomplete plan stalls on a clean turn", () => {
    expect(continuationGate(gateInputs()).ask).toBe(true);
  });

  it("never acts when the feature is off", () => {
    expect(continuationGate(gateInputs({ enabled: false }))).toMatchObject({ ask: false, reason: "disabled" });
  });

  it("does not continue through a cancellation", () => {
    // Cancellation is the user saying stop. Continuing through it would be the single most
    // obnoxious thing this feature could do.
    expect(continuationGate(gateInputs({ stopReason: "cancelled" }))).toMatchObject({ ask: false, reason: "turn_failed" });
  });

  it("does not continue after an errored turn", () => {
    expect(continuationGate(gateInputs({ errored: true }))).toMatchObject({ ask: false, reason: "turn_failed" });
  });

  it("stays quiet while the user is already being asked something", () => {
    for (const inputs of [
      gateInputs({ awaitingUser: true }),
      gateInputs({ stopReason: "approval_pending" }),
      gateInputs({ stopReason: "question_pending" }),
    ]) {
      expect(continuationGate(inputs)).toMatchObject({ ask: false, reason: "awaiting_user" });
    }
  });

  it("refuses a plan the user has not approved for execution", () => {
    // Auto-continuation is strictly more autonomous than execution, so it inherits that gate.
    expect(continuationGate(gateInputs({ plan: plan({ executionApproved: false }) })))
      .toMatchObject({ ask: false, reason: "plan_ineligible" });
  });

  it("does nothing when there is no plan at all", () => {
    expect(continuationGate(gateInputs({ plan: null }))).toMatchObject({ ask: false, reason: "no_plan" });
  });

  it("stops when the plan is finished", () => {
    const done = plan({ phases: [phase("p1", [step("a", { status: "completed" })], { status: "completed" })] });
    expect(continuationGate(gateInputs({ plan: done }))).toMatchObject({ ask: false, reason: "plan_complete" });
  });

  it("stops after the consecutive-continuation budget is spent", () => {
    // A conductor that keeps saying "continue" is indistinguishable from a runaway loop, and
    // no single decision can tell the difference.
    const result = continuationGate(gateInputs({ consecutive: DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS }));
    expect(result).toMatchObject({ ask: false, reason: "budget_exhausted" });
    if (result.ask) throw new Error("unreachable");
    expect(result.detail).toContain("Stopping to check in");
  });

  it("honours a lowered budget", () => {
    expect(continuationGate(gateInputs({ consecutive: 2, maxConsecutive: 2 })))
      .toMatchObject({ ask: false, reason: "budget_exhausted" });
    expect(continuationGate(gateInputs({ consecutive: 1, maxConsecutive: 2 })).ask).toBe(true);
  });

  it("frames a trailing question as a question", () => {
    const result = continuationGate(gateInputs({ lastMessage: "Should the limit be per-IP or per-key?" }));
    expect(result).toMatchObject({ ask: true, trigger: "executor_question" });
  });
});

describe("continuationAction", () => {
  it("sends a continue verbatim", () => {
    expect(continuationAction({ action: "continue", message: "Use per-key.", rationale: "Plan says so." }))
      .toEqual({ kind: "send", message: "Use per-key.", rationale: "Plan says so." });
  });

  it("renders a halt for the user rather than routing it back to the executor", () => {
    // An agent told "you were halted for a security reason" would reliably argue with it.
    const action = continuationAction({
      action: "halt", category: "security", reason: "The next step rotates production keys.",
      whatWouldUnblock: "Rotate them yourself and re-run.",
    });
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") throw new Error("unreachable");
    expect(action.message).toContain("security decision needed");
    expect(action.message).toContain("Rotate them yourself");
  });

  it("names the drift case plainly, since it is the one only the conductor can catch", () => {
    const action = continuationAction({
      action: "halt", category: "intent_drift", reason: "You asked not to touch auth.", whatWouldUnblock: "",
    });
    if (action.kind !== "halt") throw new Error("unreachable");
    expect(action.message).toContain("drifted from what you asked");
  });

  it("passes an escalation through", () => {
    expect(continuationAction({ action: "ask_user", question: "Behind a flag?", why: "Product call." }))
      .toEqual({ kind: "ask", question: "Behind a flag?", why: "Product call." });
  });
});

describe("haltMessage", () => {
  it("omits the unblock line when nothing would unblock it", () => {
    expect(haltMessage("safety", "It would drop the table.", "")).not.toContain("To continue:");
  });
});

describe("activeExecutingPlan", () => {
  it("picks the most recently updated executable plan", () => {
    const older = plan({ id: "old", updatedAt: "2026-08-01T09:00:00.000Z" });
    const newer = plan({ id: "new", updatedAt: "2026-08-01T11:00:00.000Z" });
    expect(activeExecutingPlan([older, newer])?.id).toBe("new");
  });

  it("ignores unapproved, inactive and finished plans", () => {
    expect(activeExecutingPlan([plan({ executionApproved: false })])).toBeNull();
    expect(activeExecutingPlan([plan({ status: "archived" })])).toBeNull();
    const done = plan({ phases: [phase("p1", [step("a", { status: "completed" })], { status: "completed" })] });
    expect(activeExecutingPlan([done])).toBeNull();
  });
});

/* ── the service ──────────────────────────────────────────────────────────── */

function fakePlanning(plans: TaskPlan[]) {
  return { read: (): PlanningDocument => ({ schemaVersion: 1, updatedAt: null, plans, todoRuns: [] }) } as unknown as import("../../src/planning-store.js").PlanningStore;
}

function harness(reply: string, plans: TaskPlan[] = [plan()], settings = { enabled: true, maxConsecutive: 3 }) {
  const sent: string[] = [];
  const reported: Array<{ kind: string; message: string }> = [];
  const service = new PlanContinuationService(
    fakePlanning(plans),
    () => ({ decide: async () => reply }),
    () => ["Add rate limiting, but don't touch auth."],
    () => settings,
    {
      continueWith: async (message) => { sent.push(message); },
      report: (kind, message) => { reported.push({ kind, message }); },
    },
  );
  return { service, sent, reported };
}

const CLEAN_TURN = { stopReason: "end_turn", errored: false, awaitingUser: false, lastMessage: "Done with step one." };

describe("PlanContinuationService", () => {
  it("sends the conductor's message back into the agent", async () => {
    const { service, sent } = harness('{"action":"continue","message":"Now wire the middleware.","rationale":"x"}');
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual(["Now wire the middleware."]);
    expect(service.consecutive).toBe(1);
  });

  it("stops itself once the budget is spent", async () => {
    const { service, sent, reported } = harness('{"action":"continue","message":"Keep going."}');
    for (let i = 0; i < 5; i += 1) await service.afterTurn(CLEAN_TURN);
    expect(sent).toHaveLength(3);
    expect(reported.at(-1)!.message).toContain("Stopping to check in");
  });

  it("resets the budget when the user speaks", async () => {
    const { service, sent } = harness('{"action":"continue","message":"Keep going."}');
    for (let i = 0; i < 4; i += 1) await service.afterTurn(CLEAN_TURN);
    expect(sent).toHaveLength(3);
    service.noteUserMessage();
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toHaveLength(4);
  });

  it("reports a halt instead of continuing, and clears the counter", async () => {
    const { service, sent, reported } = harness(
      '{"action":"halt","category":"irrecoverable","reason":"Next step force-pushes main.","whatWouldUnblock":"Do it yourself."}',
    );
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual([]);
    expect(reported[0]).toMatchObject({ kind: "halt" });
    expect(reported[0]!.message).toContain("irreversible");
    expect(service.consecutive).toBe(0);
  });

  it("halts rather than continuing when the conductor's reply is unreadable", async () => {
    // The safety-critical default: not knowing what was decided must never resolve to
    // "keep going unattended".
    const { service, sent, reported } = harness("sure, keep going!");
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual([]);
    expect(reported[0]).toMatchObject({ kind: "halt" });
  });

  it("does nothing at all when disabled", async () => {
    const { service, sent, reported } = harness('{"action":"continue","message":"go"}', [plan()], { enabled: false, maxConsecutive: 3 });
    expect(await service.afterTurn(CLEAN_TURN)).toMatchObject({ ask: false, reason: "disabled" });
    expect(sent).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("serializes a turn that settles while its continuation is still in flight", async () => {
    /* The continued turn ends inside continueWith(), before the outer conductor call unwinds.
       It must be queued â€” dropping it makes automatic continuation stop after exactly one turn,
       while re-entering immediately overlaps conductor calls. */
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let decisions = 0;
    const service = new PlanContinuationService(
      fakePlanning([plan()]),
      () => ({ decide: async () => {
        decisions += 1;
        if (decisions === 1) await gate;
        return decisions === 1
          ? '{"action":"continue","message":"go"}'
          : '{"action":"ask_user","question":"Review?","why":"Checkpoint."}';
      } }),
      () => [],
      () => ({ enabled: true, maxConsecutive: 5 }),
      { continueWith: async () => {}, report: () => {} },
    );

    const first = service.afterTurn(CLEAN_TURN);
    const second = await service.afterTurn(CLEAN_TURN);
    expect(second).toMatchObject({ ask: false, detail: "Queued behind the continuation already in flight." });
    release!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decisions).toBe(2);
  });

  it("survives an unreadable planning document", async () => {
    const service = new PlanContinuationService(
      { read: () => { throw new Error("corrupt"); } } as unknown as import("../../src/planning-store.js").PlanningStore,
      () => ({ decide: async () => '{"action":"continue","message":"go"}' }),
      () => [],
      () => ({ enabled: true, maxConsecutive: 5 }),
      { continueWith: async () => {}, report: () => {} },
    );
    expect(await service.afterTurn(CLEAN_TURN)).toMatchObject({ ask: false, reason: "no_plan" });
  });
});
