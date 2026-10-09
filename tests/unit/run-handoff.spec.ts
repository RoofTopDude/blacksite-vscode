import { describe, expect, it } from "vitest";
import { buildHandoff, buildTurnDigest, describeStopReason, handoffForNextTurn } from "../../src/plans/run-handoff.js";

describe("buildHandoff", () => {
  it("says where the plan stood, what changed and what was never checked", () => {
    const text = buildHandoff({
      reason: "max_iterations",
      maxIterations: 40,
      planTitle: "Migrate billing",
      phaseIndex: 2,
      phaseCount: 4,
      phaseTitle: "Ledger",
      stepPosition: 7,
      stepsTotal: 23,
      stepsDone: 6,
      currentStepTitle: "Backfill invoices",
      nextStepTitle: "Reconcile totals",
      changes: [
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: "src/b.ts", additions: 5, deletions: 0 },
      ],
      unverifiedFiles: ["src/b.ts"],
      lastFailure: { tool: "shell_run", error: "exit 1: tests failed" },
      lastNarration: "Running the backfill now.",
    });
    expect(text).toContain("Reached the 40-round limit");
    expect(text).toContain("step 7/23");
    expect(text).toContain('"Backfill invoices"');
    expect(text).toContain("phase 2/4");
    expect(text).toContain("2 files (+15 −2)");
    expect(text).toContain("Not checked: src/b.ts");
    expect(text).toContain("Last failure: shell_run: exit 1: tests failed");
    expect(text).toContain('Next: "Reconcile totals"');
  });

  it("is deterministic and bounded", () => {
    const input = { reason: "error" as const, detail: "x".repeat(5000), lastNarration: "y".repeat(5000), changes: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 1 })) };
    const a = buildHandoff(input);
    expect(buildHandoff(input)).toBe(a);
    expect(a.length).toBeLessThanOrEqual(1400);
  });

  it("lists at most a handful of files and counts the rest", () => {
    const text = buildHandoff({ reason: "paused", changes: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 })) });
    expect(text).toContain("(+4 more)");
  });

  it("states plainly when nothing changed", () => {
    expect(buildHandoff({ reason: "cancelled" })).toContain("Changed: no files.");
  });
});

describe("describeStopReason", () => {
  it("names the ceiling that was reached", () => {
    expect(describeStopReason("budget", { spentUsd: 5, maxUsd: 5 })).toBe("Spend reached $5.00 of the $5.00 ceiling.");
  });
  it("carries the provider failure", () => {
    expect(describeStopReason("provider", { detail: "529 overloaded\nretry later" })).toContain("529 overloaded retry later");
  });
});

describe("buildTurnDigest", () => {
  it("reports what the harness saw, not what the agent said", () => {
    const digest = buildTurnDigest({
      changes: [{ path: "a.ts", additions: 3, deletions: 1 }],
      unverifiedFiles: ["a.ts"],
      verificationFailed: true,
      lastFailure: { tool: "code_diagnostics", error: "2 errors" },
      toolCalls: 9,
      stepMoves: ['completed "Add parser"'],
    });
    expect(digest).toContain('Steps: completed "Add parser"');
    expect(digest).toContain("Tool calls: 9.");
    expect(digest).toContain("Files changed: 1 (+3 -1): a.ts");
    expect(digest).toContain("the last check failed");
    expect(digest).toContain("Not checked: a.ts");
    expect(digest).toContain("Last failed tool: code_diagnostics");
  });

  it("says when nothing moved", () => {
    const digest = buildTurnDigest({ changes: [], unverifiedFiles: [], verificationFailed: false, toolCalls: 0, stepMoves: [] });
    expect(digest).toContain("no step changed state");
    expect(digest).toContain("Files changed: none.");
  });
});

describe("handoffForNextTurn", () => {
  it("frames the note as a record, not an instruction", () => {
    const text = handoffForNextTurn("Stopped: x");
    expect(text).toContain("not as an instruction");
    expect(text).toContain("Stopped: x");
  });
});
