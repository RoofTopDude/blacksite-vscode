import { describe, expect, it } from "vitest";
import { decideContinuation, parseContinuationVerdict, type ContinuationBrief, type ContinuationModel } from "../../src/continuation/continuation-model.js";
import {
  consultsStrategy, DEFAULT_STRATEGIC_POLICY, decideStrategicVerdict, decideWithStrategy, EMPTY_STRATEGIC_STATE,
  parseStrategicVerdict, planFingerprint, type StrategicPolicy, type StrategicRunState,
} from "../../src/continuation/strategic-verdict.js";

const ON: StrategicPolicy = { ...DEFAULT_STRATEGIC_POLICY, enabled: true };

function brief(overrides: Partial<ContinuationBrief> = {}): ContinuationBrief {
  return {
    userPrompts: ["Add rate limiting to the API"],
    planTitle: "Ship rate limiting",
    completed: [],
    remaining: [{ title: "Wire the middleware" }],
    executorLastMessage: "I am not sure how the limiter should share state.",
    trigger: "stalled",
    attempts: 0,
    ...overrides,
  };
}

function modelReturning(reply: string | Error): ContinuationModel & { calls: number } {
  const model = {
    calls: 0,
    async decide() {
      model.calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return model;
}

const replanJson = (steps: Array<{ title: string }> = [{ title: "Add a shared store" }]) => JSON.stringify({
  action: "replan", summary: "Share the limiter state", steps, rationale: "The current steps assume per-process state.",
});

describe("parsing", () => {
  it("parses legacy verdicts exactly as the legacy parser does", () => {
    for (const raw of [
      '{"action":"continue","message":"Use the shared store.","rationale":"Answers the question."}',
      '{"action":"halt","category":"intent_drift","reason":"Off the request.","whatWouldUnblock":""}',
      '{"action":"ask_user","question":"Which store?","why":"A product choice."}',
      "not json at all",
    ]) {
      expect(parseStrategicVerdict(raw)).toEqual(parseContinuationVerdict(raw));
    }
    expect(parseStrategicVerdict('{"action":"continue","message":"Go on.","rationale":""}')).toMatchObject({ action: "continue", message: "Go on." });
  });

  it("parses each proposal into its typed shape", () => {
    expect(parseStrategicVerdict(replanJson())).toEqual({
      action: "replan", summary: "Share the limiter state", steps: [{ title: "Add a shared store" }], rationale: "The current steps assume per-process state.",
    });
    expect(parseStrategicVerdict('{"action":"delegate","workId":"BLK-1","target":"phase-2","rationale":"Parallel"}'))
      .toEqual({ action: "delegate", workId: "BLK-1", target: "phase-2", rationale: "Parallel" });
    expect(parseStrategicVerdict('{"action":"verify","workId":"BLK-1"}')).toEqual({ action: "verify", workId: "BLK-1", rationale: "" });
    expect(parseStrategicVerdict('{"action":"block","reason":"Needs a decision","whatWouldUnblock":"Pick a store"}'))
      .toEqual({ action: "block", reason: "Needs a decision", whatWouldUnblock: "Pick a store" });
  });

  it.each([
    ["an empty step list", replanJson([])],
    ["too many steps", replanJson(Array.from({ length: 13 }, (_, index) => ({ title: `step ${index}` })))],
    ["a blank step title", replanJson([{ title: "   " }])],
    ["a missing summary", '{"action":"replan","steps":[{"title":"x"}],"rationale":""}'],
    ["a delegate without a target", '{"action":"delegate","workId":"BLK-1"}'],
    ["a block without a reason", '{"action":"block","whatWouldUnblock":"x"}'],
  ])("halts a malformed proposal (%s) rather than guessing", (_label, raw) => {
    expect(parseStrategicVerdict(raw)).toMatchObject({ action: "halt", category: "incoherent" });
  });

  it.each([
    '{"action":"replan","summary":"s","steps":[{"title":"x"}],"rationale":"","budgetIncrease":5}',
    '{"action":"verify","workId":"BLK-1","grantPermission":"shell"}',
    '{"action":"block","reason":"r","whatWouldUnblock":"","closeTicket":"BLK-1"}',
    '{"action":"replan","summary":"s","steps":[{"title":"x"}],"rationale":"","maxUsd":50}',
  ])("halts for security when a proposal asks for a capability it cannot hold: %s", (raw) => {
    expect(parseStrategicVerdict(raw)).toMatchObject({ action: "halt", category: "security" });
  });

  it("halts on an unknown action and on an unreadable reply", () => {
    expect(parseStrategicVerdict('{"action":"reprioritize","workId":"x"}')).toMatchObject({ action: "halt", category: "incoherent" });
    expect(parseStrategicVerdict("I think we should keep going")).toMatchObject({ action: "halt" });
  });
});

describe("deciding what happens to a verdict", () => {
  it("applies every legacy verdict unchanged, whether the strategic path is on or off", () => {
    for (const verdict of [{ action: "continue", message: "m", rationale: "" }, { action: "ask_user", question: "q", why: "" }] as const) {
      expect(decideStrategicVerdict(verdict, DEFAULT_STRATEGIC_POLICY, EMPTY_STRATEGIC_STATE).decision.disposition).toBe("applied");
      expect(decideStrategicVerdict(verdict, ON, EMPTY_STRATEGIC_STATE).decision.disposition).toBe("applied");
    }
  });

  it("defers every proposal while the flag is off, and changes nothing", () => {
    const { decision, state } = decideStrategicVerdict(parseStrategicVerdict(replanJson()), DEFAULT_STRATEGIC_POLICY, EMPTY_STRATEGIC_STATE);
    expect(decision).toMatchObject({ action: "replan", disposition: "deferred" });
    expect(state).toBe(EMPTY_STRATEGIC_STATE);
  });

  it("defers a plan change until a person approves it", () => {
    const { decision, state } = decideStrategicVerdict(parseStrategicVerdict(replanJson()), ON, EMPTY_STRATEGIC_STATE);
    expect(decision).toMatchObject({ action: "replan", disposition: "deferred" });
    expect(decision.reason).toMatch(/needs your approval/);
    expect(state.replans).toBe(1);
  });

  it("rejects returning to a plan already proposed in the run, which is oscillation", () => {
    const planA = parseStrategicVerdict(replanJson([{ title: "Plan A" }]));
    const planB = parseStrategicVerdict(replanJson([{ title: "Plan B" }]));
    let state: StrategicRunState = EMPTY_STRATEGIC_STATE;
    const outcomes = [planA, planB, planA].map((verdict) => {
      const result = decideStrategicVerdict(verdict, { ...ON, maxReplans: 10 }, state);
      state = result.state;
      return result.decision;
    });
    expect(outcomes.map((item) => item.disposition)).toEqual(["deferred", "deferred", "rejected"]);
    expect(outcomes[2]!.reason).toMatch(/oscillating/);
  });

  it("rejects replans beyond the run's limit", () => {
    let state: StrategicRunState = EMPTY_STRATEGIC_STATE;
    const dispositions: string[] = [];
    for (const title of ["one", "two", "three"]) {
      const result = decideStrategicVerdict(parseStrategicVerdict(replanJson([{ title }])), ON, state);
      state = result.state;
      dispositions.push(result.decision.disposition);
    }
    expect(dispositions).toEqual(["deferred", "deferred", "rejected"]);
  });

  it("never applies a delegation, reallocation or verification itself, and applies a block as a stop", () => {
    const outcome = (raw: string) => decideStrategicVerdict(parseStrategicVerdict(raw), ON, EMPTY_STRATEGIC_STATE).decision.disposition;
    expect(outcome('{"action":"delegate","workId":"w","target":"t","rationale":""}')).toBe("deferred");
    expect(outcome('{"action":"reallocate","workId":"w","toLane":"l","rationale":""}')).toBe("deferred");
    expect(outcome('{"action":"verify","workId":"w","rationale":""}')).toBe("deferred");
    expect(outcome('{"action":"block","reason":"r","whatWouldUnblock":""}')).toBe("applied");
  });

  it("fingerprints a plan by its normalized step titles", () => {
    expect(planFingerprint([{ title: "Add  a Store" }])).toBe(planFingerprint([{ title: " add a store " }]));
    expect(planFingerprint([{ title: "a" }, { title: "b" }])).not.toBe(planFingerprint([{ title: "b" }, { title: "a" }]));
  });
});

describe("when the conductor is consulted", () => {
  it.each([
    ["stalled", 0, true],
    ["step_failed", 1, false],
    ["step_failed", 2, true],
    ["executor_question", 5, false],
    ["interrupted", 5, false],
  ] as const)("trigger %s after %i attempts consults strategy: %s", (trigger, attempts, expected) => {
    expect(consultsStrategy(trigger, attempts)).toBe(expected);
  });

  it("with the flag off, gives exactly the legacy answer and makes no strategic call", async () => {
    const reply = '{"action":"ask_user","question":"Which store?","why":"A product choice."}';
    const legacyModel = modelReturning(reply);
    const strategicModel = modelReturning(reply);
    const legacy = await decideContinuation(legacyModel, brief());
    const outcome = await decideWithStrategy(strategicModel, brief(), DEFAULT_STRATEGIC_POLICY, EMPTY_STRATEGIC_STATE);
    expect(outcome.verdict).toEqual(legacy);
    expect(outcome.decision).toBeUndefined();
    expect(outcome.state).toEqual(EMPTY_STRATEGIC_STATE);
  });

  it("with the flag on, turns a replan into a question for the person rather than an action", async () => {
    const model = modelReturning(replanJson([{ title: "Add a shared store" }, { title: "Wire the middleware" }]));
    const outcome = await decideWithStrategy(model, brief(), ON, EMPTY_STRATEGIC_STATE);
    expect(outcome.verdict).toMatchObject({ action: "ask_user" });
    expect(outcome.verdict.action === "ask_user" && outcome.verdict.question).toMatch(/proposes a plan change: Share the limiter state/);
    expect(outcome.verdict.action === "ask_user" && outcome.verdict.why).toMatch(/^deferred:/);
    expect(outcome.state.calls).toBe(1);
  });

  it("shows a genuinely new dependency as a deferred plan change with the steps spelled out", async () => {
    const model = modelReturning(replanJson([
      { title: "Ask the platform team for the Redis endpoint (BLK-44)" },
      { title: "Wire the limiter to that endpoint" },
    ]));
    const outcome = await decideWithStrategy(model, brief(), ON, EMPTY_STRATEGIC_STATE);
    expect(outcome.decision).toMatchObject({ action: "replan", disposition: "deferred" });
    expect(outcome.verdict.action === "ask_user" && outcome.verdict.question).toContain("1. Ask the platform team for the Redis endpoint (BLK-44)");
  });

  it("keeps a drift halt a halt, and a legacy continue a continue", async () => {
    const drift = await decideWithStrategy(
      modelReturning('{"action":"halt","category":"intent_drift","reason":"Off the request.","whatWouldUnblock":"Confirm the scope."}'),
      brief(), ON, EMPTY_STRATEGIC_STATE,
    );
    expect(drift.verdict).toMatchObject({ action: "halt", category: "intent_drift" });
    const cont = await decideWithStrategy(
      modelReturning('{"action":"continue","message":"Use a token bucket.","rationale":"Matches the request."}'),
      brief(), ON, EMPTY_STRATEGIC_STATE,
    );
    expect(cont.verdict).toMatchObject({ action: "continue", message: "Use a token bucket." });
  });

  it("stops the run when the model cannot be reached, and when its reply cannot be read", async () => {
    const down = await decideWithStrategy(modelReturning(new Error("socket hang up")), brief(), ON, EMPTY_STRATEGIC_STATE);
    expect(down.verdict).toMatchObject({ action: "halt" });
    expect(down.verdict.action === "halt" && down.verdict.reason).toMatch(/socket hang up/);
    const garbled = await decideWithStrategy(modelReturning("sure, carry on"), brief(), ON, EMPTY_STRATEGIC_STATE);
    expect(garbled.verdict).toMatchObject({ action: "halt" });
  });

  it("meters each strategic call and falls back to the legacy conductor once the budget is spent", async () => {
    const policy: StrategicPolicy = { ...ON, maxCalls: 1 };
    // Strategic reply first; once the budget is spent, the legacy prompt answers with continue.
    const replies = [replanJson(), '{"action":"continue","message":"Use a token bucket.","rationale":""}'];
    const model = { calls: 0, async decide() { return replies[model.calls++]!; } };
    const first = await decideWithStrategy(model, brief(), policy, EMPTY_STRATEGIC_STATE);
    expect(first.state.calls).toBe(1);
    const second = await decideWithStrategy(model, brief(), policy, first.state);
    expect(model.calls).toBe(2);
    expect(second.state.calls).toBe(1);
    expect(second.decision).toBeUndefined();
    expect(second.verdict).toMatchObject({ action: "continue", message: "Use a token bucket." });
  });

  it("does not spend a strategic call on a trigger the legacy conductor answers", async () => {
    const model = modelReturning('{"action":"continue","message":"Restate the step.","rationale":""}');
    const outcome = await decideWithStrategy(model, brief({ trigger: "executor_question" }), ON, EMPTY_STRATEGIC_STATE);
    expect(outcome.state.calls).toBe(0);
    expect(outcome.verdict).toMatchObject({ action: "continue" });
  });

  it("consults on a step that has failed twice, and turns its proposal into a question", async () => {
    const model = modelReturning(replanJson());
    const outcome = await decideWithStrategy(model, brief({ trigger: "step_failed", attempts: 2 }), ON, EMPTY_STRATEGIC_STATE);
    expect(model.calls).toBe(1);
    expect(outcome.verdict.action).toBe("ask_user");
  });
});
