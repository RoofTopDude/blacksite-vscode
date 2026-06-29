import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../../src/agent-session.js";
import { createSeededScenario, ScriptedProviderSession } from "../helpers/scripted-provider-session.js";

function createContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        return store.has(key) ? (store.get(key) as T) : defaultValue;
      },
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  } as ConstructorParameters<typeof AgentSession>[0]["context"];
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("AgentSession soak", () => {
  it("stays internally consistent across a 1000-turn seeded offline run", async () => {
    const scripted = new ScriptedProviderSession(createSeededScenario(1337, 1000));
    let compressionCalls = 0;

    const session = new AgentSession({
      apiKey: "test-key",
      model: "claude-sonnet-4-6",
      systemPrompt: "Test system prompt",
      workspaceRoot: "C:/workspace",
      runtime: {
        handleMessage: vi.fn(async () => ({ result: { ok: true, entries: [] } })),
      } as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      context: createContext(),
      provider: "anthropic",
      maxIterations: 1200,
      contextLength: 100,
      compressionTriggerPct: 60,
      compressionKeepRecent: 6,
      checkpointingEnabled: true,
      providerTurnSessionFactory: () => scripted,
      memoryProvider: {
        append: () => undefined,
        readMemory: () => "",
        readContext: () => "",
      },
      compressionProvider: {
        compress: async () => {
          compressionCalls += 1;
          return `seeded-summary-${compressionCalls}`;
        },
      },
    });

    const events = await collectEvents(session.send("start"));
    const turnComplete = events.filter((event): event is Extract<AgentEvent, { type: "turn_complete" }> => event.type === "turn_complete").at(-1);
    const stopReasons = events.filter((event): event is Extract<AgentEvent, { type: "turn_complete" }> => event.type === "turn_complete").map((event) => event.stopReason);

    expect(turnComplete?.stopReason).toBe("end_turn");
    expect(stopReasons).not.toContain("protocol_violation");
    expect(stopReasons).not.toContain("error");
    expect(session.iteration).toBe(1000);
    expect(session.runtimeState.pendingGate).toBeUndefined();
    expect(session.runtimeState.fullMessageCount).toBeGreaterThanOrEqual(session.runtimeState.activeMessageCount);
    expect(session.runtimeState.compressionCount).toBeGreaterThan(0);
    expect(session.exportState(true).providerState?.["turnIndex"]).toBe(1000);
    expect(compressionCalls).toBeGreaterThan(0);
  });
});
