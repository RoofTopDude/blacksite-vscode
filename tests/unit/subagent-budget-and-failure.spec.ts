import { describe, expect, it } from "vitest";
import {
  classifyLaneFailure,
  collectTouchedPath,
  laneFailureNextStep,
  normalizeDelegatedComplexity,
  resolveSubagentBudget,
} from "../../src/chat-provider.js";

const SESSION_MAX_ITERATIONS = 8;

function budgetFor(complexity: "standard" | "complex" | "deep" | "auto" | undefined, task = "do the thing") {
  return resolveSubagentBudget({ task, complexity }, SESSION_MAX_ITERATIONS);
}

describe("normalizeDelegatedComplexity", () => {
  it("honours an explicit rating over the size heuristic", () => {
    // A one-line task rated deep must stay deep: the whole point of the rating is that
    // the model knows the work is large when the prompt is not.
    expect(normalizeDelegatedComplexity({ task: "Audit auth.", complexity: "deep" })).toBe("deep");
    // And a very long prompt rated standard must not be inflated back up.
    expect(normalizeDelegatedComplexity({ task: "x".repeat(20_000), complexity: "standard" })).toBe("standard");
  });

  it("falls back to a size heuristic only when unrated or auto", () => {
    expect(normalizeDelegatedComplexity({ task: "short" })).toBe("standard");
    expect(normalizeDelegatedComplexity({ task: "short", complexity: "auto" })).toBe("standard");
    expect(normalizeDelegatedComplexity({ task: "x".repeat(4_000), complexity: "auto" })).toBe("complex");
    expect(normalizeDelegatedComplexity({ task: "x".repeat(11_000), complexity: "auto" })).toBe("deep");
  });

  it("counts context toward the heuristic, not just the task", () => {
    expect(normalizeDelegatedComplexity({ task: "x".repeat(2_000), context: "y".repeat(2_000) })).toBe("complex");
  });
});

describe("resolveSubagentBudget", () => {
  it("scales both the clock and the tool rounds with the rating", () => {
    const standard = budgetFor("standard");
    const complex = budgetFor("complex");
    const deep = budgetFor("deep");

    expect(standard.timeoutSeconds).toBeLessThan(complex.timeoutSeconds);
    expect(complex.timeoutSeconds).toBeLessThan(deep.timeoutSeconds);
    expect(standard.maxToolRounds).toBeLessThan(complex.maxToolRounds);
    expect(complex.maxToolRounds).toBeLessThan(deep.maxToolRounds);
  });

  it("always leaves iteration headroom above the tool-round budget", () => {
    // A lane that runs out of iterations exactly as it runs out of tool rounds has no
    // turn left to write its answer in, which would surface as a bogus no_answer.
    for (const complexity of ["standard", "complex", "deep"] as const) {
      const budget = budgetFor(complexity);
      expect(budget.maxIterations).toBeGreaterThan(budget.maxToolRounds);
    }
  });
});

describe("classifyLaneFailure", () => {
  it("distinguishes the four outcomes the parent has to act on differently", () => {
    expect(classifyLaneFailure(true, false, "")).toBe("timeout");
    // A timeout that still produced partial text is still a timeout — the clock is why it died.
    expect(classifyLaneFailure(true, false, "partial findings")).toBe("timeout");
    expect(classifyLaneFailure(false, true, "")).toBe("cancelled");
    expect(classifyLaneFailure(false, false, "")).toBe("no_answer");
    expect(classifyLaneFailure(false, false, "text but errored")).toBe("error");
  });
});

describe("laneFailureNextStep", () => {
  it("tells the parent to check the partial answer before respawning", () => {
    const guidance = laneFailureNextStep("timeout", budgetFor("complex"), true);
    expect(guidance).toContain("partialAnswer");
    expect(guidance.toLowerCase()).toContain("without respawning");
  });

  it("says so plainly when there is no partial answer to salvage", () => {
    const guidance = laneFailureNextStep("timeout", budgetFor("complex"), false);
    expect(guidance).toContain("executionTrace");
    expect(guidance).toContain("no partial answer");
  });

  it("encourages a narrowed respawn on timeout and cites the budget it blew", () => {
    const budget = budgetFor("complex");
    const guidance = laneFailureNextStep("timeout", budget, true);
    expect(guidance).toContain(`${budget.timeoutSeconds}s`);
    expect(guidance).toContain(`${budget.maxToolRounds}-round`);
    expect(guidance).toContain("complex");
    expect(guidance).toContain("already done");
  });

  it("discourages an identical respawn when the lane finished and produced nothing", () => {
    const guidance = laneFailureNextStep("no_answer", budgetFor("standard"), false);
    expect(guidance).toContain("repeat this");
  });

  it("notes that a cancellation says nothing about the task itself", () => {
    expect(laneFailureNextStep("cancelled", budgetFor("standard"), true)).toContain("not exhausted");
  });
});

describe("collectTouchedPath", () => {
  it("picks up a workspace path from any of the common argument names", () => {
    for (const key of ["path", "filePath", "file", "target", "directory", "dir"]) {
      const found = new Set<string>();
      collectTouchedPath({ [key]: "src/agent-session.ts" }, found);
      expect([...found]).toEqual(["src/agent-session.ts"]);
    }
  });

  it("records one path per call and de-duplicates across calls", () => {
    const found = new Set<string>();
    collectTouchedPath({ path: "src/a.ts", filePath: "src/b.ts" }, found);
    collectTouchedPath({ path: "src/a.ts" }, found);
    expect([...found]).toEqual(["src/a.ts"]);
  });

  it("ignores non-string and blank values instead of recording empty paths", () => {
    const found = new Set<string>();
    collectTouchedPath({ path: "   " }, found);
    collectTouchedPath({ path: 42 }, found);
    collectTouchedPath({ query: "not a path" }, found);
    expect(found.size).toBe(0);
  });

  it("stops collecting once the cap is reached so a failure stays bounded", () => {
    const found = new Set<string>();
    for (let i = 0; i < 60; i += 1) collectTouchedPath({ path: `src/file-${i}.ts` }, found);
    expect(found.size).toBe(30);
  });
});
