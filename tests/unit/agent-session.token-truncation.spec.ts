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

    const recoveries = events.filter((e) => e.type === "execution_diagnostic" && e.level === "warn"
      && (e.message.includes("Escalating output budget") || e.message.includes("Already at the detected")));
    expect(recoveries).toHaveLength(3); // MAX_INTERNAL_AUTO_CONTINUE_TURNS
  });
});

describe("AgentSession — Unlimited max tokens", () => {
  it("starts Unlimited at the detected model ceiling instead of a fixed 64K base", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { text: "cut off here", stopReason: "max_tokens", usage };
      return { text: "done", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    // maxTokens is ignored: Claude's family metadata resolves a 128K output ceiling.
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, maxTokens: 100, maxTokensUnlimited: true });

    const events = await collectEvents(session.send("write something huge"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(events.some((e) =>
      e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("Already at the detected 128000-token model ceiling"),
    )).toBe(true);
  });

  it("uses a live catalog ceiling in preference to family metadata", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { text: "cut off", stopReason: "max_tokens", usage }
      : { text: "done", stopReason: "end_turn", usage });
    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      maxOutputTokens: 96_000,
      maxTokensUnlimited: true,
    });

    const events = await collectEvents(session.send("write something huge"));
    expect(events.some((e) =>
      e.type === "execution_diagnostic" && e.message.includes("detected 96000-token model ceiling"),
    )).toBe(true);
  });

  it("learns and checkpoints a lower provider-reported ceiling for the exact model", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { throwError: "maximum tokens you requested exceeds the model limit of 96000" }
      : { text: "done", stopReason: "end_turn", usage });
    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      maxOutputTokens: 128_000,
      maxTokensUnlimited: true,
    });

    const events = await collectEvents(session.send("write something huge"));
    expect(events.some((e) =>
      e.type === "execution_diagnostic" && e.message.includes("reported a 96000-token output ceiling"),
    )).toBe(true);
    expect(session.exportState().learnedOutputCeilings).toEqual({
      "anthropic:claude-sonnet-4-6": 96_000,
    });
  });

  it("keeps learned limits model-scoped across repeated conversation model switches", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { text: "cut off", stopReason: "max_tokens", usage }
      : { text: "done", stopReason: "end_turn", usage });
    const { session } = createSession({
      provider: "openai",
      model: "gpt-5",
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      maxTokensUnlimited: true,
      providerTurnSessionFactory: () => scripted,
    });
    session.restoreState({
      messages: [],
      activeProvider: "anthropic",
      activeModel: "claude-sonnet-4-6",
      contextLength: 1_000_000,
      learnedContextLengths: { "anthropic:claude-sonnet-4-6": 900_000 },
      learnedOutputCeilings: {
        "anthropic:claude-sonnet-4-6": 96_000,
        "openai:gpt-5": 90_000,
      },
    });

    expect(session.runtimeState.contextLength).toBe(400_000);
    const events = await collectEvents(session.send("continue after switching back"));
    expect(events.some((e) =>
      e.type === "execution_diagnostic" && e.message.includes("detected 90000-token model ceiling"),
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
