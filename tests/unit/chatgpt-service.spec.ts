import { describe, expect, it, vi } from "vitest";
import { ChatGptService, subscriptionLimits, type SubscriptionRequest } from "../../src/chatgpt-service.js";
import type { CodexAppServer, CodexMessage } from "../../src/codex-app-server.js";
import type { ProviderTurnStreamEvent } from "../../src/agent-loop-contract.js";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}) }));

function fixture() {
  const listeners = new Set<(message: CodexMessage) => void>();
  const emit = (method: string, params: Record<string, unknown>, id?: number) => {
    for (const listener of listeners) listener({ method, params, id });
  };
  let signedIn = true;
  let onTurn = () => { emit("turn/completed", { threadId: "t1", turn: { status: "completed" } }); };
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === "account/read") return { account: signedIn ? { type: "chatgpt", email: "test@example.com", planType: "plus" } : null };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } } };
    if (method === "account/login/start") return { loginId: "login1", authUrl: "https://auth.openai.com/oauth/authorize?private=value" };
    if (method === "account/logout") { signedIn = false; return {}; }
    if (method === "thread/start") return { thread: { id: "t1" } };
    if (method === "turn/start") { queueMicrotask(onTurn); return { turn: { id: "turn1" } }; }
    return {};
  });
  const rpc = { request, start: vi.fn(async () => {}), dispose: vi.fn(), subscribe: (listener: (m: CodexMessage) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const changed = vi.fn();
  const open = vi.fn(async () => true);
  const service = new ChatGptService(rpc as unknown as CodexAppServer, "/isolated/blacksite", changed, open);
  return { service, request, changed, open, emit, setSignedIn(value: boolean) { signedIn = value; }, onTurn(fn: () => void) { onTurn = fn; } };
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
