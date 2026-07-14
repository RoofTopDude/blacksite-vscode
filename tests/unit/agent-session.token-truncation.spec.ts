import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";

/**
 * Coverage for plain-text (no tool call) output-token truncation recovery, and for
 * "Unlimited" max tokens escalating to a much higher ceiling than the default. Diagnosed
 * from an execution log where a response cut off mid-text by max_tokens (no tool call in
 * flight) just ended the turn with the truncated text as the final answer — unlike the
 * pre-existing malformed-tool-call recovery, nothing retried or asked for more headroom.
 */

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const runtime = overrides.runtime ?? { handleMessage: vi.fn(async () => ({ result: { ok: true } })) };
  const session = new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: createFakeContext() as unknown as ConstructorParameters<typeof AgentSession>[0]["context"],
    provider: "anthropic",
    maxIterations: 20,
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

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("AgentSession — plain-text truncation recovery", () => {
  it("recovers from a mid-text max_tokens cutoff instead of ending the turn with the cut-off answer", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { text: "Here is the plan, the first part is", stopReason: "max_tokens", usage };
      return { text: " ...and that finishes it.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("write a long plan"));

    // Exactly one turn_complete — the mid-text cutoff did not end the session.
    const completions = events.filter((e) => e.type === "turn_complete");
    expect(completions).toHaveLength(1);
    expect((completions[0] as { stopReason: string }).stopReason).toBe("end_turn");

    // The escalation + "continue where you left off" recovery actually fired.
    expect(events.some((e) => e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("Escalating output budget"))).toBe(true);
    expect(scripted.userTexts.some((t) => t.includes("Continue exactly where you left off"))).toBe(true);
  });

  it("caps recovery attempts instead of looping forever on a permanently truncated response", async () => {
    const turnFactory: ScriptedTurnFactory = () => ({ text: "still going", stopReason: "max_tokens", usage });
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, maxIterations: 20 });

    const events = await collectEvents(session.send("write something that never finishes"));

    // Bounded by MAX_INTERNAL_AUTO_CONTINUE_TURNS — the session still terminates.
    const completions = events.filter((e) => e.type === "turn_complete");
    expect(completions).toHaveLength(1);
    expect((completions[0] as { stopReason: string }).stopReason).toBe("max_tokens");

    const escalations = events.filter((e) => e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("Escalating output budget"));
    expect(escalations).toHaveLength(3); // MAX_INTERNAL_AUTO_CONTINUE_TURNS
  });
});

describe("AgentSession — Unlimited max tokens", () => {
  it("escalates from a much higher base than a small configured maxTokens", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { text: "cut off here", stopReason: "max_tokens", usage };
      return { text: "done", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    // maxTokens is set but ignored: unlimited mode starts from MAX_ESCALATED_OUTPUT_TOKENS
    // (65536) instead, so the first escalation doubles that, not the configured 100.
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, maxTokens: 100, maxTokensUnlimited: true });

    const events = await collectEvents(session.send("write something huge"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    // Doubling the 65536 unlimited base gives 131072 — which is over Claude's real 128K output cap,
    // so the ceiling clamps it. This used to escalate to 131072 unchecked and take a hard 400: the
    // output ceiling was only known for Bedrock, leaving the Anthropic path unguarded.
    expect(events.some((e) =>
      e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("Escalating output budget to 128000 tokens"),
    )).toBe(true);
  });

  it("without Unlimited, escalation stays anchored to the small configured maxTokens", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { text: "cut off here", stopReason: "max_tokens", usage };
      return { text: "done", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, maxTokens: 100 });

    const events = await collectEvents(session.send("write something huge"));

    expect(events.some((e) =>
      e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("Escalating output budget to 200 tokens"),
    )).toBe(true);
  });
});
