import { describe, expect, it, vi } from "vitest";
import { ChatGptService, codexContextWindow, resolveCodexEffort, subscriptionLimits, toCodexInputItems, type ChatGptOptions, type SubscriptionRequest } from "../../src/chatgpt-service.js";
import type { CodexAppServer, CodexMessage } from "../../src/codex-app-server.js";
import type { AgentMessage, ProviderTurnStreamEvent } from "../../src/agent-loop-contract.js";
import { isRetryableError } from "../../src/provider-retry.js";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}) }));

function fixture(options?: Partial<ChatGptOptions>) {
  const listeners = new Set<(message: CodexMessage) => void>();
  const emit = (method: string, params: Record<string, unknown>, id?: number) => {
    for (const listener of listeners) listener({ method, params, id });
  };
  let signedIn = true;
  let catalog: unknown[] = [];
  let onTurn = () => { emit("turn/completed", { threadId: "t1", turn: { status: "completed" } }); };
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "account/read") return { account: signedIn ? { type: "chatgpt", email: "test@example.com", planType: "plus" } : null };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } } };
    if (method === "account/login/start") return { loginId: "login1", authUrl: "https://auth.openai.com/oauth/authorize?private=value" };
    if (method === "account/logout") { signedIn = false; return {}; }
    if (method === "model/list") return { data: catalog, nextCursor: null };
    if (method === "thread/start") return { thread: { id: "t1" } };
    if (method === "turn/start") { queueMicrotask(onTurn); return { turn: { id: "turn1" } }; }
    return {};
  });
  const rpc = { request, start: vi.fn(async () => {}), dispose: vi.fn(), subscribe: (listener: (m: CodexMessage) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const changed = vi.fn();
  const open = vi.fn(async () => true);
  const settings: ChatGptOptions = { reasoningSummary: "auto", extendedContext: false, ...options };
  const service = new ChatGptService(rpc as unknown as CodexAppServer, "/isolated/blacksite", changed, open, () => settings);
  const calls = (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
  return {
    service, request, changed, open, emit, calls, settings,
    setSignedIn(value: boolean) { signedIn = value; }, setCatalog(value: unknown[]) { catalog = value; }, onTurn(fn: () => void) { onTurn = fn; },
  };
}

const input: SubscriptionRequest = {
  model: "test-model", systemPrompt: "Blacksite instructions", messages: [{ role: "user", content: "List files" }],
  tools: [{ name: "file_list", description: "List files", input_schema: { type: "object", properties: {} } }],
};
async function collect(stream: AsyncGenerator<ProviderTurnStreamEvent>) {
  const events: ProviderTurnStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("ChatGPT account and usage", () => {
  it("opens managed OAuth and exposes only public account metadata", async () => {
    const f = fixture();
    f.setSignedIn(false);
    await f.service.login();
    expect(f.open).toHaveBeenCalledWith(expect.stringContaining("https://auth.openai.com/"));
    expect(f.service.state.status).toBe("connecting");
    f.setSignedIn(true);
    f.emit("account/login/completed", { loginId: "login1", success: true });
    await vi.waitFor(() => expect(f.service.state.status).toBe("connected"));
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain("private=value");
    expect(f.service.state.limits[0]?.primary?.usedPercent).toBe(25);
  });

  it("cancels pending sign-in and ignores late completion", async () => {
    const f = fixture();
    await f.service.login();
    await f.service.cancelLogin();
    f.emit("account/login/completed", { loginId: "login1", success: true });
    expect(f.service.state.status).toBe("disconnected");
    expect(f.request).toHaveBeenCalledWith("account/login/cancel", { loginId: "login1" });
  });

  it("rejects unexpected login URL hosts", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ loginId: "bad", authUrl: "https://unrelated.example/" });
    await f.service.login();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.service.state.error).toContain("unexpected");
  });

  it("retains all quota buckets and distinguishes unavailable from zero usage", () => {
    expect(subscriptionLimits({})).toEqual([]);
    expect(subscriptionLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 0 } }, other: { secondary: { usedPercent: 100 } } } })).toEqual([
      { limitId: "codex", primary: { usedPercent: 0 } }, { limitId: "other", secondary: { usedPercent: 100 } },
    ]);
  });

  it("keeps the last quota snapshot with an error if refresh fails", async () => {
    const f = fixture();
    await f.service.refresh();
    const updated = f.service.state.updatedAt;
    f.request.mockImplementationOnce(async () => { throw new Error("offline"); });
    await f.service.refresh();
    expect(f.service.state).toMatchObject({ status: "connected", updatedAt: updated, error: "offline", refreshing: false });
    expect(f.service.state.limits).toHaveLength(1);
  });

  it("does not republish stale account data after logout", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = f.service.refresh();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await f.service.logout();
    resolve({ account: { type: "chatgpt", email: "old@example.com" } });
    await pending;
    expect(f.service.state).toEqual({ status: "disconnected", limits: [] });
  });

  it("does not restart the app-server after disposal", async () => {
    const f = fixture();
    f.service.dispose();
    await f.service.refresh();
    await expect(f.service.requireAccount()).rejects.toThrow("disposed");
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("ChatGPT model bridge", () => {
  it("hands tools back to Blacksite, interrupts Codex, and replays Blacksite results", async () => {
    const f = fixture();
    f.onTurn(() => {
      f.emit("item/agentMessage/delta", { threadId: "another-thread", delta: "wrong" });
      f.emit("item/agentMessage/delta", { threadId: "t1", delta: "Checking files" });
      f.emit("thread/tokenUsage/updated", { threadId: "t1", tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 10 } } });
      f.emit("item/tool/call", { threadId: "t1", callId: "call1", tool: "blacksite_file_list", arguments: { path: "." } }, 100);
    });
    const events = await collect(f.service.stream(input));
    expect(events).toEqual([
      { type: "text_delta", text: "Checking files" },
      { type: "usage_update", inputTokens: 70, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0 },
      { type: "tool_use_block", block: { type: "tool_use", id: "call1", name: "file_list", input: { path: "." } } },
      { type: "stop_reason", reason: "tool_use" },
    ]);
    expect(f.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "t1", turnId: "turn1" });
    expect(f.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ environments: [], sandbox: "read-only", ephemeral: true }));
    f.onTurn(() => f.emit("turn/completed", { threadId: "t1", turn: { status: "completed" } }));
    await collect(f.service.stream({ ...input, messages: [
      ...input.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "file_list", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "a.ts" }] },
    ] }));
    expect(f.request).toHaveBeenCalledWith("thread/inject_items", expect.objectContaining({ items: expect.arrayContaining([
      expect.objectContaining({ type: "function_call", name: "blacksite_file_list", call_id: "call1" }),
      { type: "function_call_output", call_id: "call1", output: "a.ts" },
    ]) }));
  });

  it("cancels a waiting model and releases the ephemeral thread", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.onTurn(() => controller.abort());
    await expect(collect(f.service.stream({ ...input, signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(f.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "t1", turnId: "turn1" });
    expect(f.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "t1" });
  });

  it("fails without a ChatGPT account and never starts a billable turn", async () => {
    const f = fixture();
    f.setSignedIn(false);
    await expect(collect(f.service.stream(input))).rejects.toThrow("Sign in with ChatGPT");
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("surfaces account limit errors instead of switching billing modes", async () => {
    const f = fixture();
    f.onTurn(() => f.emit("turn/completed", { threadId: "t1", turn: { status: "failed", error: { message: "Usage limit reached" } } }));
    await expect(collect(f.service.stream(input))).rejects.toThrow("Usage limit reached");
  });
});

const catalogModel = (over: Record<string, unknown> = {}) => ({
  id: "test-model", model: "test-model", displayName: "Test Model", isDefault: true, inputModalities: ["text", "image"],
  supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: "medium",
  serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }], upgradeInfo: null, ...over,
});
const efforts = (...names: string[]) => names.map((reasoningEffort) => ({ reasoningEffort }));
const complete = { threadId: "t1", turn: { status: "completed" } };

