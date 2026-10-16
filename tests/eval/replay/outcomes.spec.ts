/* What each scenario is for, asserted directly. Golden files catch any change; these catch a
   change that would still be wrong if someone regenerated the golden files over it. */

import { describe, expect, it } from "vitest";
import { ARMS, loadTraces, replay } from "../harness/run-scenarios.js";
import type { LoopReplay } from "../harness/loop-driver.js";
import type { PlanRunReplay } from "../harness/plan-run-driver.js";
import { compareScorecards, receiptAgreement, type Scorecard } from "../harness/scorecard.js";

const traces = new Map(loadTraces().map(({ trace }) => [trace.header.scenario, trace] as const));
const [BASELINE, OBSERVE, ENFORCE] = ARMS as [typeof ARMS[0], typeof ARMS[0], typeof ARMS[0]];

async function loop(scenario: string, arm = BASELINE): Promise<LoopReplay> {
  return await replay(traces.get(scenario)!, arm) as LoopReplay;
}
async function plan(scenario: string, arm = BASELINE): Promise<PlanRunReplay> {
  return await replay(traces.get(scenario)!, arm) as PlanRunReplay;
}
const iterations = (result: LoopReplay) => result.loop.iterations as Array<{ ticketId: string; outcome: string }>;

describe("loop scenarios", () => {
  it("retry: a failed lane is retried with its guidance and then succeeds", async () => {
    const result = await loop("loop-retry-then-succeed");
    expect(iterations(result).filter((entry) => entry.ticketId === "T-1").map((entry) => entry.outcome)).toEqual(["failed", "succeeded"]);
    expect(result.scorecard).toMatchObject({ retries: 1, verifiedSuccess: 2, falseCompletions: 0 });
  });

  it("crash: the lane in flight is abandoned, not charged, and re-dispatched on resume", async () => {
    const result = await loop("loop-crash-mid-lane");
    expect(iterations(result).filter((entry) => entry.ticketId === "T-1").map((entry) => entry.outcome)).toEqual(["abandoned", "succeeded"]);
    expect(result.hooks.map((hook) => hook.hook)).toContain("crash");
    expect(result.scorecard.abandoned).toBe(1);
    const observed = await loop("loop-crash-mid-lane", OBSERVE);
    expect(observed.hooks.some((hook) => hook.hook === "abandoned_contract")).toBe(true);
  });

  it("park: a refused approval parks the ticket until the user releases it", async () => {
    const result = await loop("loop-park-release");
    expect(iterations(result).map((entry) => entry.outcome)).toEqual(["parked", "succeeded"]);
    expect(result.scorecard).toMatchObject({ parks: 1, interventions: 2 });
  });

  it("halt: consecutive identical failures stop the loop", async () => {
    const result = await loop("loop-consecutive-failure-halt");
    expect(result.loop.status).toBe("stopped");
    expect(result.scorecard).toMatchObject({ halts: 1, repeatedFailures: 1, verifiedSuccess: 0 });
  });

  it("budget: live spend crossing the ceiling stops dispatch while running lanes finish", async () => {
    const result = await loop("loop-spend-ceiling");
    expect(result.loop.status).toBe("stopped");
    expect(iterations(result).map((entry) => entry.ticketId)).not.toContain("T-3");
    expect(result.scorecard.budgetStops).toBe(1);
  });

  it("conflict: disjoint declarations that collide in practice are counted", async () => {
    const result = await loop("loop-territory-overlap");
    expect(result.scorecard.conflicts.occurred).toBe(1);
    const enforce = await loop("loop-territory-overlap", ENFORCE);
    expect(enforce.scorecard.receipts?.disagree).toBe(1);
  });

  it("false completion: enforcing receipts keep a failed check out of review", async () => {
    const baseline = await loop("loop-false-completion");
    const observe = await loop("loop-false-completion", OBSERVE);
    const enforce = await loop("loop-false-completion", ENFORCE);
    expect(baseline.scorecard.falseCompletions).toBe(1);
    expect(observe.scorecard.falseCompletions).toBe(1);
    expect(enforce.scorecard.falseCompletions).toBe(0);
    expect(enforce.tickets.find((ticket) => ticket.id === "T-1")?.status).not.toBe("review");
    // Verified success is unchanged: enforcement removed a false completion, not a real one.
    const comparison = compareScorecards(baseline.scorecard, enforce.scorecard, { costTolerance: 1 });
    expect(comparison.deltas.find((delta) => delta.field === "verifiedSuccess")?.regression).toBe(false);
    expect(comparison.deltas.find((delta) => delta.field === "falseCompletions")?.regression).toBe(false);
  });
});

