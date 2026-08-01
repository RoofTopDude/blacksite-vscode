import { describe, expect, it } from "vitest";
import {
  buildContinuationSystemPrompt,
  buildContinuationUserPrompt,
  decideContinuation,
  parseContinuationVerdict,
  type ContinuationBrief,
} from "../../src/continuation/continuation-model.js";

function brief(overrides: Partial<ContinuationBrief> = {}): ContinuationBrief {
  return {
    userPrompts: ["Add rate limiting to the public API, but don't touch auth."],
    planTitle: "Rate limiting",
    completed: [{ title: "Add the token bucket" }],
    current: { title: "Wire the middleware" },
    remaining: [{ title: "Add tests" }],
    executorLastMessage: "Should the limit be per-IP or per-key?",
    trigger: "executor_question",
    attempts: 0,
    ...overrides,
  };
}

describe("parseContinuationVerdict", () => {
  it("reads a well-formed continue", () => {
    const verdict = parseContinuationVerdict('{"action":"continue","message":"Per-key.","rationale":"The plan says so."}');
    expect(verdict).toEqual({ action: "continue", message: "Per-key.", rationale: "The plan says so." });
  });

  it("reads a verdict wrapped in a fence or prose", () => {
    const verdict = parseContinuationVerdict('Here is my call:\n```json\n{"action":"continue","message":"Go on."}\n```\nHope that helps.');
    expect(verdict.action).toBe("continue");
  });

  it("handles braces inside strings without truncating the object", () => {
    const verdict = parseContinuationVerdict('{"action":"continue","message":"use {a: 1} as the shape","rationale":"x"}');
    expect(verdict).toMatchObject({ action: "continue", message: "use {a: 1} as the shape" });
  });

  it("reads a halt and keeps its category", () => {
    const verdict = parseContinuationVerdict(
      '{"action":"halt","category":"irrecoverable","reason":"Next step force-pushes main.","whatWouldUnblock":"Confirm the push."}',
    );
    expect(verdict).toEqual({
      action: "halt",
      category: "irrecoverable",
      reason: "Next step force-pushes main.",
      whatWouldUnblock: "Confirm the push.",
    });
  });

  it("still halts when the category is unrecognized", () => {
    // The category shapes reporting. It must never be what decides whether a halt is honoured.
    const verdict = parseContinuationVerdict('{"action":"halt","category":"vibes","reason":"Something is off."}');
    expect(verdict).toMatchObject({ action: "halt", category: "incoherent", reason: "Something is off." });
  });

  it("reads an escalation to the user", () => {
    const verdict = parseContinuationVerdict('{"action":"ask_user","question":"Ship behind a flag?","why":"Product call."}');
    expect(verdict).toEqual({ action: "ask_user", question: "Ship behind a flag?", why: "Product call." });
  });

  /* Every one of these is a case where we do not know what the conductor decided. "We do not
     know" must never resolve to "keep going unattended" — that is exactly when an auto
     continuation does damage. */
  it.each([
    ["unparseable text", "I think you should probably keep going!"],
    ["no JSON at all", ""],
    ["an array rather than an object", "[1, 2, 3]"],
    ["malformed JSON", '{"action":"continue", "message":'],
    ["an unknown action", '{"action":"reboot"}'],
    ["continue with no message", '{"action":"continue","rationale":"looks fine"}'],
    ["continue with a blank message", '{"action":"continue","message":"   "}'],
    ["ask_user with no question", '{"action":"ask_user","why":"dunno"}'],
  ])("halts rather than continuing on %s", (_label, raw) => {
    expect(parseContinuationVerdict(raw).action).toBe("halt");
  });

  it("names a halt reason a user can act on when it cannot parse", () => {
    const verdict = parseContinuationVerdict("nonsense");
    expect(verdict).toMatchObject({ action: "halt" });
    if (verdict.action !== "halt") throw new Error("unreachable");
    expect(verdict.reason).toContain("stopped");
    expect(verdict.whatWouldUnblock).toBeTruthy();
  });
});

