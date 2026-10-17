import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentSession, type AgentEvent } from "../../../src/agent-session.js";
import { ScriptedProviderSession } from "../../unit/helpers/scripted-provider-session.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}/scenario.json`, import.meta.url), "utf8"));
const repeated = load("repeated-failure-loop");
const progress = load("incremental-progress");

// The same failure, timestamped: must be caught. Genuine progress, every rerun failing on fewer
// and different cases: must not be. Both run through the real AgentSession loop, because the
// supervisor replay's scripted lanes never execute tools.
function resultFor(scenario: Record<string, any>, round: number): Record<string, unknown> {
  const verification = { status: "failed", updatedAt: scenario.clockStart + round };
  // A real runner prints when it started and how long it took, so no two runs print the same bytes.
  const clock = `20:${String(10 + (round % 50)).padStart(2, "0")}:${String((round * 7) % 60).padStart(2, "0")}`;
  const runnerLog = (body: string) => ` RUN  v4.1.11\n${body}\n   Start at  ${clock}\n   Duration  ${(1 + round / 10).toFixed(2)}s`;
  if (scenario.result) {
    return {
      ...scenario.result, durationMs: round * scenario.durationStepMs, verification,
      rawOutput: runnerLog(" FAIL  synthetic assertion: expected 2, received 1"),
    };
  }
  const failed = Math.max(1, scenario.failedStart - round + 1);
  return {
    ok: false, passed: 0, failed,
    failures: [{ name: `case-${round}`, message: `expected ${round}, received ${round - 1}` }],
    durationMs: round * scenario.durationStepMs,
    verification,
    rawOutput: runnerLog(` FAIL  case-${round}`),
  };
}

async function runScenario(scenario: Record<string, any>, enabled: boolean) {
  let rounds = 0;
  let firstIntervention: number | undefined;
  const scripted = new ScriptedProviderSession(({ turnIndex }) => ({
    toolCalls: [{ type: "tool_use", id: `test-${turnIndex}`, name: scenario.tool, input: scenario.input }],
    stopReason: "tool_use",
  }));
  const session = new AgentSession({
    apiKey: "synthetic", model: "claude-sonnet-4-6", provider: "anthropic",
    workspaceRoot: "C:/workspace", systemPrompt: "Synthetic repeated-failure fixture",
    checkpointingEnabled: false, normalizeToolRounds: enabled,
    providerTurnSessionFactory: () => scripted,
    context: { workspaceState: { get: () => undefined, update: async () => {} } } as never,
    runtime: { handleMessage: async () => ({ result: resultFor(scenario, ++rounds) }) } as never,
  });
  const events: AgentEvent[] = [];
  for await (const event of session.send("Run the failing tests.")) {
    events.push(event);
    if (event.type === "execution_diagnostic" && event.message.includes("identical tool rounds")) firstIntervention ??= rounds;
  }
  const exhausted = events.some((event) => event.type === "turn_complete" && event.stopReason === "max_iterations");
  return { rounds, firstIntervention, exhausted };
}

describe("#20 duplicate-round detection through AgentSession", () => {
  it.each([true, false])("intervenes on timestamped identical failures before the budget (enabled=%s)", async (enabled) => {
    const { rounds, firstIntervention, exhausted } = await runScenario(repeated, enabled);
    expect(rounds).toBe(repeated.iterationBudget);
    expect(exhausted).toBe(true);
    if (enabled) {
      expect(firstIntervention).toBe(repeated.interventionByRound);
      expect(firstIntervention).toBeLessThan(repeated.iterationBudget);
    } else expect(firstIntervention).toBeUndefined();
  });

  it.each([true, false])("never intervenes on genuine incremental progress (enabled=%s)", async (enabled) => {
    const { rounds, firstIntervention, exhausted } = await runScenario(progress, enabled);
    expect(rounds).toBe(progress.iterationBudget);
    expect(exhausted).toBe(true);
    expect(firstIntervention).toBeUndefined();
  });
});
