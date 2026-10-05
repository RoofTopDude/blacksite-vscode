import { describe, expect, it, vi } from "vitest";
import { ChatGptService, type ChatGptOptions, type SubscriptionRequest } from "../../src/chatgpt-service.js";
import type { CodexAppServer, CodexMessage } from "../../src/codex-app-server.js";
import type { AgentMessage, ContentBlock, ProviderTurnStreamEvent } from "../../src/agent-loop-contract.js";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}) }));

type Step = (threadId: string) => void;

/** A scripted Codex app-server. Each step runs when the model is "called": on turn/start, and again
 *  whenever a tool call is answered. It emits the notifications a real server would. */
function server(options?: Partial<ChatGptOptions>) {
  const listeners = new Set<(message: CodexMessage) => void>();
  const emit = (method: string, params: Record<string, unknown>, id?: number) => { for (const l of [...listeners]) l({ method, params, ...(id !== undefined ? { id } : {}) }); };
  const steps: Step[] = [];
  let next = 0;
  let threads = 0;
  let turns = 0;
  let respondFails = false;
  /** Calls the model is waiting on, by thread; the turn continues once every one is answered. */
  const waiting = new Map<string, Set<number | string>>();
  const owner = new Map<number | string, string>();
  const run = (threadId: string) => queueMicrotask(() => steps[next++]?.(threadId));
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "account/read") return { account: { type: "chatgpt", email: "a@example.com", planType: "plus" } };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } } };
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "thread/start") return { thread: { id: `t${++threads}` } };
    if (method === "turn/start") { const threadId = String(_params?.threadId); run(threadId); return { turn: { id: `turn${++turns}` } }; }
    return {};
  });
  const respond = vi.fn((id: number | string, _result: unknown) => {
    if (respondFails) throw new Error("Codex is not connected.");
    const threadId = owner.get(id)!;
    const set = waiting.get(threadId)!;
    set.delete(id);
    if (!set.size) run(threadId);
  });
  const rpc = { request, respond, start: vi.fn(async () => {}), dispose: vi.fn(), subscribe: (l: (m: CodexMessage) => void) => { listeners.add(l); return () => listeners.delete(l); } };
  const settings: ChatGptOptions = { reasoningSummary: "detailed", extendedContext: false, reuseConversation: true, verbosity: "medium", ...options };
  const service = new ChatGptService(rpc as unknown as CodexAppServer, "/isolated", vi.fn(), vi.fn(async () => true), () => settings);

  const usage = (threadId: string, total: { input: number; cached?: number; output: number; reasoning?: number }) =>
    emit("thread/tokenUsage/updated", { threadId, tokenUsage: { total: { totalTokens: total.input + total.output, inputTokens: total.input, cachedInputTokens: total.cached ?? 0, cacheWriteInputTokens: 0, outputTokens: total.output, reasoningOutputTokens: total.reasoning ?? 0 }, modelContextWindow: 258_400 } });
  return {
    service, request, respond, emit, usage,
    steps: (...list: Step[]) => { steps.push(...list); },
    failResponds: () => { respondFails = true; },
    calls: (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>),
    toolCall: (threadId: string, callId: string, tool: string, args: Record<string, unknown>, requestId: number) => {
      owner.set(requestId, threadId);
      waiting.set(threadId, (waiting.get(threadId) ?? new Set()).add(requestId));
      emit("item/tool/call", { threadId, turnId: "turn", callId, namespace: null, tool: `blacksite_${tool}`, arguments: args }, requestId);
    },
    finish: (threadId: string, text: string) => { emit("item/agentMessage/delta", { threadId, delta: text }); emit("turn/completed", { threadId, turn: { status: "completed" } }); },
  };
}

const TOOLS = [{ name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
const request = (messages: AgentMessage[], extra: Partial<SubscriptionRequest> = {}): SubscriptionRequest =>
  ({ model: "test-model", systemPrompt: "System", messages, tools: TOOLS, conversationId: "chat-1", ...extra });
async function collect(stream: AsyncGenerator<ProviderTurnStreamEvent>) {
  const events: ProviderTurnStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const call = (id: string, path = "a.ts"): ContentBlock => ({ type: "tool_use", id, name: "read_file", input: { path } });
const result = (id: string, content = "{\"ok\":true}"): AgentMessage => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] });
const ask = (text: string): AgentMessage => ({ role: "user", content: text });

