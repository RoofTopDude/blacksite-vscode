import { describe, expect, it } from "vitest";
import { PlanContinuationService } from "../../src/plans/plan-continuation-service.js";
import { DEFAULT_STRATEGIC_POLICY, type StrategicPolicy } from "../../src/continuation/strategic-verdict.js";
import type { PlanningDocument, TaskPlan, TaskPlanPhase, TaskPlanStep } from "../../src/planning-store.js";

// Service-level checks for the strategic conductor (#16): the flag gates everything, and a proposal
// is shown to the person rather than sent back into the agent.

const step = (id: string): TaskPlanStep => ({ id, title: `Step ${id}`, status: "pending", notes: [], updatedAt: "2026-08-01T10:00:00.000Z" }) as TaskPlanStep;
const phase = (id: string, steps: TaskPlanStep[]): TaskPlanPhase => ({
  id, title: `Phase ${id}`, status: "in_progress", steps, notes: [], blocks: [], docs: [], linkedTodoIds: [], updatedAt: "2026-08-01T10:00:00.000Z",
}) as TaskPlanPhase;
const plan = (): TaskPlan => ({
  id: "plan1", title: "Ship rate limiting", status: "active", phases: [phase("p1", [step("a")])],
  blocks: [], docs: [], agentCanArchive: false, executionApproved: true, notes: [],
  createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
}) as TaskPlan;
const planning = { read: (): PlanningDocument => ({ schemaVersion: 1, updatedAt: null, plans: [plan()], todoRuns: [] }) } as unknown as import("../../src/planning-store.js").PlanningStore;
const CLEAN_TURN = { stopReason: "end_turn", errored: false, awaitingUser: false, lastMessage: "Done with step one." };

function harness(reply: string, policy: StrategicPolicy | undefined) {
  const sent: string[] = [];
  const reported: Array<{ kind: string; message: string }> = [];
  const traces: string[] = [];
  const service = new PlanContinuationService(
    planning,
    () => ({ decide: async () => reply }),
    () => ["Add rate limiting, but don't touch auth."],
    () => ({ enabled: true, maxConsecutive: 3 }),
    {
      continueWith: async (message) => { sent.push(message); },
      report: (kind, message) => { reported.push({ kind, message }); },
      trace: (message) => { traces.push(message); },
    },
    undefined,
    policy ? () => policy : undefined,
  );
  return { service, sent, reported, traces };
}

const ON: StrategicPolicy = { ...DEFAULT_STRATEGIC_POLICY, enabled: true };
const replan = '{"action":"replan","summary":"Share the limiter state","steps":[{"title":"Add a shared store"}],"rationale":"Per-process state."}';

describe("PlanContinuationService with the strategic conductor", () => {
  it("shows a replan to the person instead of sending it to the agent, and says it was deferred", async () => {
    const { service, sent, reported, traces } = harness(replan, ON);
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual([]);
    expect(reported).toEqual([expect.objectContaining({ kind: "ask" })]);
    expect(reported[0]!.message).toContain("proposes a plan change: Share the limiter state");
    expect(traces.some((line) => line.startsWith("Conductor proposal deferred:"))).toBe(true);
    expect(service.consecutive).toBe(0);
  });

  it("with the flag off, sends a continue exactly as before", async () => {
    const { service, sent } = harness('{"action":"continue","message":"Now wire the middleware.","rationale":""}', undefined);
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual(["Now wire the middleware."]);
  });

  it("with the flag on, still sends a plain continue back to the agent", async () => {
    const { service, sent } = harness('{"action":"continue","message":"Now wire the middleware.","rationale":""}', ON);
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual(["Now wire the middleware."]);
  });

  it("asks the person when a proposal is a block, rather than continuing", async () => {
    const { service, sent, reported } = harness('{"action":"block","reason":"Needs a decision on the store","whatWouldUnblock":"Pick one"}', ON);
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual([]);
    expect(reported[0]).toMatchObject({ kind: "ask" });
    expect(reported[0]!.message).toContain("Needs a decision on the store");
  });

  it("halts when the reply asks for a budget change, with the flag on", async () => {
    const { service, sent, reported } = harness('{"action":"verify","workId":"a","budgetIncrease":10}', ON);
    await service.afterTurn(CLEAN_TURN);
    expect(sent).toEqual([]);
    expect(reported[0]).toMatchObject({ kind: "halt" });
  });
});
