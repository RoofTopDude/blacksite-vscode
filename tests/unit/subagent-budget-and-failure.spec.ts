import { describe, expect, it } from "vitest";
import {
  classifyLaneFailure,
  collectTouchedPath,
  createLaneWatchdog,
  isLaneTimeoutReason,
  LANE_RUNTIME_CAP_REASON,
  LANE_STALL_REASON,
  laneFailureNextStep,
  normalizeDelegatedComplexity,
  resolveSubagentBudget,
  type LaneWatchdogClock,
} from "../../src/chat-provider.js";

const SESSION_MAX_ITERATIONS = 8;

/**
 * A hand-cranked clock, so the watchdog's minutes-long windows can be tested in microseconds.
 * Timers fire only when {@link advance} moves the clock past their due time, which is exactly
 * how the real event loop behaves and lets a test assert that a timer did *not* fire.
 */
function fakeClock(): LaneWatchdogClock & { advance(ms: number): void; now(): number } {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { dueAt: number; fn: () => void }>();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { dueAt: current + ms, fn });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = current + ms;
      // Re-scanned each pass because a firing timer typically re-arms itself.
      for (;;) {
        let due: { id: number; dueAt: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.dueAt <= target && (!due || timer.dueAt < due.dueAt)) due = { id, ...timer };
        }
        if (!due) break;
        timers.delete(due.id);
        current = due.dueAt;
        due.fn();
      }
      current = target;
    },
  };
}

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
  it("scales both clocks and the tool rounds with the rating", () => {
    const standard = budgetFor("standard");
    const complex = budgetFor("complex");
    const deep = budgetFor("deep");

    expect(standard.idleTimeoutSeconds).toBeLessThan(complex.idleTimeoutSeconds);
    expect(complex.idleTimeoutSeconds).toBeLessThan(deep.idleTimeoutSeconds);
    expect(standard.maxRuntimeSeconds).toBeLessThan(complex.maxRuntimeSeconds);
    expect(complex.maxRuntimeSeconds).toBeLessThan(deep.maxRuntimeSeconds);
    expect(standard.maxToolRounds).toBeLessThan(complex.maxToolRounds);
    expect(complex.maxToolRounds).toBeLessThan(deep.maxToolRounds);
  });

  it("gives the runtime ceiling real headroom over the silence window", () => {
    // The whole point of splitting the two: a lane that keeps producing output must be able
    // to run far longer than one idle window, or the split buys nothing over a fixed timer.
    for (const complexity of ["standard", "complex", "deep"] as const) {
      const budget = budgetFor(complexity);
      expect(budget.maxRuntimeSeconds).toBeGreaterThanOrEqual(budget.idleTimeoutSeconds * 3);
    }
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

describe("createLaneWatchdog", () => {
  const BUDGET = { idleTimeoutSeconds: 100, maxRuntimeSeconds: 1000 };

  function watchdogFor(budget = BUDGET) {
    const clock = fakeClock();
    const aborts: string[] = [];
    const watchdog = createLaneWatchdog(budget, (reason) => aborts.push(reason), clock);
    return { clock, aborts, watchdog };
  }

  it("kills a lane that goes silent for the whole idle window", () => {
    const { clock, aborts } = watchdogFor();
    clock.advance(99_000);
    expect(aborts).toEqual([]);
    clock.advance(2_000);
    expect(aborts).toEqual([LANE_STALL_REASON]);
  });

  it("keeps a working lane alive far past the old fixed timeout", () => {
    // The regression this whole watchdog exists for: under the previous fixed timer this lane
    // died at 100s despite emitting output the entire time.
    const { clock, aborts, watchdog } = watchdogFor();
    for (let elapsed = 0; elapsed < 900_000; elapsed += 30_000) {
      clock.advance(30_000);
      watchdog.note({ type: "text_delta" });
    }
    expect(aborts).toEqual([]);
  });

  it("still stops a lane that stays busy past the runtime ceiling", () => {
    const { clock, aborts, watchdog } = watchdogFor();
    for (let elapsed = 0; elapsed < 1_200_000; elapsed += 30_000) {
      clock.advance(30_000);
      watchdog.note({ type: "tool_call_result" });
    }
    expect(aborts).toEqual([LANE_RUNTIME_CAP_REASON]);
  });

  it("does not charge the lane for time spent waiting on a human", () => {
    // An approval prompt can sit unanswered for an hour. Neither clock may run meanwhile,
    // or every lane that asks for permission dies waiting for the answer.
    const { clock, aborts, watchdog } = watchdogFor();
    watchdog.note({ type: "approval_pending" });
    clock.advance(3_600_000);
    expect(aborts).toEqual([]);
    expect(watchdog.blockedMs).toBe(3_600_000);

    watchdog.note({ type: "approval_result" });
    clock.advance(99_000);
    expect(aborts).toEqual([]);
    clock.advance(2_000);
    expect(aborts).toEqual([LANE_STALL_REASON]);
  });

  it("waits for the last of several outstanding approvals before restarting the clock", () => {
    const { clock, aborts, watchdog } = watchdogFor();
    watchdog.note({ type: "approval_pending" });
    watchdog.note({ type: "question_card_pending" });
    watchdog.note({ type: "approval_result" });
    clock.advance(500_000);
    expect(aborts).toEqual([]);
    watchdog.note({ type: "question_card_result" });
    clock.advance(101_000);
    expect(aborts).toEqual([LANE_STALL_REASON]);
  });

  it("aborts at most once and never after stop()", () => {
    const { clock, aborts, watchdog } = watchdogFor();
    clock.advance(101_000);
    expect(aborts).toEqual([LANE_STALL_REASON]);
    clock.advance(10_000_000);
    expect(aborts).toEqual([LANE_STALL_REASON]);

    const second = watchdogFor();
    second.watchdog.stop();
    second.clock.advance(10_000_000);
    expect(second.aborts).toEqual([]);
  });

  it("treats both expiries as timeouts so the parent handles them the same way", () => {
    expect(isLaneTimeoutReason(LANE_STALL_REASON)).toBe(true);
    expect(isLaneTimeoutReason(LANE_RUNTIME_CAP_REASON)).toBe(true);
    expect(isLaneTimeoutReason("Parent run cancelled.")).toBe(false);
    expect(isLaneTimeoutReason(undefined)).toBe(false);
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
    expect(guidance).toContain(`${budget.idleTimeoutSeconds}s`);
    expect(guidance).toContain(`${budget.maxRuntimeSeconds}s`);
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