describe("ChatGPT live conversation thread", () => {
  it("answers a tool call inside the open turn instead of starting a new thread", async () => {
    const s = server();
    s.steps(
      (t) => { s.usage(t, { input: 100, output: 10 }); s.toolCall(t, "c1", "read_file", { path: "a.ts" }, 11); },
      (t) => { s.usage(t, { input: 220, cached: 100, output: 30 }); s.finish(t, "Done."); },
    );
    const first = [ask("Read a.ts")];
    const one = await collect(s.service.stream(request(first)));
    expect(one).toContainEqual({ type: "tool_use_block", block: { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } } });
    expect(one.at(-1)).toEqual({ type: "stop_reason", reason: "tool_use" });
    // The user's own message starts the turn; there is no invented "continue" prompt.
    expect(s.calls("turn/start")[0]!.input).toEqual([{ type: "text", text: "Read a.ts", text_elements: [] }]);
    expect(s.respond).not.toHaveBeenCalled();

    const second = [...first, { role: "assistant" as const, content: [call("c1")] }, result("c1", "{\"ok\":true,\"content\":\"x\"}")];
    const two = await collect(s.service.stream(request(second)));
    expect(s.respond).toHaveBeenCalledWith(11, { contentItems: [{ type: "inputText", text: "{\"ok\":true,\"content\":\"x\"}" }], success: true });
    expect(s.calls("thread/start")).toHaveLength(1);
    expect(s.calls("turn/start")).toHaveLength(1);
    expect(s.calls("thread/inject_items")).toHaveLength(0);
    expect(two.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("Done.");
    expect(two.at(-1)).toEqual({ type: "stop_reason", reason: "end_turn" });
    // Each round reports only what it spent, not the thread's running total.
    expect(one).toContainEqual({ type: "usage_update", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(two).toContainEqual({ type: "usage_update", inputTokens: 20, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  it("reports a failed tool as unsuccessful and passes screenshots back as images", async () => {
    const s = server();
    s.steps((t) => s.toolCall(t, "c1", "read_file", {}, 5), (t) => s.finish(t, "ok"));
    await collect(s.service.stream(request([ask("go")])));
    const done: AgentMessage = { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{\"ok\":false,\"error\":\"nope\"}" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] };
    await collect(s.service.stream(request([ask("go"), { role: "assistant", content: [call("c1")] }, done])));
    expect(s.respond).toHaveBeenCalledWith(5, { contentItems: [{ type: "inputText", text: "{\"ok\":false,\"error\":\"nope\"}" }, { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" }], success: false });
  });

  it("collects tool calls that arrive together into one round", async () => {
    const s = server();
    s.steps((t) => { s.toolCall(t, "c1", "read_file", { path: "a" }, 1); s.toolCall(t, "c2", "read_file", { path: "b" }, 2); }, (t) => s.finish(t, "ok"));
    const one = await collect(s.service.stream(request([ask("both")])));
    expect(one.filter((e) => e.type === "tool_use_block")).toHaveLength(2);
    const history: AgentMessage[] = [ask("both"), { role: "assistant", content: [call("c1", "a"), call("c2", "b")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{}" }, { type: "tool_result", tool_use_id: "c2", content: "{}" }] }];
    await collect(s.service.stream(request(history)));
    expect(s.respond.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it("starts the next user message as a new turn on the same thread", async () => {
    const s = server();
    s.steps((t) => s.finish(t, "First."), (t) => s.finish(t, "Second."));
    const first = [ask("one")];
    await collect(s.service.stream(request(first, { contextTail: "WORKSPACE A" })));
    expect(s.calls("turn/start")[0]!.input).toEqual([{ type: "text", text: "one", text_elements: [] }, { type: "text", text: "WORKSPACE A", text_elements: [] }]);
    const second = [...first, { role: "assistant" as const, content: [{ type: "text" as const, text: "First." }] }, ask("two")];
    await collect(s.service.stream(request(second, { contextTail: "WORKSPACE A" })));
    expect(s.calls("thread/start")).toHaveLength(1);
    // Unchanged workspace state is not sent again: every copy would stay in the thread.
    expect(s.calls("turn/start")[1]!.input).toEqual([{ type: "text", text: "two", text_elements: [] }]);
    const third = [...second, { role: "assistant" as const, content: [{ type: "text" as const, text: "Second." }] }, ask("three")];
    s.steps((t) => s.finish(t, "Third."));
    await collect(s.service.stream(request(third, { contextTail: "WORKSPACE B" })));
    expect(s.calls("turn/start")[2]!.input).toEqual([{ type: "text", text: "three", text_elements: [] }, { type: "text", text: "WORKSPACE B", text_elements: [] }]);
  });

  it.each([
    ["an earlier message was edited", (m: AgentMessage[]) => [ask("EDITED"), ...m.slice(1)], {}],
    ["the user steered alongside the tool result", (m: AgentMessage[]) => [...m.slice(0, -1), { role: "user" as const, content: [...(m.at(-1)!.content as ContentBlock[]), { type: "text" as const, text: "also check b.ts" }] }], {}],
    ["the tool list changed", (m: AgentMessage[]) => m, { tools: [...TOOLS, { name: "grep", description: "Search.", input_schema: { type: "object" } }] }],
    ["the instructions changed", (m: AgentMessage[]) => m, { systemPrompt: "System\n\nSummary of earlier work" }],
  ] as const)("starts a fresh thread seeded from the transcript when %s", async (_why, change, extra) => {
    const s = server();
    s.steps((t) => s.toolCall(t, "c1", "read_file", {}, 9), (t) => s.finish(t, "ok"));
    const first = [ask("Read a.ts")];
    await collect(s.service.stream(request(first)));
    const second = change([...first, { role: "assistant" as const, content: [call("c1")] }, result("c1")]);
    await collect(s.service.stream(request(second, extra as Partial<SubscriptionRequest>)));
    expect(s.calls("thread/start")).toHaveLength(2);
    expect(s.respond).not.toHaveBeenCalled();
    // The abandoned turn is interrupted rather than left waiting for a result that will not come.
    expect(s.calls("turn/interrupt")).toHaveLength(1);
    expect(s.calls("thread/inject_items").length).toBeGreaterThan(0);
  });

  it("retries on a fresh thread when the parked turn can no longer be answered", async () => {
    const s = server();
    s.steps((t) => s.toolCall(t, "c1", "read_file", {}, 3), (t) => s.finish(t, "recovered"));
    const first = [ask("Read a.ts")];
    await collect(s.service.stream(request(first)));
    s.failResponds();
    const events = await collect(s.service.stream(request([...first, { role: "assistant", content: [call("c1")] }, result("c1")])));
    expect(s.calls("thread/start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("recovered");
  });

  it("drops the thread when a round is cancelled", async () => {
    const s = server();
    s.steps(() => { /* the model never answers */ });
    const controller = new AbortController();
    const running = collect(s.service.stream(request([ask("hang")], { signal: controller.signal })));
    await vi.waitFor(() => expect(s.calls("turn/start")).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(s.calls("turn/interrupt").length).toBeGreaterThan(0);
    s.steps((t) => s.finish(t, "again"));
    await collect(s.service.stream(request([ask("hang")])));
    expect(s.calls("thread/start")).toHaveLength(2);
  });

  it("verifies the account and reads plan limits once, not on every round", async () => {
    const s = server();
    s.steps((t) => s.toolCall(t, "c1", "read_file", {}, 1), (t) => s.finish(t, "ok"), (t) => s.finish(t, "again"));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30)); // the usage refresh runs after a round returns
    const first = [ask("go")];
    await collect(s.service.stream(request(first)));
    const second = [...first, { role: "assistant" as const, content: [call("c1")] }, result("c1")];
    await collect(s.service.stream(request(second)));
    await settle();
    // Round one checked the account and loaded the model catalog; finishing the turn refreshed usage.
    expect(s.calls("account/read")).toHaveLength(3);
    expect(s.calls("account/rateLimits/read")).toHaveLength(1);
    // A further turn adds neither: the check is remembered and the refresh is throttled.
    await collect(s.service.stream(request([...second, { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] }, ask("and then?")])));
    await settle();
    expect(s.calls("account/read")).toHaveLength(3);
    expect(s.calls("account/rateLimits/read")).toHaveLength(1);
  });

  it("says so when the model reasoned but sent no summary", async () => {
    const s = server();
    s.steps((t) => { s.usage(t, { input: 50, output: 5, reasoning: 326 }); s.finish(t, "Answer."); });
    const events = await collect(s.service.stream(request([ask("think")])));
    expect(events).toContainEqual({ type: "thinking_delta", text: "Reasoned for 326 tokens. ChatGPT sent no summary of it for this step." });
  });

  it("stays quiet about reasoning when a summary arrived or the model did not reason", async () => {
    const withSummary = server();
    withSummary.steps((t) => { withSummary.usage(t, { input: 5, output: 5, reasoning: 40 }); withSummary.emit("item/reasoning/summaryTextDelta", { threadId: t, delta: "Checking the cache." }); withSummary.finish(t, "ok"); });
    const a = await collect(withSummary.service.stream(request([ask("x")])));
    expect(a.filter((e) => e.type === "thinking_delta").map((e) => (e as { text: string }).text)).toEqual(["Checking the cache."]);
    const none = server();
    none.steps((t) => { none.usage(t, { input: 5, output: 5, reasoning: 0 }); none.finish(t, "ok"); });
    expect((await collect(none.service.stream(request([ask("x")])))).some((e) => e.type === "thinking_delta")).toBe(false);
  });

  it("puts the summary and answer length in thread config, and the summary on each turn", async () => {
    const s = server({ verbosity: "high", reasoningSummary: "detailed" });
    s.steps((t) => s.finish(t, "ok"));
    await collect(s.service.stream(request([ask("go")], { reasoningEffort: "high" })));
    const start = s.calls("thread/start")[0]!.config as Record<string, unknown>;
    expect(start).toMatchObject({ model_reasoning_summary: "detailed", model_verbosity: "high", web_search: "disabled" });
    expect(s.calls("turn/start")[0]).toMatchObject({ summary: "detailed", effort: "high" });
    const quiet = server({ verbosity: "default", reasoningSummary: "none" });
    quiet.steps((t) => quiet.finish(t, "ok"));
    await collect(quiet.service.stream(request([ask("go")])));
    const config = quiet.calls("thread/start")[0]!.config as Record<string, unknown>;
    expect(config).not.toHaveProperty("model_verbosity");
    expect(config).not.toHaveProperty("model_reasoning_summary");
  });

  it("keeps the one-thread-per-call behavior when conversation reuse is off, and for helper calls", async () => {
    const off = server({ reuseConversation: false });
    off.steps((t) => off.toolCall(t, "c1", "read_file", {}, 1), (t) => off.finish(t, "ok"));
    const first = [ask("go")];
    await collect(off.service.stream(request(first)));
    await collect(off.service.stream(request([...first, { role: "assistant", content: [call("c1")] }, result("c1")])));
    expect(off.calls("thread/start")).toHaveLength(2);
    expect(off.calls("turn/start")[0]!.input).toEqual([{ type: "text", text: "Continue from the conversation above. Respond to the latest user request or tool results.", text_elements: [] }]);

    const helper = server();
    helper.steps((t) => helper.finish(t, "summary"), (t) => helper.finish(t, "summary"));
    await collect(helper.service.stream(request([ask("summarize")], { utility: true, conversationId: undefined })));
    await collect(helper.service.stream(request([ask("summarize")], { utility: true, conversationId: undefined })));
    expect(helper.calls("thread/start")).toHaveLength(2);
  });

  it("releases a conversation's thread on request", async () => {
    const s = server();
    s.steps((t) => s.finish(t, "ok"), (t) => s.finish(t, "ok"));
    await collect(s.service.stream(request([ask("one")])));
    s.service.releaseConversation("chat-1");
    await vi.waitFor(() => expect(s.calls("thread/unsubscribe")).toHaveLength(1));
    await collect(s.service.stream(request([ask("one"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, ask("two")])));
    expect(s.calls("thread/start")).toHaveLength(2);
  });
});
