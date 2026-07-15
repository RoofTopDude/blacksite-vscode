/**
 * Coverage for the OpenAI service-tier graceful fallback in `_streamTurnOpenAI`: a non-default
 * tier (flex/priority) that turns out unavailable — either because capacity is momentarily out
 * (429) or the selected model doesn't support that tier at all (400, which OpenAI reports by
 * naming the `service_tier` param in the error body) — must retry the same turn once at the
 * account-default tier instead of failing the run over a cost/latency preference. Flex/Priority
 * availability is model-limited and changes over time, so this also guards against a stale
 * assumption about which models support a tier turning into a hard failure.
 *
 * Drives a real AgentSession over a mocked OpenAI wire (matching the existing Bedrock
 * mid-stream-retry coverage's approach) so this pins actual behaviour, not a classifier in
 * isolation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { OpenAIServiceTier } from "../../src/agent-session.js";

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

function createOpenAISession(serviceTier?: OpenAIServiceTier) {
  return new AgentSession({
    apiKey: "test-key",
    model: "gpt-4o-mini",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
    context: createFakeContext() as never,
    provider: "openai",
    serviceTier,
    maxIterations: 5,
    checkpointingEnabled: false,
    // maxAttempts: 1 isolates the NEW tier-fallback logic under test from _fetchWithRetry's own
    // internal backoff/retry cycle (already covered by provider-retry.spec.ts) — each fetch call
    // below maps 1:1 to a _fetchWithRetry cycle instead of being retried internally first.
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

async function collect(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

function assistantText(session: AgentSession): string {
  const assistant = [...session.history].reverse().find((m) => m.role === "assistant");
  if (!assistant) return "";
  if (typeof assistant.content === "string") return assistant.content;
  return (assistant.content as Array<{ type: string; text?: string }>)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function diagnosticMessages(events: AgentEvent[]): string[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "execution_diagnostic" }> => e.type === "execution_diagnostic")
    .map((e) => e.message);
}

/** A minimal OpenAI chat-completions SSE stream that answers with `text`. */
function sseSuccessStream(text: string): ReadableStream<Uint8Array> {
  const lines = [
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  ];
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

function successResponse(text: string) {
  return { ok: true, status: 200, headers: { get: () => null }, body: sseSuccessStream(text) };
}

function failureResponse(status: number, errorText = "") {
  return { ok: false, status, headers: { get: () => null }, body: { cancel: () => Promise.resolve() }, text: async () => errorText };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

describe("OpenAI service-tier graceful fallback", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("retries at the standard tier when flex capacity is unavailable (429)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failureResponse(429))
      .mockResolvedValueOnce(successResponse("done"));
    vi.stubGlobal("fetch", fetchMock);

    const session = createOpenAISession("flex");
    const events = await collect(session, "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0)["service_tier"]).toBe("flex");
    expect(requestBody(fetchMock, 1)["service_tier"]).toBeUndefined();

    const complete = events.filter((e) => e.type === "turn_complete").at(-1);
    expect(complete).toMatchObject({ stopReason: "end_turn" });
    expect(assistantText(session)).toBe("done");
    expect(diagnosticMessages(events).some((m) => /flex.*unavailable/i.test(m) && /standard tier/i.test(m))).toBe(true);
  });

  it("retries at the standard tier when priority capacity is unavailable (429)", async () => {
    // The fallback is not flex-specific — any non-auto tier hitting a persistent 429 should
    // degrade gracefully rather than fail the turn over a latency preference.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failureResponse(429))
      .mockResolvedValueOnce(successResponse("done"));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(createOpenAISession("priority"), "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 1)["service_tier"]).toBeUndefined();
    expect(events.filter((e) => e.type === "turn_complete").at(-1)).toMatchObject({ stopReason: "end_turn" });
    expect(diagnosticMessages(events).some((m) => /priority.*unavailable/i.test(m))).toBe(true);
  });

  it("retries at the standard tier when the model doesn't support the requested tier (400)", async () => {
    const errorBody = JSON.stringify({
      error: {
        message: "The model `gpt-4o-mini` does not support the `service_tier` parameter with value `flex`.",
        type: "invalid_request_error",
        param: "service_tier",
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failureResponse(400, errorBody))
      .mockResolvedValueOnce(successResponse("done"));
    vi.stubGlobal("fetch", fetchMock);

    const session = createOpenAISession("flex");
    const events = await collect(session, "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 1)["service_tier"]).toBeUndefined();
    expect(events.filter((e) => e.type === "turn_complete").at(-1)).toMatchObject({ stopReason: "end_turn" });
    expect(assistantText(session)).toBe("done");
    expect(diagnosticMessages(events).some((m) => /doesn't support/i.test(m) && /flex/i.test(m))).toBe(true);
  });

  it("does not retry a 400 unrelated to the service tier — replaying a broken request cannot fix it", async () => {
    const errorBody = JSON.stringify({
      error: { message: "Invalid value for 'tool_choice'.", type: "invalid_request_error", param: "tool_choice" },
    });
    const fetchMock = vi.fn().mockResolvedValue(failureResponse(400, errorBody));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(createOpenAISession("flex"), "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "turn_complete").at(-1)).toMatchObject({ stopReason: "error" });
  });

  it("applies no tier fallback at all when no explicit tier was requested", async () => {
    // With serviceTier unset (account default / "auto"), a 429 is just a plain failure —
    // the fallback branch must never fire for a request that never asked for a special tier.
    const fetchMock = vi.fn().mockResolvedValue(failureResponse(429));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(createOpenAISession(undefined), "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "turn_complete").at(-1)).toMatchObject({ stopReason: "error" });
    // Other, unrelated diagnostics (context-window-unknown notice, the terminal failure
    // message) are expected here — only a tier-fallback notice specifically must never fire.
    expect(diagnosticMessages(events).some((m) => /tier/i.test(m))).toBe(false);
  });
});
