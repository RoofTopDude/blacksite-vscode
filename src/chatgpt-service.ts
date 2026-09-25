import { mkdir } from "node:fs/promises";
import type { AgentMessage, ProviderTurnStreamEvent, ToolUseBlock } from "./agent-loop-contract.js";
import { toResponsesInputItems } from "./agent/wire/openai.js";
import { CodexAppServer, type CodexMessage } from "./codex-app-server.js";
import type { ChatGptLimit, ChatGptState } from "./chatgpt-types.js";
import type { ModelInfo } from "./model-fetcher.js";

export interface SubscriptionRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  signal?: AbortSignal;
  reasoningEffort?: string;
}
export type SubscriptionStream = (request: SubscriptionRequest) => AsyncGenerator<ProviderTurnStreamEvent>;

export function subscriptionLimits(result: Record<string, unknown>): ChatGptLimit[] {
  const buckets = result.rateLimitsByLimitId as Record<string, ChatGptLimit> | undefined;
  if (buckets && Object.keys(buckets).length) return Object.entries(buckets).map(([id, limit]) => ({ ...limit, limitId: limit.limitId ?? id }));
  return result.rateLimits ? [result.rateLimits as ChatGptLimit] : [];
}

/** Codex owns OAuth; this service only handles account metadata and model events. */
export class ChatGptService {
  state: ChatGptState = { status: "disconnected", limits: [] };
  private loginId?: string;
  private refreshing?: Promise<void>;
  private accountVersion = 0;
  private disposed = false;
  private activeTurns = new Map<string, string>();

  constructor(
    private readonly rpc: CodexAppServer,
    private readonly home: string,
    private readonly changed: (state: ChatGptState) => void,
    private readonly openExternal: (url: string) => Promise<boolean>,
  ) {
    rpc.subscribe((message) => this.accountEvent(message), () => {
      this.loginId = undefined;
      this.publish({ status: "disconnected", limits: [], error: "Codex disconnected. Refresh to reconnect." });
    });
  }

  private publish(state: ChatGptState): void { this.state = state; this.changed(state); }

  private accountEvent(message: CodexMessage): void {
    if (message.method === "account/login/completed" && message.params?.loginId === this.loginId) {
      this.loginId = undefined;
      if (message.params?.success) void this.refresh();
      else this.publish({ status: "disconnected", limits: [], error: String(message.params?.error ?? "Sign-in was cancelled.") });
    } else if (message.method === "account/updated" && !message.params?.authMode) {
      this.accountVersion++;
      this.publish({ status: "disconnected", limits: [] });
    } else if (message.method === "account/rateLimits/updated" && this.state.status === "connected") {
      const limits = subscriptionLimits(message.params ?? {});
      const merged = new Map(this.state.limits.map((limit) => [limit.limitId ?? "codex", limit]));
      for (const limit of limits) merged.set(limit.limitId ?? "codex", limit);
      this.publish({ ...this.state, limits: [...merged.values()], updatedAt: Date.now(), error: undefined });
    }
  }