describe("plan-run scenarios", () => {
  it("long run: provider outage, compaction and a retried step still finish", async () => {
    const result = await plan("plan-long-outage");
    expect(result.run.status).toBe("completed");
    expect(result.run.compactions).toBe(1);
    expect((result.run.waitingProviderMs as number) > 0).toBe(true);
    expect(result.scorecard.retries).toBe(1);
  });

  it("defer: a queued decision is answered and the run completes", async () => {
    const result = await plan("plan-defer-and-answer");
    expect(result.run.decisions).toEqual([{ id: "D1", status: "approved" }]);
    expect(result.run.status).toBe("completed");
  });

  it("halt: the conductor pauses the run with its reason", async () => {
    const result = await plan("plan-conductor-halt");
    expect(result.run.status).toBe("paused");
    expect(result.scorecard.halts).toBe(1);
  });

  it("tripwire: the same failure six times pauses the run", async () => {
    const result = await plan("plan-tripwire-repeated-failure");
    expect(result.run.tripwires).toEqual(["repeated_failure"]);
    expect(result.scorecard.repeatedFailures).toBe(1);
  });

  it("budget: reaching the ceiling ends the run as budget-exhausted", async () => {
    const result = await plan("plan-budget-exhausted");
    expect(result.run.status).toBe("budget_exhausted");
    expect(result.scorecard.budgetStops).toBe(1);
  });

  it("crash: recovery marks the run interrupted and it resumes to completion", async () => {
    const result = await plan("plan-crash-mid-step");
    expect(result.run.status).toBe("completed");
    expect(result.scorecard.abandoned).toBe(1);
    expect(result.launches.length).toBeGreaterThan(0);
  });

  it("false completion: a step the agent marked done but the verifier rejects is not verified", async () => {
    const result = await plan("plan-false-completion", ENFORCE);
    expect(result.scorecard).toMatchObject({ selfReportedSuccess: 2, verifiedSuccess: 1, falseCompletions: 1 });
    // Its receipt said "not verified", which is honest, not a disagreement.
    expect(result.scorecard.receipts).toMatchObject({ disagree: 0 });
  });
});

describe("scorecard rules", () => {
  const card = (overrides: Partial<Scorecard>): Scorecard => ({
    scenario: "s", subject: "loop", arm: "baseline", subjects: 2, verifiedSuccess: 2, selfReportedSuccess: 2, falseCompletions: 0,
    elapsedMs: 1, costUsd: 1, costPerVerifiedSuccess: 0.5, interventions: 0, repeatedFailures: 0, conflicts: { occurred: 0 },
    retries: 0, parks: 0, abandoned: 0, halts: 0, budgetStops: 0, ...overrides,
  });

  it("flags fewer verified successes, more false completions, more interventions, and costlier success", () => {
    const { deltas, regressed } = compareScorecards(card({}), card({ verifiedSuccess: 1, falseCompletions: 1, interventions: 1, costPerVerifiedSuccess: 1 }));
    expect(regressed).toBe(true);
    expect(deltas.filter((delta) => delta.regression).map((delta) => delta.field).sort())
      .toEqual(["costPerVerifiedSuccess", "falseCompletions", "interventions", "verifiedSuccess"]);
    expect(compareScorecards(card({}), card({ costPerVerifiedSuccess: 0.54 })).regressed).toBe(false);
    expect(compareScorecards(card({}), card({ costPerVerifiedSuccess: null, verifiedSuccess: 0 })).regressed).toBe(true);
  });

  it("only counts a receipt as disagreeing when it made a claim", () => {
    expect(receiptAgreement("verified", "fail")).toBe("disagree");
    expect(receiptAgreement("failed", "pass")).toBe("disagree");
    expect(receiptAgreement("succeeded_unverified", "fail")).toBe("unknown");
    expect(receiptAgreement("verified", undefined)).toBe("unknown");
  });
});