/** A conversation whose model reasoned, then called a tool from a code-mode `exec` cell. */
const history: AgentMessage[] = [
  { role: "user", content: "List files" },
  { role: "assistant", content: [
    { type: "thinking", thinking: "**Plan**", encryptedContent: "opaque", reasoningItemId: "rs_1" },
    { type: "tool_use", id: "exec-9", name: "file_list", input: { path: "." } },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "exec-9", content: "a.ts" }] },
];

describe("ChatGPT reasoning", () => {
  it("asks for reasoning summaries and streams them as thinking, one paragraph per part", async () => {
    const f = fixture();
    f.onTurn(() => {
      f.emit("item/reasoning/summaryPartAdded", { threadId: "t1", summaryIndex: 0 });
      f.emit("item/reasoning/summaryTextDelta", { threadId: "t1", delta: "**Reading files**" });
      f.emit("item/reasoning/summaryPartAdded", { threadId: "t1", summaryIndex: 1 });
      f.emit("item/reasoning/summaryTextDelta", { threadId: "t1", delta: "**Checking tests**" });
      f.emit("item/agentMessage/delta", { threadId: "t1", delta: "Done" });
      f.emit("turn/completed", complete);
    });
    const events = await collect(f.service.stream(input));
    expect(f.calls("turn/start")[0]).toMatchObject({ summary: "auto" });
    expect(events).toEqual([
      { type: "thinking_delta", text: "**Reading files**" }, { type: "thinking_delta", text: "\n\n" }, { type: "thinking_delta", text: "**Checking tests**" },
      { type: "text_delta", text: "Done" }, { type: "stop_reason", reason: "end_turn" },
    ]);
  });

  it("follows the summary setting on every request, including off", async () => {
    for (const mode of ["concise", "detailed", "none"] as const) {
      const f = fixture({ reasoningSummary: mode });
      await collect(f.service.stream(input));
      expect(f.calls("turn/start")[0]).toMatchObject({ summary: mode });
    }
  });

  it("carries on without summaries when a model refuses to give them", async () => {
    const f = fixture();
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (method === "turn/start" && params?.summary) throw new Error("Unsupported value for summary");
      return base(method, params);
    });
    await collect(f.service.stream(input));
    await collect(f.service.stream(input));
    const turns = f.calls("turn/start");
    expect(turns).toHaveLength(3);
    expect(turns[0]).toHaveProperty("summary");
    expect(turns[1]).not.toHaveProperty("summary");
    expect(turns[2]).not.toHaveProperty("summary");
  });

  it("sends the chosen depth, snapped to one the model accepts, and none when nothing was chosen", async () => {
    const f = fixture();
    f.setCatalog([catalogModel()]);
    for (const reasoningEffort of ["max", "none", undefined, "medium"]) await collect(f.service.stream({ ...input, reasoningEffort }));
    const turns = f.calls("turn/start");
    expect(turns[0]).toMatchObject({ effort: "high" });
    expect(turns[1]).toMatchObject({ effort: "low" });
    expect(turns[2]).not.toHaveProperty("effort");
    expect(turns[3]).toMatchObject({ effort: "medium" });
  });

  it("snaps depths against a catalog, or a cautious guess while there is none", () => {
    expect(resolveCodexEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(resolveCodexEffort("minimal", ["low", "medium"])).toBe("low");
    expect(resolveCodexEffort("max")).toBe("xhigh");
    expect(resolveCodexEffort(undefined, ["low"])).toBeUndefined();
    expect(resolveCodexEffort("ultra", ["low"])).toBeUndefined();
  });

  it("runs helper calls shallow, without summaries or raw events", async () => {
    const f = fixture();
    f.onTurn(() => { f.emit("item/agentMessage/delta", { threadId: "t1", delta: "summary text" }); f.emit("turn/completed", complete); });
    expect(await f.service.text("test-model", "system", [{ role: "user", content: "summarize" }])).toBe("summary text");
    expect(f.calls("turn/start")[0]).toMatchObject({ summary: "none", effort: "low" });
    expect(f.calls("thread/start")[0]).not.toHaveProperty("experimentalRawEvents");
  });

  it("hands over the model's reasoning so it can be replayed with the tool result", async () => {
    const f = fixture();
    f.onTurn(() => {
      f.emit("rawResponseItem/completed", { threadId: "t1", item: { type: "message", role: "developer" } });
      f.emit("rawResponseItem/completed", { threadId: "t1", item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**Plan**" }, { type: "summary_text", text: "**Check**" }], encrypted_content: "opaque" } });
      f.emit("rawResponseItem/completed", { threadId: "t1", item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" } });
      f.emit("item/tool/call", { threadId: "t1", callId: "exec-1", tool: "blacksite_file_list", arguments: { path: "." } }, 5);
    });
    const events = await collect(f.service.stream(input));
    expect(f.calls("thread/start")[0]).toMatchObject({ experimentalRawEvents: true });
    expect(events.filter((event) => event.type === "thinking_block")).toEqual([
      { type: "thinking_block", text: "**Plan**\n\n**Check**", encryptedContent: "opaque", reasoningItemId: "rs_1" },
    ]);
    // No delta streamed, so the finished summary is what the thinking pane shows.
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([{ type: "thinking_delta", text: "**Plan**\n\n**Check**" }]);
  });

  it("does not show a summary twice when it already streamed", async () => {
    const f = fixture();
    f.onTurn(() => {
      f.emit("item/reasoning/summaryTextDelta", { threadId: "t1", delta: "**Plan**" });
      f.emit("rawResponseItem/completed", { threadId: "t1", item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**Plan**" }], encrypted_content: "opaque" } });
      f.emit("turn/completed", complete);
    });
    const events = await collect(f.service.stream(input));
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([{ type: "thinking_delta", text: "**Plan**" }]);
    expect(events.filter((event) => event.type === "thinking_block")).toHaveLength(1);
  });

  it("replays that reasoning, and a code-mode call the way the model wrote it", async () => {
    const f = fixture();
    await collect(f.service.stream({ ...input, messages: history }));
    expect(f.calls("thread/inject_items")[0]!.items).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "List files" }] },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**Plan**" }], encrypted_content: "opaque" },
      { type: "custom_tool_call", call_id: "exec-9", name: "exec", input: 'const r = await tools.blacksite_file_list({"path":"."}); text(r)\n' },
      { type: "custom_tool_call_output", call_id: "exec-9", output: [
        { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: "a.ts" },
      ] },
    ]);
  });

  it("writes the plain transcript when asked for no carried state", () => {
    const plain = toCodexInputItems(history, false);
    expect(plain.map((item) => item.type)).toEqual(["message", "function_call", "function_call_output"]);
    expect(plain[1]).toMatchObject({ call_id: "exec-9", name: "blacksite_file_list" });
    expect(toCodexInputItems([{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "odd-name", input: {} }] }], true)[0])
      .toMatchObject({ type: "function_call", name: "blacksite_odd-name" });
    expect(toCodexInputItems([{ role: "assistant", content: [{ type: "tool_use", id: "exec-2", name: "odd-name", input: {} }] }], true)[0])
      .toMatchObject({ type: "custom_tool_call", input: 'const r = await tools["blacksite_odd-name"]({}); text(r)\n' });
  });

  it("retries once with the plain transcript when Codex refuses the carried reasoning", async () => {
    const f = fixture();
    const base = f.request.getMockImplementation()!;
    let injects = 0;
    f.request.mockImplementation(async (method, params) => {
      if (method === "thread/inject_items" && ++injects === 1) throw new Error("Invalid encrypted content");
      return base(method, params);
    });
    f.onTurn(() => { f.emit("item/agentMessage/delta", { threadId: "t1", delta: "ok" }); f.emit("turn/completed", complete); });
    const events = await collect(f.service.stream({ ...input, messages: history }));
    expect(events).toEqual([
      { type: "notice", level: "info", message: expect.stringContaining("without it") },
      { type: "text_delta", text: "ok" }, { type: "stop_reason", reason: "end_turn" },
    ]);
    const injected = f.calls("thread/inject_items");
    expect(injected).toHaveLength(2);
    expect(JSON.stringify(injected[1]!.items)).not.toContain("reasoning");
    expect(injected[1]!.items).toContainEqual(expect.objectContaining({ type: "function_call", name: "blacksite_file_list" }));
    // Codex has objected to something in this transcript, so the next rounds go plain instead of
    // failing first each time.
    await collect(f.service.stream({ ...input, messages: history }));
    const later = f.calls("thread/inject_items");
    expect(later).toHaveLength(3);
    expect(JSON.stringify(later[2]!.items)).not.toContain("reasoning");
    expect(JSON.stringify(later[2]!.items)).not.toContain("custom_tool_call");
  });

  it("leaves out reasoning that has nothing after it, which the API would reject", () => {
    const orphaned: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", encryptedContent: "opaque", reasoningItemId: "rs_orphan" }] },
      { role: "user", content: "and now?" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "", encryptedContent: "opaque2", reasoningItemId: "rs_answer" },
        { type: "text", text: "Here is the answer." },
      ] },
    ];
    const reasoning = toCodexInputItems(orphaned, true).filter((item) => item.type === "reasoning");
    expect(reasoning).toEqual([expect.objectContaining({ id: "rs_answer" })]);
  });

  it("does not let a helper call decide what window an extended conversation has", async () => {
    const f = fixture({ extendedContext: true });
    f.onTurn(() => {
      f.emit("thread/tokenUsage/updated", { threadId: "t1", tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, modelContextWindow: 258_400 } });
      f.emit("turn/completed", complete);
    });
    await f.service.text("gpt-6-sol", "system", [{ role: "user", content: "summarize" }]);
    f.setCatalog([catalogModel({ id: "gpt-6-sol", model: "gpt-6-sol" })]);
    expect((await f.service.models())[0]!.contextLength).toBe(828_400);
  });

  it("does not retry after output, or a failure the plain transcript cannot fix", async () => {
    const limited = fixture();
    limited.onTurn(() => limited.emit("turn/completed", { threadId: "t1", turn: { status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" } } }));
    await expect(collect(limited.service.stream({ ...input, messages: history }))).rejects.toThrow("Usage limit reached");
    expect(limited.calls("thread/inject_items")).toHaveLength(1);
    const partial = fixture();
    partial.onTurn(() => {
      partial.emit("item/agentMessage/delta", { threadId: "t1", delta: "half" });
      partial.emit("turn/completed", { threadId: "t1", turn: { status: "failed", error: { message: "cut off" } } });
    });
    await expect(collect(partial.service.stream({ ...input, messages: history }))).rejects.toThrow("cut off");
    expect(partial.calls("thread/inject_items")).toHaveLength(1);
  });

  it("marks transient failures retryable for the agent loop, and account or request failures not", async () => {
    for (const [kind, retryable] of [["serverOverloaded", true], ["internalServerError", true], [{ httpConnectionFailed: { httpStatusCode: null } }, true],
      ["usageLimitExceeded", false], ["contextWindowExceeded", false], ["badRequest", false], [null, false]] as const) {
      const f = fixture();
      f.onTurn(() => f.emit("turn/completed", { threadId: "t1", turn: { status: "failed", error: { message: "boom", codexErrorInfo: kind } } }));
      const error = await collect(f.service.stream(input)).catch((e: unknown) => e);
      expect(error, JSON.stringify(kind)).toBeInstanceOf(Error);
      expect(isRetryableError(error), JSON.stringify(kind)).toBe(retryable);
    }
  });

  it("falls back to summaries alone when this Codex does not offer raw events", async () => {
    const f = fixture();
    const base = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (method === "thread/start" && params?.experimentalRawEvents) throw new Error("unknown field `experimentalRawEvents`");
      return base(method, params);
    });
    await collect(f.service.stream(input));
    await collect(f.service.stream(input));
    const starts = f.calls("thread/start");
    expect(starts).toHaveLength(3);
    expect(starts[0]).toHaveProperty("experimentalRawEvents");
    expect(starts[1]).not.toHaveProperty("experimentalRawEvents");
    expect(starts[2]).not.toHaveProperty("experimentalRawEvents");
  });
});