  private async ready(): Promise<void> {
    if (this.disposed) throw new Error("ChatGPT connection disposed.");
    await mkdir(this.home, { recursive: true });
    if (this.disposed) throw new Error("ChatGPT connection disposed.");
    await this.rpc.start();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readAccount().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async readAccount(): Promise<void> {
    const version = this.accountVersion;
    this.publish({ ...this.state, refreshing: true, error: undefined });
    try {
      await this.ready();
      const { account } = await this.rpc.request<{ account: { type: string; email?: string; planType?: string } | null }>("account/read", { refreshToken: false });
      if (version !== this.accountVersion) return;
      if (account?.type !== "chatgpt") {
        this.publish({ status: this.loginId ? "connecting" : "disconnected", limits: [] });
        return;
      }
      this.publish({ ...this.state, status: "connected", email: account.email, planType: account.planType, refreshing: true });
      const result = await this.rpc.request("account/rateLimits/read");
      if (version !== this.accountVersion) return;
      this.publish({ status: "connected", email: account.email, planType: account.planType, limits: subscriptionLimits(result), updatedAt: Date.now() });
    } catch (error) {
      if (version !== this.accountVersion) return;
      this.publish({ ...this.state, refreshing: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async requireAccount(): Promise<void> {
    await this.ready();
    const result = await this.rpc.request<{ account: { type: string } | null }>("account/read", { refreshToken: false });
    if (result.account?.type !== "chatgpt") throw new Error("Sign in with ChatGPT in Blacksite Settings > Model to use your subscription.");
  }

  async login(): Promise<void> {
    if (this.loginId || this.state.status === "connecting") return;
    const version = ++this.accountVersion;
    this.publish({ status: "connecting", limits: [] });
    try {
      await this.ready();
      const result = await this.rpc.request<{ loginId: string; authUrl: string }>("account/login/start", { type: "chatgpt" });
      if (version !== this.accountVersion) {
        await this.rpc.request("account/login/cancel", { loginId: result.loginId });
        return;
      }
      this.loginId = result.loginId;
      const url = new URL(result.authUrl);
      if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) throw new Error("Codex returned an unexpected sign-in URL.");
      if (!await this.openExternal(result.authUrl)) throw new Error("Could not open the sign-in browser. Cancel and try again.");
    } catch (error) {
      if (version !== this.accountVersion) return;
      if (this.loginId) await this.rpc.request("account/login/cancel", { loginId: this.loginId }).catch(() => {});
      this.loginId = undefined;
      this.publish({ status: "disconnected", limits: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  async cancelLogin(): Promise<void> {
    this.accountVersion++;
    if (this.loginId) await this.rpc.request("account/login/cancel", { loginId: this.loginId });
    this.loginId = undefined;
    this.publish({ status: "disconnected", limits: [] });
  }

  async logout(): Promise<void> {
    await this.ready();
    await this.cancelLogin();
    await Promise.all([...this.activeTurns].map(([threadId, turnId]) => this.rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {})));
    await this.rpc.request("account/logout");
    this.publish({ status: "disconnected", limits: [] });
  }

  async models(): Promise<ModelInfo[]> {
    await this.requireAccount();
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Array<{ id: string; model: string; displayName: string; isDefault: boolean; inputModalities?: string[] }>; nextCursor: string | null } = await this.rpc.request("model/list", { cursor, limit: 100 });
      for (const model of page.data) {
        const info: ModelInfo = { id: model.model, name: model.displayName, source: "api", supportsTools: true, supportsVision: model.inputModalities?.includes("image") };
        if (model.isDefault) models.unshift(info); else models.push(info);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  /** Each provider round gets an ephemeral thread seeded from Blacksite's authoritative
   * transcript. This preserves edits, restored sessions and client-side compression.
   * A dynamic tool request ends the model round; Blacksite executes it through its
   * normal tool/approval pipeline and replays the result on the next round. */
  async *stream(request: SubscriptionRequest): AsyncGenerator<ProviderTurnStreamEvent> {
    request.signal?.throwIfAborted();
    await this.requireAccount();
    const tools = request.tools.map((tool) => ({ type: "function", name: `blacksite_${tool.name}`, description: tool.description, inputSchema: tool.input_schema }));
    const result = await this.rpc.request<{ thread: { id: string } }>("thread/start", {
      model: request.model || null, modelProvider: "openai", ephemeral: true,
      cwd: this.home, environments: [], sandbox: "read-only", approvalPolicy: "never",
      baseInstructions: request.systemPrompt,
      developerInstructions: "Use only the blacksite_ tools. Blacksite executes tools and owns the conversation history.",
      dynamicTools: tools,
      config: { "features.shell_tool": false, "features.unified_exec": false, "features.apps": false, "features.multi_agent": false, web_search: "disabled", project_doc_max_bytes: 0 },
    });
    const threadId = result.thread.id;
    const queue: CodexMessage[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let turnId: string | undefined;
    let completed = false;
    let call: ToolUseBlock | undefined;
    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number } | undefined;
    const unsubscribe = this.rpc.subscribe((message) => {
      if (message.params?.threadId === threadId && message.method === "thread/tokenUsage/updated") {
        usage = (message.params.tokenUsage as { total?: typeof usage })?.total;
      }
      if (message.params?.threadId === threadId) { queue.push(message); wake?.(); }
    }, (error) => { failure = error; wake?.(); });
    const abort = () => { failure = new Error("ChatGPT request cancelled."); failure.name = "AbortError"; wake?.(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { failure = new Error("ChatGPT response timed out. Retry the request."); wake?.(); }, 10 * 60_000);
    try {
      request.signal?.throwIfAborted();
      const items = toResponsesInputItems(request.messages).map((item) => {
        if (item.type === "function_call") return { ...item, name: `blacksite_${item.name}` };
        if (item.type === "message" && typeof item.content === "string") return { ...item, content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }] };
        return item;
      });
      if (items.length) await this.rpc.request("thread/inject_items", { threadId, items });
      const turn = await this.rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId, input: [{ type: "text", text: "Continue from the conversation above. Respond to the latest user request or tool results." }],
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      });
      turnId = turn.turn.id;
      this.activeTurns.set(threadId, turnId);
      while (!completed && !call) {
        if (failure) throw failure;
        const message = queue.shift();
        if (!message) { await new Promise<void>((resolve) => { wake = resolve; }); continue; }
        const p = message.params ?? {};
        if (message.method === "item/agentMessage/delta") yield { type: "text_delta", text: String(p.delta ?? "") };
        else if (message.method === "item/reasoning/summaryTextDelta") yield { type: "thinking_delta", text: String(p.delta ?? "") };
        else if (message.method === "item/tool/call") {
          const name = String(p.tool ?? "").replace(/^blacksite_/, "");
          if (!request.tools.some((tool) => tool.name === name)) throw new Error("Codex requested an unavailable Blacksite tool.");
          const input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Codex returned invalid tool arguments.");
          if (typeof p.callId !== "string" || !p.callId) throw new Error("Codex returned an invalid tool call ID.");
          call = { type: "tool_use", id: String(p.callId), name, input: input as Record<string, unknown> };
        } else if (message.method === "turn/completed") {
          const final = p.turn as { status: string; error?: { message: string } };
          if (final.status !== "completed") throw new Error(final.error?.message ?? "ChatGPT request interrupted.");
          completed = true;
        }
      }
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      if (turnId && !completed) await this.rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      this.activeTurns.delete(threadId);
      await this.rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
      unsubscribe();
      void this.refresh();
    }
    request.signal?.throwIfAborted();
    if (usage) yield { type: "usage_update", inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens - (usage.cacheWriteInputTokens ?? 0)), outputTokens: usage.outputTokens, cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens ?? 0 };
    if (call) yield { type: "tool_use_block", block: call };
    yield { type: "stop_reason", reason: call ? "tool_use" : "end_turn" };
  }

  async text(model: string, systemPrompt: string, messages: AgentMessage[], signal?: AbortSignal): Promise<string> {
    let text = "";
    for await (const event of this.stream({ model, systemPrompt, messages, tools: [], signal })) if (event.type === "text_delta") text += event.text;
    return text;
  }

  dispose(): void { this.disposed = true; this.accountVersion++; this.rpc.dispose(); }
}
