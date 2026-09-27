/**
 * Strict role alternation on the wire.
 *
 * Bedrock Converse rejects two consecutive same-role messages, and the loop has several legitimate
 * ways to produce a user message right after another one: a harness continuation appended after a
 * tool-result turn, a retry prompt appended after reverting a truncated turn, and any message sent
 * after a run whose last recorded turn was a tool result (iteration limit, cancel, error, checkpoint
 * resume). Because the history keeps that shape, one rejected request used to strand the session.
 *
 * The other suites drive the loop through ScriptedProviderSession, whose appendUserText never
 * touches the real transcript — which is how this went unnoticed. These tests drive a real
 * Converse session over a mocked wire and check every request body that actually left.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";
import { mergeAdjacentUserMessages, normalizeForProvider } from "../../src/agent/transcript-hygiene.js";
import { eventFrame, streamFromChunks, successStream } from "./helpers/bedrock-frames.js";

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

function createBedrockSession(maxIterations = 8) {
  return new AgentSession({
    apiKey: "unused-on-bedrock",
    model: "anthropic.claude-sonnet-4-6-v1:0",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, content: "same" } })) } as never,
    context: createFakeContext() as never,
    provider: "bedrock",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
    maxIterations,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

const usageFrame = eventFrame("metadata", { usage: { inputTokens: 10, outputTokens: 5 } });

function toolRoundStream(id: string, name: string, input: string, stopReason = "tool_use") {
  return streamFromChunks([
    eventFrame("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: id, name } } }),
    ...(input ? [eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input } } })] : []),
    eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
    eventFrame("messageStop", { stopReason }),
    usageFrame,
  ]);
}

function requestRoles(call: unknown[]): string[] {
  const body = JSON.parse(String((call[1] as RequestInit).body)) as { messages: Array<{ role: string }> };
  return body.messages.map((message) => message.role);
}

function expectStrictAlternation(fetchMock: ReturnType<typeof vi.fn>): void {
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  for (const call of fetchMock.mock.calls) {
    const roles = requestRoles(call);
    expect(roles[0]).toBe("user");
    roles.forEach((role, index) => {
      if (index > 0) expect(role, `request roles: ${roles.join(" > ")}`).not.toBe(roles[index - 1]);
    });
  }
}

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("mergeAdjacentUserMessages", () => {
  it("folds a text turn into the tool-result turn before it, tool results first", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "file_read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      { role: "user", content: "[Internal progress check]\nstop repeating" },
    ];
    const merged = mergeAdjacentUserMessages(messages);
    expect(merged.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(merged[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "{}" },
      { type: "text", text: "[Internal progress check]\nstop repeating" },
    ]);
  });

  it("keeps tool_result blocks leading even when the text turn came first", () => {
    const merged = mergeAdjacentUserMessages([
      { role: "user", content: [{ type: "text", text: "note" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["tool_result", "text"]);
  });

  it("drops blank string turns rather than emitting an empty text block", () => {
    const merged = mergeAdjacentUserMessages([
      { role: "user", content: "   " },
      { role: "user", content: "real prompt" },
    ]);
    expect(merged).toEqual([{ role: "user", content: [{ type: "text", text: "real prompt" }] }]);
  });

  it("returns an already-alternating transcript unchanged, by reference", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    expect(mergeAdjacentUserMessages(messages)).toBe(messages);
  });

  it("never merges assistant runs", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
    ];
    expect(mergeAdjacentUserMessages(messages)).toBe(messages);
  });

  it("normalizeForProvider merges the tool_result turn it synthesizes for an interrupted call", () => {
    const normalized = normalizeForProvider([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell_run", input: { command: "npm test" } }] },
      { role: "user", content: "actually, stop and explain" },
    ]);
    expect(normalized.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const blocks = normalized[2]!.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text"]);
  });
});

describe("role alternation on the real Bedrock Converse wire", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stays alternating when the duplicate-round progress check follows a tool-result turn", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls <= 3
        ? { ok: true, body: toolRoundStream(`t${calls}`, "file_read", '{"path":"index.html"}') }
        : { ok: true, body: successStream("Done") };
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(createBedrockSession().send("read index.html"));

    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.includes("identical tool rounds"))).toBe(true);
    expectStrictAlternation(fetchMock);
  });

  it("stays alternating when a truncated tool call is reverted and retried", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, body: toolRoundStream("w1", "file_write", "", "max_tokens") }
        : { ok: true, body: successStream("Done") };
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(createBedrockSession().send("write a big file"));

    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.includes("Truncated tool call"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectStrictAlternation(fetchMock);
  });

  it("stays alternating when a run is resumed after a checkpoint that ended on tool results", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, body: successStream("Resumed") }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createBedrockSession();
    session.restoreState({
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "file_read", input: { path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" }] },
      ],
    } as never);

    await drain(session.send("[Resumed from checkpoint]", { preserveRequestMode: true }));

    expectStrictAlternation(fetchMock);
  });

  it("stays alternating for the next message after a run that stopped at the iteration limit", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ ok: true, body: toolRoundStream("t1", "file_read", '{"path":"a.ts"}') }))
      .mockImplementation(async () => ({ ok: true, body: successStream("Continuing") }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createBedrockSession(1);

    const first = await drain(session.send("long task"));
    expect(first.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "max_iterations" });

    await drain(session.send("continue"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectStrictAlternation(fetchMock);
  });

  it("stays alternating for the next message after a run cancelled mid-tool", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, body: successStream("Explained") }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createBedrockSession();
    session.restoreState({
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell_run", input: { command: "npm test" } }] },
      ],
    } as never);

    await drain(session.send("actually, stop and explain"));

    expectStrictAlternation(fetchMock);
  });
});
