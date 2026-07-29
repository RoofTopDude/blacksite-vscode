import { describe, expect, it, vi } from "vitest";
import { AgentSession, resolveAnthropicBetaExtras, UNSHEDDABLE_TOOL_NAMES, type AgentEvent } from "../../src/agent-session.js";
import type { ToolResultBlock, ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";

/**
 * The question_card round trip: an answer the user gives must reach the model, and must keep
 * reaching it for the rest of the session. Both halves have failed in practice — the answer
 * never arriving, and the answer arriving and then being swept out of context later — and both
 * look identical from the user's seat ("the agent ignored what I told it").
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
  return new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as unknown as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: createFakeContext() as unknown as ConstructorParameters<typeof AgentSession>[0]["context"],
    provider: "anthropic",
    maxIterations: 8,
    checkpointingEnabled: false,
    ...overrides,
  });
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

const askCall: ToolUseBlock = {
  type: "tool_use",
  id: "qc-1",
  name: "question_card",
  input: {
    questions: [
      {
        question: "Which storage backend?",
        options: [
          { key: "sqlite", label: "SQLite" },
          { key: "postgres", label: "Postgres" },
        ],
      },
    ],
  },
};

function resultText(batches: ToolResultBlock[][], toolCallId: string): string {
  for (const batch of batches) {
    for (const block of batch) {
      if (block.tool_use_id === toolCallId) return String(block.content ?? "");
    }
  }
  return "";
}

describe("question_card — answers reach the model", () => {
  it("puts the selected keys and labels in the tool result the model reads", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) =>
      turnIndex === 0 ? { toolCalls: [askCall], stopReason: "tool_use", usage } : { text: "Done.", stopReason: "end_turn", usage };
    const scripted = new ScriptedProviderSession(turnFactory);
    const session = createSession({
      providerTurnSessionFactory: () => scripted,
      questionCardProvider: async () => [["postgres"]],
    });

    const events = await collectEvents(session.send("pick a backend"));

    const content = resultText(scripted.toolResults, "qc-1");
    expect(content).toContain("postgres");
    expect(content).toContain("Postgres");
    expect(content).toContain("Which storage backend?");
    expect(events.some((e) => e.type === "question_card_result")).toBe(true);
  });

  it("records a decline distinguishably rather than as a silent empty answer", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) =>
      turnIndex === 0 ? { toolCalls: [askCall], stopReason: "tool_use", usage } : { text: "Done.", stopReason: "end_turn", usage };
    const scripted = new ScriptedProviderSession(turnFactory);
    const session = createSession({
      providerTurnSessionFactory: () => scripted,
      questionCardProvider: async () => [[]],
    });

    await collectEvents(session.send("pick a backend"));

    const parsed = JSON.parse(resultText(scripted.toolResults, "qc-1")) as {
      ok: boolean; answers: Array<{ selectedKeys: string[]; selectedLabels: string[] }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.answers[0]!.selectedKeys).toEqual([]);
    expect(parsed.answers[0]!.selectedLabels).toEqual([]);
  });

  it("surfaces a cancelled question as an error rather than a fabricated answer", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) =>
      turnIndex === 0 ? { toolCalls: [askCall], stopReason: "tool_use", usage } : { text: "Done.", stopReason: "end_turn", usage };
    const scripted = new ScriptedProviderSession(turnFactory);
    const session = createSession({
      providerTurnSessionFactory: () => scripted,
      questionCardProvider: async () => { throw new Error("Cancelled."); },
    });

    await collectEvents(session.send("pick a backend"));

    const parsed = JSON.parse(resultText(scripted.toolResults, "qc-1")) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ancelled");
  });
});

describe("question_card — answers survive context shedding", () => {
  it("excludes question_card from server-side context editing on Anthropic and Mantle", () => {
    for (const isMantle of [false, true]) {
      const extras = resolveAnthropicBetaExtras("claude-sonnet-5", { contextEditingEnabled: true }, isMantle);
      const edits = (extras.bodyExtras["context_management"] as { edits: Array<Record<string, unknown>> }).edits;
      const clear = edits.find((edit) => edit["type"] === "clear_tool_uses_20250919");
      expect(clear).toBeDefined();
      expect(clear!["exclude_tools"]).toEqual([...UNSHEDDABLE_TOOL_NAMES]);
      expect(UNSHEDDABLE_TOOL_NAMES).toContain("question_card");
    }
  });

  it("never stubs a question_card result during emergency truncation", () => {
    const bigAnswer = {
      ok: true,
      answers: [{
        question: "Which storage backend?",
        selectedKeys: ["postgres"],
        selectedLabels: ["Postgres"],
        rationale: "x".repeat(4000),
      }],
    };
    // A transcript holding one oversized question_card result and one oversized ordinary
    // result, both old enough to shed. Only the reproducible one may be sacrificed: re-running
    // file_read costs a tool call, "re-running" question_card costs the user another interruption.
    const internals = createSession() as unknown as {
      messages: Array<{ role: string; content: unknown }>;
      _emergencyTruncateOldestToolResults(target: number): number;
    };
    internals.messages = [
      { role: "user", content: "start" },
      { role: "assistant", content: [
        { type: "tool_use", id: "qc-1", name: "question_card", input: {} },
        { type: "tool_use", id: "fr-1", name: "file_read", input: { path: "a.ts" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "qc-1", content: JSON.stringify(bigAnswer) },
        { type: "tool_result", tool_use_id: "fr-1", content: "y".repeat(4000) },
      ] },
      ...Array.from({ length: 40 }, () => ({ role: "user", content: "filler" })),
    ];

    const freed = internals._emergencyTruncateOldestToolResults(1_000);
    expect(freed).toBeGreaterThan(0);

    const blocks = internals.messages[2]!.content as Array<{ tool_use_id: string; content: string }>;
    const answer = blocks.find((block) => block.tool_use_id === "qc-1")!;
    const fileRead = blocks.find((block) => block.tool_use_id === "fr-1")!;

    expect(answer.content).toContain("Postgres");
    expect(answer.content).not.toContain("_elided");
    // The reproducible payload is the one that got shed.
    expect(fileRead.content).toContain("_elided");
    expect(fileRead.content).not.toContain("yyyy");
  });
});