describe("ChatGPT model settings and notices", () => {
  it("passes the speed tier and the larger window only when they were asked for", async () => {
    const plain = fixture();
    await collect(plain.service.stream(input));
    expect(plain.calls("thread/start")[0]).not.toHaveProperty("serviceTier");
    expect(plain.calls("thread/start")[0]!.config).not.toHaveProperty("model_context_window");
    const fast = fixture({ extendedContext: true });
    await collect(fast.service.stream({ ...input, serviceTier: "priority" }));
    expect(fast.calls("thread/start")[0]).toMatchObject({ serviceTier: "priority", config: { model_context_window: 872_000 } });
  });

  it("reports a reroute, a provider warning and a retry as they happen", async () => {
    const f = fixture();
    f.onTurn(() => {
      f.emit("model/rerouted", { threadId: "t1", fromModel: "gpt-6-sol", toModel: "gpt-5.6-luna", reason: "highRiskCyberActivity" });
      f.emit("warning", { threadId: "t1", message: "Approaching your usage limit" });
      f.emit("error", { threadId: "t1", error: { message: "stream dropped" }, willRetry: true });
      f.emit("turn/completed", complete);
    });
    const events = await collect(f.service.stream(input));
    expect(events).toEqual([
      { type: "notice", level: "warn", message: expect.stringMatching(/gpt-5\.6-luna instead of gpt-6-sol.*high-risk cyber/) },
      { type: "notice", level: "warn", message: "Approaching your usage limit" },
      { type: "provider_activity", phase: "retrying", message: "ChatGPT is retrying: stream dropped" },
      { type: "stop_reason", reason: "end_turn" },
    ]);
  });

  it("lists Codex models with their own depths, speed tiers and real context window", async () => {
    const f = fixture();
    const soon = Math.floor(Date.now() / 1000) + 10 * 86_400;
    f.setCatalog([
      catalogModel({ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max", "ultra"), defaultReasoningEffort: "low" }),
      catalogModel({ id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", isDefault: false, upgradeInfo: { model: "gpt-5.6-sol", retirementAt: soon } }),
      catalogModel({ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: false, upgradeInfo: { model: "gpt-5.5", retirementAt: 1000 } }),
    ]);
    const models = await f.service.models();
    expect(models.find((model) => model.id === "gpt-6-astra")).toMatchObject({
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "low", contextLength: 258_400,
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }], supportsVision: true,
    });
    expect(models.find((model) => model.id === "gpt-5.5")!.name).toMatch(/^GPT-5\.5 \(retires /);
    expect(models.find((model) => model.id === "gpt-5.4")!.name).toBe("GPT-5.4");
    f.settings.extendedContext = true;
    const extended = await f.service.models();
    expect(extended.find((model) => model.id === "gpt-6-astra")!.contextLength).toBe(828_400);
    expect(extended.find((model) => model.id === "gpt-5.5")!.contextLength).toBe(258_400);
  });

  it("uses the window Codex reports once it has seen one", async () => {
    const f = fixture();
    f.onTurn(() => {
      f.emit("thread/tokenUsage/updated", { threadId: "t1", tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }, modelContextWindow: 400_000 } });
      f.emit("turn/completed", complete);
    });
    await collect(f.service.stream(input));
    f.setCatalog([catalogModel()]);
    expect((await f.service.models())[0]!.contextLength).toBe(400_000);
  });

  it("knows which models take the larger window", () => {
    expect([codexContextWindow("gpt-6-sol", false), codexContextWindow("gpt-6-sol", true), codexContextWindow("gpt-5.6-luna", true), codexContextWindow("gpt-5.5", true)])
      .toEqual([258_400, 828_400, 828_400, 258_400]);
  });
});
