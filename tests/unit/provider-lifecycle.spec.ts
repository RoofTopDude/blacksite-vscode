import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type AgentSessionOptions } from "../../src/agent-session.js";
import { eventFrame, streamFromChunks } from "./helpers/bedrock-frames.js";
import { responsesSseStream } from "./helpers/responses-api-sse.js";

// Exercise every advertised transport through the real session and mocked wire.
const transports = [
  { name: "Anthropic", provider: "anthropic", model: "claude-sonnet-4-6", wire: "anthropic" },
  { name: "Bedrock Converse", provider: "bedrock", model: "anthropic.claude-sonnet-4-6-v1:0", wire: "bedrock" },
  { name: "Bedrock Mantle", provider: "bedrock", model: "claude-sonnet-4-6", bedrockApi: "mantle", wire: "anthropic" },
  { name: "OpenAI Chat", provider: "openai", model: "gpt-4.1", wire: "chat" },
  { name: "OpenAI Responses", provider: "openai", model: "o3", useResponsesApi: true, wire: "responses" },
  { name: "OpenRouter", provider: "openrouter", model: "anthropic/claude-sonnet-4.6", wire: "chat" },
] as const;

type Transport = typeof transports[number];

function response(wire: Transport["wire"], opts: { tool?: boolean; incomplete?: boolean } = {}) {
  const text = opts.incomplete ? "Partial answer" : "Complete answer";
  const input = JSON.stringify({ path: "." });
  let events: Array<Record<string, unknown>>;
  if (wire === "bedrock") {
    const frames = opts.tool ? [
      eventFrame("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call_1", name: "file_list" } } }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input } } }),
    ] : [eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text } })];
    if (!opts.incomplete) frames.push(
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      eventFrame("messageStop", { stopReason: opts.tool ? "tool_use" : "end_turn" }),
      eventFrame("metadata", { usage: { inputTokens: 10, outputTokens: 5 } }),
    );
    return { ok: true, body: streamFromChunks(frames) };
  }
  if (wire === "anthropic") {
    events = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: opts.tool ? { type: "tool_use", id: "call_1", name: "file_list", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: opts.tool ? { type: "input_json_delta", partial_json: input } : { type: "text_delta", text } },
    ];
    if (!opts.incomplete) events.push(
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: opts.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    );
  } else if (wire === "chat") {
    events = [{ choices: [{ delta: opts.tool ? { tool_calls: [{ index: 0, id: "call_1", function: { name: "file_list", arguments: input } }] } : { content: text } }] }];
    if (!opts.incomplete) events.push({ choices: [{ delta: {}, finish_reason: opts.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  } else {
    const item = opts.tool ? { type: "function_call", call_id: "call_1", name: "file_list", arguments: input } : { type: "message", content: [{ type: "output_text", text }] };
    events = opts.tool ? [
      { type: "response.output_item.added", item },
      { type: "response.output_item.done", item },
    ] : [{ type: "response.output_text.delta", delta: text }];
    if (!opts.incomplete) events.push({ type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5 } } });
  }
  return { ok: true, body: responsesSseStream(events) };
}

function sessionFor(transport: Transport) {
  const handleMessage = vi.fn(async () => ({ result: { ok: true, files: ["a.txt"] } }));
  const session = new AgentSession({
    ...transport,
    apiKey: "test", systemPrompt: "Test", workspaceRoot: "C:/workspace",
    bedrock: { region: "us-east-1", accessKeyId: "test", secretAccessKey: "test" },
    runtime: { handleMessage },
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    maxIterations: 3, checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  } as unknown as AgentSessionOptions);
  return { session, handleMessage };
}

async function collect(session: AgentSession) {
  const events: AgentEvent[] = [];
  for await (const event of session.send("List files")) events.push(event);
  return events;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.each(transports)("$name lifecycle", (transport) => {
  it("shows provider activity and completes a tool round trip with usage", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(transport.wire, { tool: true }))
      .mockResolvedValueOnce(response(transport.wire));
    vi.stubGlobal("fetch", fetch);
    const { session, handleMessage } = sessionFor(transport);
    const events = await collect(session);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "provider_activity", phase: "waiting" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "provider_activity", phase: "tool_input" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "provider_activity", phase: "responding" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "usage_update", outputTokens: 5 }));
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
    const followup = JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body));
    expect(JSON.stringify(followup)).toContain("call_1");
    expect(JSON.stringify(followup)).toContain("a.txt");
  });

  it("retries premature EOF and commits only the completed answer", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(transport.wire, { incomplete: true }))
      .mockResolvedValueOnce(response(transport.wire));
    vi.stubGlobal("fetch", fetch);
    const { session, handleMessage } = sessionFor(transport);
    const events = await collect(session);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_reset" }));
    expect(JSON.stringify(session.history)).not.toContain("Partial answer");
    expect(JSON.stringify(session.history)).toContain("Complete answer");
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("bounds the first-byte wait and releases the stalled reader before retrying", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: stalled })
      .mockResolvedValueOnce(response(transport.wire));
    vi.stubGlobal("fetch", fetch);
    const { session } = sessionFor(transport);
    const pending = collect(session);
    await vi.advanceTimersByTimeAsync(300_001);
    const events = await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stalled.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("reports an authentication failure without retrying or leaving provider activity running", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const { session } = sessionFor(transport);
    const events = await collect(session);
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "provider_activity").at(-1)).toMatchObject({ phase: "idle" });
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "error" });
  });

  it("stops a pending request on cancellation without retrying", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const { session } = sessionFor(transport);
    session.attachSignal(controller.signal);
    const pending = collect(session);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    const events = await pending;
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "provider_activity").at(-1)).toMatchObject({ phase: "idle" });
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "cancelled" });
  });
});