describe("buildContinuationUserPrompt", () => {
  it("puts the user's original words in verbatim", () => {
    // The whole reason the conductor exists: an executor forty steps deep has compacted its way
    // out of the original request, so the original has to be re-supplied unparaphrased.
    const prompt = buildContinuationUserPrompt(brief());
    expect(prompt).toContain("Add rate limiting to the public API, but don't touch auth.");
    expect(prompt).toContain("verbatim");
  });

  it("includes steps the executor has not reached, so a forward question is answerable", () => {
    const prompt = buildContinuationUserPrompt(brief({
      remaining: [{ title: "Add tests", acceptanceCriteria: "covers per-key limits" }],
    }));
    expect(prompt).toContain("NOT YET STARTED");
    expect(prompt).toContain("covers per-key limits");
  });

  it("carries the executor's question through unchanged", () => {
    expect(buildContinuationUserPrompt(brief())).toContain("Should the limit be per-IP or per-key?");
  });

  it("frames the ask differently per trigger", () => {
    expect(buildContinuationUserPrompt(brief({ trigger: "interrupted" }))).toContain("host restarted");
    expect(buildContinuationUserPrompt(brief({ trigger: "step_failed" }))).toContain("identical retry");
    expect(buildContinuationUserPrompt(brief({ trigger: "executor_question" }))).toContain("asked a question");
  });

  it("says so plainly when the executor produced nothing", () => {
    expect(buildContinuationUserPrompt(brief({ executorLastMessage: "" }))).toContain("it produced nothing");
  });

  it("lists prior decisions so the user is not asked the same thing twice", () => {
    const prompt = buildContinuationUserPrompt(brief({ priorDecisions: ["Use per-key limits."] }));
    expect(prompt).toContain("ALREADY DECIDED");
    expect(prompt).toContain("Use per-key limits.");
  });

  it("survives having no recorded prompts without pretending there were some", () => {
    expect(buildContinuationUserPrompt(brief({ userPrompts: [] }))).toContain("none recorded");
  });

  it("bounds a runaway step list instead of pasting the whole plan", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `Step ${i}` }));
    const prompt = buildContinuationUserPrompt(brief({ remaining: many }));
    expect(prompt).toContain("and 35 more");
    expect(prompt).not.toContain("Step 40");
  });

  it("reports the attempt number so a retry is visibly a retry", () => {
    expect(buildContinuationUserPrompt(brief({ attempts: 2 }))).toContain("attempt 3");
  });
});

describe("buildContinuationSystemPrompt", () => {
  it("tells the conductor it has no tools and is not doing the work", () => {
    const prompt = buildContinuationSystemPrompt();
    expect(prompt).toContain("You have no tools");
    expect(prompt).toContain("You are not doing the work");
  });

  it("makes halting a first-class outcome with the drift category spelled out", () => {
    const prompt = buildContinuationSystemPrompt();
    expect(prompt).toContain("intent_drift");
    expect(prompt).toContain("the executor does not get a vote");
    expect(prompt).toContain("Halt decisively");
  });

  it("rules out the bare 'continue' this mechanism exists to replace", () => {
    expect(buildContinuationSystemPrompt()).toContain("'Continue' on its own is never an acceptable message");
  });
});

describe("decideContinuation", () => {
  it("returns the model's verdict", async () => {
    const verdict = await decideContinuation(
      { decide: async () => '{"action":"continue","message":"Per-key, as the plan says."}' },
      brief(),
    );
    expect(verdict).toMatchObject({ action: "continue", message: "Per-key, as the plan says." });
  });

  it("halts when the provider is unreachable", async () => {
    // A provider outage is not permission to keep going unattended.
    const verdict = await decideContinuation(
      { decide: async () => { throw new Error("503 upstream"); } },
      brief(),
    );
    expect(verdict).toMatchObject({ action: "halt" });
    if (verdict.action !== "halt") throw new Error("unreachable");
    expect(verdict.reason).toContain("503 upstream");
  });

  it("passes both prompts to the model", async () => {
    const seen: string[] = [];
    await decideContinuation({
      decide: async (system, user) => {
        seen.push(system, user);
        return '{"action":"continue","message":"go"}';
      },
    }, brief());
    expect(seen[0]).toContain("You are the conductor");
    expect(seen[1]).toContain("Add rate limiting");
  });
});
