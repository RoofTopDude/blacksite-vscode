import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type SubagentProviderMessage } from "../../src/agent-session.js";
import { loadCheckpoint } from "../../src/checkpoint.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => { if (value === undefined) store.delete(key); else store.set(key, value); },
    },
  } as Parameters<typeof loadCheckpoint>[0];
}

function createFakePlanningProvider() {
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    dispatch: vi.fn(async (op: string, payload: Record<string, unknown>) => {
      calls.push({ op, payload });
      return { ok: true, updated: true };
    }),
  };
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const runtime = overrides.runtime ?? { handleMessage: vi.fn(async () => ({ result: { ok: true, entries: [] } })) };
  const session = new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: createFakeContext(),
    provider: "anthropic",
    maxIterations: 10,
    checkpointingEnabled: false,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    ...overrides,
  });
  return { session, runtime };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function subagentSpawnTool(id: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id, name: "subagent_spawn", input: { task: "do the step", ...input } };
}

async function* stubSubagentSuccess(): AsyncGenerator<SubagentProviderMessage> {
  yield {
    type: "subagent_tool_result",
    result: {
      ok: true, subRequestId: "sub-1", answer: "Completed the step's work.", toolRounds: 1, usage: null, scratchFiles: [],
      budget: { complexity: "standard", idleTimeoutSeconds: 60, maxRuntimeSeconds: 300, maxToolRounds: 5 },
    },
  };
}

async function* stubSubagentFailure(): AsyncGenerator<SubagentProviderMessage> {
  yield { type: "subagent_tool_result", result: { ok: false, error: "hit a wall" } };
}

async function* stubSubagentTimeout(): AsyncGenerator<SubagentProviderMessage> {
  yield {
    type: "subagent_tool_result",
    result: {
      ok: false,
      subRequestId: "sub-timeout",
      error: "Lane timed out after 120s.",
      failureKind: "timeout",
      budget: { complexity: "standard", idleTimeoutSeconds: 120, maxRuntimeSeconds: 600, maxToolRounds: 5 },
      toolRounds: 2,
      elapsedMs: 120_000,
      stopReason: "cancelled",
      partialAnswer: "",
      executionTrace: [],
      executionTraceTruncated: false,
      filesTouched: [],
      nextStep: "Retry the remaining work with a narrower task.",
    },
  };
}

describe("AgentSession — subagent lanes linked to a plan step", () => {
  it("marks the step in_progress at spawn and leaves a note (not completed) on success", async () => {
    const planningProvider = createFakePlanningProvider();
    const subagentProvider = { spawn: vi.fn(stubSubagentSuccess) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [subagentSpawnTool("spawn-0", { planId: "plan-1", phaseId: "phase-1", stepId: "step-1" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    await collectEvents(session.send("delegate step-1"));

    expect(planningProvider.calls).toHaveLength(2);
    expect(planningProvider.calls[0]).toMatchObject({
      op: "update",
      payload: { planId: "plan-1", phaseId: "phase-1", stepId: "step-1", stepStatus: "in_progress" },
    });
    // Success never sets stepStatus itself — only a note; the orchestrator decides completion.
    expect(planningProvider.calls[1]!.payload.stepStatus).toBeUndefined();
    expect(String(planningProvider.calls[1]!.payload.stepNote)).toContain("Completed the step's work.");
  });

  it("marks the step blocked with the error when the lane fails", async () => {
    const planningProvider = createFakePlanningProvider();
    const subagentProvider = { spawn: vi.fn(stubSubagentFailure) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [subagentSpawnTool("spawn-0", { planId: "plan-1", phaseId: "phase-1", stepId: "step-1" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    await collectEvents(session.send("delegate step-1"));

    expect(planningProvider.calls[1]).toMatchObject({
      op: "update",
      payload: { planId: "plan-1", phaseId: "phase-1", stepId: "step-1", stepStatus: "blocked" },
    });
    expect(String(planningProvider.calls[1]!.payload.stepNote)).toContain("hit a wall");
  });

  it("returns the step to pending when a lane times out so interruption is not recorded as a blocker", async () => {
    const planningProvider = createFakePlanningProvider();
    const subagentProvider = { spawn: vi.fn(stubSubagentTimeout) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [subagentSpawnTool("spawn-timeout", { planId: "plan-1", phaseId: "phase-1", stepId: "step-1" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    await collectEvents(session.send("delegate step-1"));

    expect(planningProvider.calls[1]).toMatchObject({
      op: "update",
      payload: { planId: "plan-1", phaseId: "phase-1", stepId: "step-1", stepStatus: "pending" },
    });
    expect(String(planningProvider.calls[1]!.payload.stepNote)).toContain("interrupted");
  });

  it("does not touch the plan when only a partial link is given", async () => {
    const planningProvider = createFakePlanningProvider();
    const subagentProvider = { spawn: vi.fn(stubSubagentSuccess) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        // phaseId/stepId missing — planId alone can't identify a step.
        toolCalls: [subagentSpawnTool("spawn-0", { planId: "plan-1" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    await collectEvents(session.send("delegate"));

    expect(planningProvider.dispatch).not.toHaveBeenCalled();
  });

  it("syncs the linked step in the parallel-dispatch path too", async () => {
    const planningProvider = createFakePlanningProvider();
    const subagentProvider = { spawn: vi.fn(stubSubagentSuccess) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [subagentSpawnTool("spawn-0", { planId: "plan-1", phaseId: "phase-1", stepId: "step-1", parallel: true })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    await collectEvents(session.send("delegate step-1 in parallel"));

    expect(planningProvider.calls[0]).toMatchObject({ payload: { stepStatus: "in_progress" } });
    expect(planningProvider.calls[1]!.payload.stepNote).toBeDefined();
  });

  it("does not start a linked lane when the plan execution gate rejects it", async () => {
    const planningProvider = { dispatch: vi.fn(async () => ({ ok: false, error: "Execution approval is still required." })) };
    const subagentProvider = { spawn: vi.fn(stubSubagentSuccess) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [subagentSpawnTool("spawn-0", { planId: "plan-1", phaseId: "phase-1", stepId: "step-1" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    const events = await collectEvents(session.send("delegate step-1"));

    expect(subagentProvider.spawn).not.toHaveBeenCalled();
    expect(planningProvider.dispatch).toHaveBeenCalledTimes(1);
    const spawnResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_call_result" }> => e.type === "tool_call_result" && e.toolCallId === "spawn-0",
    );
    expect(spawnResult?.ok).toBe(false);
    expect(spawnResult?.summary).toContain("Execution approval is still required");
  });

  it("never fails the subagent_spawn tool call itself when planningProvider.dispatch rejects", async () => {
    const planningProvider = { dispatch: vi.fn(async () => { throw new Error("disk full"); }) };
    const subagentProvider = { spawn: vi.fn(stubSubagentSuccess) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [subagentSpawnTool("spawn-0", { planId: "plan-1", phaseId: "phase-1", stepId: "step-1" })],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({ providerTurnSessionFactory: () => scripted, subagentProvider, planningProvider });
    const events = await collectEvents(session.send("delegate step-1"));

    const spawnResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_call_result" }> => e.type === "tool_call_result" && e.toolCallId === "spawn-0",
    );
    expect(spawnResult?.ok).toBe(true);
  });
});
