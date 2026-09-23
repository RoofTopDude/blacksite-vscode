import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  appendOpenAIWorkspaceContextTail,
  hasOpenRouterToolTailAnchor,
  openRouterAnchorsToolResults,
  openRouterSupportsCacheControl,
  withOpenRouterCacheControl,
  toOpenAIMessages,
  type AgentEvent,
  type AgentSessionOptions,
} from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";
import { responsesSseStream } from "./helpers/responses-api-sse.js";

type Part = { type: string; text?: string; cache_control?: { type: string } };

const partsOf = (content: unknown): Part[] => content as Part[];

describe("openRouterSupportsCacheControl", () => {
  it("matches Anthropic and Gemini model ids", () => {
    expect(openRouterSupportsCacheControl("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(openRouterSupportsCacheControl("google/gemini-2.5-pro")).toBe(true);
    expect(openRouterSupportsCacheControl("claude-3-5-haiku")).toBe(true);
  });

  it("rejects models whose providers ignore or auto-handle caching", () => {
    expect(openRouterSupportsCacheControl("openai/gpt-4o")).toBe(false);
    expect(openRouterSupportsCacheControl("meta-llama/llama-3.3-70b-instruct")).toBe(false);
    expect(openRouterSupportsCacheControl("mistralai/mistral-large")).toBe(false);
    // "google" alone must not qualify — Gemma has no cache_control support.
    expect(openRouterSupportsCacheControl("google/gemma-3-27b-it")).toBe(false);
  });
});

describe("appendOpenAIWorkspaceContextTail", () => {
  it("appends the volatile block as a separate trailing user message, past any breakpoints", () => {
    const msgs = withOpenRouterCacheControl(toOpenAIMessages([{ role: "user", content: "task" }], "sys"));
    const out = appendOpenAIWorkspaceContextTail(msgs, "WORKSPACE STATE");
    const last = out[out.length - 1]!;
    expect(last).toEqual({ role: "user", content: "WORKSPACE STATE" });
    // The rolling breakpoint stays on the stable history message, NOT the volatile tail —
    // a breakpoint on per-turn content would cache-write the whole body every request
    // and never get a read hit.
    const marked = out[out.length - 2]!;
    expect((marked.content as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op for empty context or empty history", () => {
    const msgs = toOpenAIMessages([{ role: "user", content: "task" }], "sys");
    expect(appendOpenAIWorkspaceContextTail(msgs, "   ")).toBe(msgs);
    expect(appendOpenAIWorkspaceContextTail([], "ctx")).toEqual([]);
  });
});

describe("withOpenRouterCacheControl", () => {
  const build = (messages: AgentMessage[]) => toOpenAIMessages(messages, "sys prompt");

  it("marks the system message and the last user message with breakpoints", () => {
    const out = withOpenRouterCacheControl(build([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]));

    const system = out.find((m) => m.role === "system")!;
    expect(partsOf(system.content)[0]).toMatchObject({ type: "text", text: "sys prompt", cache_control: { type: "ephemeral" } });

    const users = out.filter((m) => m.role === "user");
    // Only the LAST user message carries the rolling breakpoint.
    expect(users[0]!.content).toBe("first");
    expect(partsOf(users[1]!.content)[0]).toMatchObject({ text: "second", cache_control: { type: "ephemeral" } });
  });

  it("marks the last text part of an already-multipart user message, not image parts", () => {
    const out = withOpenRouterCacheControl([
      { role: "system", content: "s" },
      { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
      ] },
    ]);
    const parts = partsOf(out[1]!.content);
    expect(parts[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(parts[1]).not.toHaveProperty("cache_control");
  });

  it("leaves tool-role messages untouched even when they are last", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "file_read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "data" }] },
    ];
    const out = withOpenRouterCacheControl(build(messages));
    const toolMsg = out.find((m) => m.role === "tool")!;
    expect(typeof toolMsg.content).toBe("string");
    // The rolling breakpoint falls back to the last real user message.
    const userMsg = out.find((m) => m.role === "user")!;
    expect(partsOf(userMsg.content)[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("never mutates the input messages", () => {
    const input = build([{ role: "user", content: "hello" }]);
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    withOpenRouterCacheControl(input);
    expect(input).toEqual(snapshot);
  });

  /* Inside an agent loop the last user message is the prompt that started the turn, so every tool
     round after it was re-billed at full price on every iteration. */
  it("anchors a trailing tool result as well when asked, keeping the user anchor", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "file_read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "data" }] },
    ];
    const input = build(messages);
    const out = withOpenRouterCacheControl(input, "1h", { anchorToolTail: true });

    const tail = out[out.length - 1]!;
    expect(tail.role).toBe("tool");
    expect(partsOf(tail.content)).toEqual([{ type: "text", text: "data", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(partsOf(out.find((m) => m.role === "user")!.content)[0]!.cache_control).toBeDefined();
    expect(hasOpenRouterToolTailAnchor(out)).toBe(true);
    expect(hasOpenRouterToolTailAnchor(input)).toBe(false);
  });

  it("does not anchor an empty tool result or a tool message that is not last", () => {
    const empty = withOpenRouterCacheControl([
      { role: "system", content: "s" },
      { role: "user", content: "go" },
      { role: "tool", content: "", tool_call_id: "c1" },
    ], undefined, { anchorToolTail: true });
    expect(empty[2]!.content).toBe("");

    const notLast = withOpenRouterCacheControl([
      { role: "system", content: "s" },
      { role: "tool", content: "data", tool_call_id: "c1" },
      { role: "user", content: "next" },
    ], undefined, { anchorToolTail: true });
    expect(notLast[1]!.content).toBe("data");
  });
});

describe("openRouterAnchorsToolResults", () => {
  it("is Claude-only: Gemini uses just its last breakpoint, so moving it would re-mint a cache each round", () => {
    expect(openRouterAnchorsToolResults("anthropic/claude-sonnet-5")).toBe(true);
    expect(openRouterAnchorsToolResults("google/gemini-2.5-pro")).toBe(false);
    expect(openRouterAnchorsToolResults("openai/gpt-5.6")).toBe(false);
  });
});

// ── The live probe, through a real session turn ───────────────────────────────

function chatStream(events: Array<Record<string, unknown>>) {
  return { ok: true, status: 200, headers: { get: () => null }, body: responsesSseStream(events) };
}
const toolCallTurn = () => chatStream([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "file_list", arguments: "{\"path\":\".\"}" } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);
const answerTurn = () => chatStream([
  { choices: [{ delta: { content: "done" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);

function openRouterSession(model: string) {
  return new AgentSession({
    provider: "openrouter", model, apiKey: "test", systemPrompt: "Test", workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, files: ["a.txt"] } })) },
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    maxIterations: 4, checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  } as unknown as AgentSessionOptions);
}

async function run(session: AgentSession, prompt = "List files"): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

const sentMessages = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
  JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)).messages as Parameters<typeof hasOpenRouterToolTailAnchor>[0];

describe("OpenRouter tool-result cache anchor on the wire", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("anchors the tool result the follow-up request ends on, for a Claude model", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(toolCallTurn()).mockResolvedValueOnce(answerTurn());
    vi.stubGlobal("fetch", fetchMock);
    await run(openRouterSession("anthropic/claude-sonnet-5"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasOpenRouterToolTailAnchor(sentMessages(fetchMock, 1))).toBe(true);
  });

  it("withdraws the anchor for the session when OpenRouter rejects it, and only then", async () => {
    const rejection = { ok: false, status: 400, headers: { get: () => null }, text: async () => "{\"error\":{\"message\":\"Invalid tool message content\"}}" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolCallTurn())
      .mockResolvedValueOnce(rejection)
      .mockResolvedValueOnce(answerTurn())
      .mockResolvedValueOnce(toolCallTurn())
      .mockResolvedValueOnce(answerTurn());
    vi.stubGlobal("fetch", fetchMock);
    const session = openRouterSession("anthropic/claude-sonnet-5");

    const first = await run(session);
    expect(hasOpenRouterToolTailAnchor(sentMessages(fetchMock, 1))).toBe(true);
    expect(hasOpenRouterToolTailAnchor(sentMessages(fetchMock, 2))).toBe(false);
    expect(first.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });

    await run(session, "Again");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(hasOpenRouterToolTailAnchor(sentMessages(fetchMock, 4))).toBe(false);
  });

  it("surfaces an unrelated 400 as its own error instead of blaming the anchor", async () => {
    const unrelated = () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => "context_length_exceeded" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolCallTurn())
      .mockResolvedValueOnce(unrelated())
      .mockResolvedValueOnce(unrelated());
    vi.stubGlobal("fetch", fetchMock);
    const events = await run(openRouterSession("anthropic/claude-sonnet-5"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(events)).toContain("context_length_exceeded");
  });

  it("never anchors tool results for Gemini", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(toolCallTurn()).mockResolvedValueOnce(answerTurn());
    vi.stubGlobal("fetch", fetchMock);
    await run(openRouterSession("google/gemini-2.5-pro"));
    expect(hasOpenRouterToolTailAnchor(sentMessages(fetchMock, 1))).toBe(false);
  });
});
