/**
 * End-to-end coverage for the OpenAI Responses API path, driven over a mocked wire — same
 * rationale as agent-session.compaction.spec.ts: the risk that matters is whether a reasoning
 * item's encrypted_content actually survives being recorded into history and gets replayed on
 * the follow-up request after a tool call, not just whether the request body looks right in
 * isolation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ContentBlock } from "../../src/agent-loop-contract.js";
import { responsesReasoningToolCallTurn, responsesTextTurn } from "./helpers/responses-api-sse.js";

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

function createResponsesSession(useResponsesApi = true) {
  return new AgentSession({
    apiKey: "test-key",
    model: "o3",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, files: ["a.txt"] } })) } as never,
    context: createFakeContext() as never,
    provider: "openai",
    maxIterations: 5,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    useResponsesApi,
  } as never);
}

async function collect(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

function assistantTurns(session: AgentSession): ContentBlock[][] {
  return session.history
    .filter((m) => m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? [] : (m.content as ContentBlock[])));
}

describe("OpenAI Responses API — dispatch and round trip", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("routes to /v1/responses (not /v1/chat/completions) when useResponsesApi is on for a reasoning model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: responsesReasoningToolCallTurn({
          reasoningId: "rs_1", summaryText: "I should list files", encryptedContent: "enc_abc",
          callId: "call_1", toolName: "file_list", toolArgs: { path: "." },
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: responsesTextTurn("Found a.txt") });
    vi.stubGlobal("fetch", fetchMock);

    await collect(createResponsesSession(), "list files");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(firstUrl)).toContain("/v1/responses");
    expect(String(firstUrl)).not.toContain("/v1/chat/completions");
  });

  it("does NOT route to Responses when the toggle is off — falls through to Chat Completions unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, text: async () => "not used" });
    vi.stubGlobal("fetch", fetchMock);

    // Chat Completions will 404 in this test (we didn't mock its shape) — we only care which
    // URL it attempted, proving the dispatch gate is off.
    await collect(createResponsesSession(false), "hello").catch(() => { /* expected to fail — wrong mock shape */ });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/v1/chat/completions");
  });

  it("records the reasoning block ahead of the tool_use block, carrying encryptedContent + reasoningItemId", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: responsesReasoningToolCallTurn({
          reasoningId: "rs_1", summaryText: "Let me check the files", encryptedContent: "enc_xyz",
          callId: "call_1", toolName: "file_list", toolArgs: { path: "." },
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: responsesTextTurn("Done") });
    vi.stubGlobal("fetch", fetchMock);

    const session = createResponsesSession();
    await collect(session, "list files");

    const [firstTurn] = assistantTurns(session);
    expect(firstTurn![0]).toMatchObject({
      type: "thinking",
      thinking: "Let me check the files",
      encryptedContent: "enc_xyz",
      reasoningItemId: "rs_1",
    });
    expect(firstTurn![0]).not.toHaveProperty("signature");
    expect(firstTurn![1]).toMatchObject({ type: "tool_use", id: "call_1", name: "file_list", input: { path: "." } });
  });

  it("replays the reasoning item's encrypted_content verbatim on the follow-up request after the tool result", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: responsesReasoningToolCallTurn({
          reasoningId: "rs_1", summaryText: "Checking files", encryptedContent: "enc_verbatim_123",
          callId: "call_1", toolName: "file_list", toolArgs: {},
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: responsesTextTurn("Found the files") });
    vi.stubGlobal("fetch", fetchMock);

    await collect(createResponsesSession(), "list files");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondInit.body)) as { input: Array<Record<string, unknown>> };
    const reasoningItem = secondBody.input.find((i) => i["type"] === "reasoning");
    expect(reasoningItem).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Checking files" }],
      encrypted_content: "enc_verbatim_123",
    });
    // The reasoning item must precede the function_call it informed, in the replayed input.
    const reasoningIdx = secondBody.input.findIndex((i) => i["type"] === "reasoning");
    const callIdx = secondBody.input.findIndex((i) => i["type"] === "function_call");
    expect(reasoningIdx).toBeLessThan(callIdx);
    // And the tool result is present as a standalone function_call_output, matched by call_id.
    expect(secondBody.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1" }));
  });

  it("sends include:[reasoning.encrypted_content] and store:false on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, body: responsesTextTurn("hi") });
    vi.stubGlobal("fetch", fetchMock);

    await collect(createResponsesSession(), "hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["store"]).toBe(false);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["input"]).toBeDefined();
    expect(body["messages"]).toBeUndefined(); // Responses uses "input", never Chat Completions' "messages"
  });

  it("splits cached tokens out of the usage_update's inputTokens field, matching the Anthropic/Chat-Completions convention", async () => {
    // This is a wire-format assertion, not a runtime-state one: _recordUsage adds
    // cacheReadTokens straight back onto inputTokens to get the *total* context-window
    // consumption for the percentage meter (lastInputTokens = input + cacheRead + cacheWrite —
    // see agent-session.compaction.spec.ts's iterations-summing test for the same total-not-
    // remainder shape). The thing actually worth pinning here is that the *category split*
    // itself is correct — inputTokens excludes what cacheReadTokens separately reports —
    // which the session_runtime sum can't distinguish from "split wrong" (1000) vs "split
    // right and re-summed" (700+300=1000 either way). Assert on the emitted event directly.
    const session = createResponsesSession();
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: responsesReasoningToolCallTurn({
        reasoningId: "rs_1", summaryText: "x", encryptedContent: "enc",
        callId: "call_1", toolName: "noop", toolArgs: {},
        inputTokens: 1000, outputTokens: 50, cachedTokens: 300,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(session, "hello");
    const usageEvent = events.find((e): e is Extract<AgentEvent, { type: "usage_update" }> => e.type === "usage_update");
    expect(usageEvent).toMatchObject({ inputTokens: 700, cacheReadTokens: 300, outputTokens: 50 });

    // And _recordUsage's own total (input + cacheRead + cacheWrite) correctly reconstitutes
    // the full 1000 for the context-window meter — proving the split didn't lose anything.
    const runtimeEvents = events.filter((e): e is Extract<AgentEvent, { type: "runtime_state" }> => e.type === "runtime_state");
    expect(runtimeEvents.at(-1)?.state.lastInputTokens).toBe(1000);
  });
});
