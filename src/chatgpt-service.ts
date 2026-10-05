import { mkdir } from "node:fs/promises";
import type { AgentMessage, ProviderTurnStreamEvent, ToolUseBlock } from "./agent-loop-contract.js";
import { toResponsesInputItems } from "./agent/wire/openai.js";
import { codexSearchResults, codexWebSearchConfig, isCodexSearchCell } from "./agent/hosted-search.js";
import type { HostedSearchPolicy } from "./browser/approval-types.js";
import { CodexAppServer, type CodexMessage } from "./codex-app-server.js";
import type { ChatGptLimit, ChatGptState } from "./chatgpt-types.js";
import { modelFamilySupportsVision, type ModelInfo } from "./model-fetcher.js";
import { ProviderStreamError, isAbortError } from "./provider-retry.js";

export interface SubscriptionRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  signal?: AbortSignal;
  reasoningEffort?: string;
  /** Codex processing tier: "priority" is Fast, "default" is Standard. Omitted leaves the account default. */
  serviceTier?: string;
  /** A one-shot helper call (compaction, summaries): shallow reasoning, no reasoning summary,
   *  and no reasoning state carried to or from the conversation. */
  utility?: boolean;
  /** Codex's own web search, when it is on for this chat (ResearchHost decides). */
  hostedSearch?: HostedSearchPolicy;
}
export type SubscriptionStream = (request: SubscriptionRequest) => AsyncGenerator<ProviderTurnStreamEvent>;

/** How much of the model's reasoning Codex is asked to summarize. Without a request the
 *  server sends none at all (every catalog model defaults to "none"). */
export type ReasoningSummaryMode = "auto" | "concise" | "detailed" | "none";
export interface ChatGptOptions {
  reasoningSummary: ReasoningSummaryMode;
  /** Ask Codex for the model's largest context window instead of its 272K default. */
  extendedContext: boolean;
}
export const DEFAULT_CHATGPT_OPTIONS: ChatGptOptions = { reasoningSummary: "auto", extendedContext: false };

export function subscriptionLimits(result: Record<string, unknown>): ChatGptLimit[] {
  const buckets = result.rateLimitsByLimitId as Record<string, ChatGptLimit> | undefined;
  if (buckets && Object.keys(buckets).length) return Object.entries(buckets).map(([id, limit]) => ({ ...limit, limitId: limit.limitId ?? id }));
  return result.rateLimits ? [result.rateLimits as ChatGptLimit] : [];
}

/** Depth ladder in Codex's vocabulary, shallowest first. "ultra" is left out of what Blacksite
 *  offers: it hands work to Codex's own sub-agents, which this integration keeps disabled. */
const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** What the catalog lists for every model today; used only while the live catalog is unknown. */
const ASSUMED_EFFORTS = ["low", "medium", "high", "xhigh"];

/** Snap a requested depth to one the model accepts — nearest shallower rung first, then deeper —
 *  so a persisted setting survives a model switch instead of failing every turn. */
export function resolveCodexEffort(requested: string | undefined, supported?: readonly string[]): string | undefined {
  if (!requested) return undefined;
  const accepted = supported?.length ? supported : ASSUMED_EFFORTS;
  if (accepted.includes(requested)) return requested;
  const index = (EFFORT_LADDER as readonly string[]).indexOf(requested);
  if (index < 0) return undefined;
  for (let step = 1; step < EFFORT_LADDER.length; step++) {
    const shallower = EFFORT_LADDER[index - step];
    if (shallower && accepted.includes(shallower)) return shallower;
    const deeper = EFFORT_LADDER[index + step];
    if (deeper && accepted.includes(deeper)) return deeper;
  }
  return undefined;
}

/** Codex reports the window it will actually use: 95% of the model's, which is 258,400 of 272,000.
 *  The gpt-6 and gpt-5.6 families accept up to 872,000 when asked; nothing older does. */
const CODEX_EFFECTIVE_PERCENT = 0.95;
const CODEX_DEFAULT_WINDOW = 272_000;
const CODEX_EXTENDED_WINDOW = 872_000;
export function codexContextWindow(model: string, extended: boolean): number {
  const larger = extended && /^gpt-(?:6|5\.[6-9])/i.test(model);
  return Math.floor((larger ? CODEX_EXTENDED_WINDOW : CODEX_DEFAULT_WINDOW) * CODEX_EFFECTIVE_PERCENT);
}

/** Code-mode models (gpt-6, gpt-5.6) call tools from inside a JavaScript `exec` cell, and the
 *  app-server reports such a call under a synthetic `exec-` id rather than the model's own. */
const CODE_MODE_CALL = /^exec-/;
const EXEC_PREFIX = "Script completed\nWall time 0.0 seconds\nOutput:\n";

function execSource(tool: string, args: unknown): string {
  const name = `blacksite_${tool}`;
  const accessor = /^[A-Za-z_$][\w$]*$/.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`;
  return `const r = await ${accessor}(${typeof args === "string" && args.trim() ? args : "{}"}); text(r)\n`;
}

/**
 * Blacksite's transcript as Responses input items for a fresh Codex thread.
 *
 * With `continuity`, the model's own reasoning is replayed ahead of the calls it produced, and a
 * code-mode call is written the way that model wrote it (an `exec` cell with the tool's output)
 * rather than as a bare function call. Both matter: replayed the old way, gpt-5.6 models
 * re-issued a call they had already made instead of using its result.
 */
export function toCodexInputItems(messages: AgentMessage[], continuity: boolean): Array<Record<string, unknown>> {
  const codeCalls = new Set<string>();
  const items: Array<Record<string, unknown>> = [];
  const source = toResponsesInputItems(messages, { codexNative: continuity });
  source.forEach((item, index) => {
    if (item.type === "reasoning") {
      // A reasoning item is only valid in front of what it led to. Compaction or a cancelled tool
      // can leave one with nothing after it, and the API rejects that, so it is left out.
      const next = source[index + 1];
      const leadsSomewhere = next?.type === "function_call" || next?.type === "custom_tool_call" || (next?.type === "message" && next.role === "assistant");
      if (continuity && leadsSomewhere) items.push(item);
    } else if (item.type === "function_call") {
      const callId = String(item.call_id ?? "");
      if (continuity && CODE_MODE_CALL.test(callId)) {
        codeCalls.add(callId);
        items.push({ type: "custom_tool_call", call_id: callId, name: "exec", input: execSource(String(item.name), item.arguments) });
      } else items.push({ ...item, name: `blacksite_${String(item.name)}` });
    } else if (item.type === "function_call_output" && codeCalls.has(String(item.call_id ?? ""))) {
      items.push({ type: "custom_tool_call_output", call_id: item.call_id, output: [
        { type: "input_text", text: EXEC_PREFIX }, { type: "input_text", text: String(item.output ?? "") },
      ] });
    } else if (item.type === "message" && typeof item.content === "string") {
      items.push({ ...item, content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }] });
    } else items.push(item);
  });
  return items;
}

const TRANSIENT_FAILURES = new Set(["serverOverloaded", "internalServerError", "rateLimitExceeded", "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"]);
/** Failures a different request shape cannot fix, so the plain-replay retry would only repeat them. */
const FINAL_FAILURES = new Set(["usageLimitExceeded", "contextWindowExceeded", "sessionBudgetExceeded", "unauthorized", "cyberPolicy", "misalignmentPolicyViolation", "responseTooManyFailedAttempts"]);

class CodexTurnError extends ProviderStreamError {
  constructor(message: string, readonly kind: string) {
    super(message, TRANSIENT_FAILURES.has(kind));
    this.name = "CodexTurnError";
  }
}

function turnFailure(error: { message?: string; codexErrorInfo?: unknown } | null | undefined): CodexTurnError {
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] ?? "other" : "other";
  return new CodexTurnError(error?.message ?? "ChatGPT request interrupted.", kind);
}

type ReasoningSummaryPart = { text?: unknown };
function joinSummary(summary: unknown): string {
  return (Array.isArray(summary) ? summary as ReasoningSummaryPart[] : []).map((part) => String(part?.text ?? "")).filter(Boolean).join("\n\n");
}

interface CodexCatalogModel {
  id: string; model: string; displayName: string; isDefault: boolean; inputModalities?: string[];
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>; defaultReasoningEffort?: string;
  serviceTiers?: Array<{ id: string; name: string; description: string }>;
  upgradeInfo?: { model: string; retirementAt?: number | null } | null;
}

/** Codex owns OAuth; this service only handles account metadata and model events. */
export class ChatGptService {
  state: ChatGptState = { status: "disconnected", limits: [] };
  private loginId?: string;
  private refreshing?: Promise<void>;
  private accountVersion = 0;
  private disposed = false;
  private activeTurns = new Map<string, string>();
  private catalog = new Map<string, ModelInfo>();
  private catalogFetchedAt = 0;
  private catalogLoad?: Promise<void>;
  /** The window Codex reported for a model, keyed with whether extended context was asked for. */
  private observedWindows = new Map<string, number>();
  /** Set once the app-server rejects raw response events; reasoning continuity is then unavailable. */
  private rawEvents = true;
  private summaryRejected = new Set<string>();
  /** After Codex refuses carried reasoning, requests go plain for a while rather than failing first
   *  every round: whatever it objected to stays in the transcript until compaction removes it. */
  private continuityPausedUntil = 0;

  constructor(
    private readonly rpc: CodexAppServer,
    private readonly home: string,
    private readonly changed: (state: ChatGptState) => void,
    private readonly openExternal: (url: string) => Promise<boolean>,
    private readonly options: () => ChatGptOptions = () => DEFAULT_CHATGPT_OPTIONS,
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
    this.catalog.clear();
    this.catalogFetchedAt = 0;
    this.publish({ status: "disconnected", limits: [] });
  }

  private contextWindow(model: string): number {
    const extended = this.options().extendedContext;
    return this.observedWindows.get(`${model}|${extended}`) ?? codexContextWindow(model, extended);
  }

  async models(): Promise<ModelInfo[]> {
    await this.requireAccount();
    const models: ModelInfo[] = [];
    const catalog = new Map<string, ModelInfo>();
    let cursor: string | null = null;
    do {
      const page: { data?: CodexCatalogModel[]; nextCursor?: string | null } = await this.rpc.request("model/list", { cursor, limit: 100 });
      for (const model of page.data ?? []) {
        const retiresAt = model.upgradeInfo?.retirementAt;
        // Seconds since the epoch; a value that is already past is not worth announcing.
        const retirement = typeof retiresAt === "number" && retiresAt * 1000 > Date.now() ? new Date(retiresAt * 1000) : undefined;
        const efforts = (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort).filter((effort) => (EFFORT_LADDER as readonly string[]).includes(effort));
        const info: ModelInfo = {
          id: model.model,
          name: retirement ? `${model.displayName} (retires ${retirement.toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : model.displayName,
          source: "api", supportsTools: true, supportsThinking: true,
          supportsVision: model.inputModalities ? model.inputModalities.includes("image") : modelFamilySupportsVision(model.model),
          contextLength: this.contextWindow(model.model),
          ...(efforts.length ? { reasoningEfforts: efforts } : {}),
          ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
          ...(model.serviceTiers?.length ? { serviceTiers: model.serviceTiers } : {}),
        };
        catalog.set(info.id, info);
        if (model.isDefault) models.unshift(info); else models.push(info);
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    this.catalog = catalog;
    this.catalogFetchedAt = Date.now();
    return models;
  }

  /** The catalog entry for a model, loading the catalog once if this model has not been seen.
   *  Best effort: a request never waits on, or fails because of, a catalog that will not load. */
  private async modelInfo(id: string): Promise<ModelInfo | undefined> {
    if (!this.catalog.has(id) && Date.now() - this.catalogFetchedAt > 60_000 && !this.catalogLoad) {
      this.catalogFetchedAt = Date.now();
      this.catalogLoad = this.models().then(() => undefined, () => undefined).finally(() => { this.catalogLoad = undefined; });
    }
    await this.catalogLoad;
    return this.catalog.get(id);
  }

  /** Each provider round gets an ephemeral thread seeded from Blacksite's authoritative
   * transcript. This preserves edits, restored sessions and client-side compression.
   * A dynamic tool request ends the model round; Blacksite executes it through its
   * normal tool/approval pipeline and replays the result on the next round.
   *
   * The model's reasoning is captured from the raw response stream and replayed with the
   * result. If Codex refuses that replay before producing anything, the round is retried once
   * with the plain transcript, so continuity can only ever improve a request, never fail one. */
  async *stream(request: SubscriptionRequest): AsyncGenerator<ProviderTurnStreamEvent> {
    request.signal?.throwIfAborted();
    await this.requireAccount();
    const info = await this.modelInfo(request.model);
    const continuity = !request.utility && Date.now() >= this.continuityPausedUntil;
    const items = toCodexInputItems(request.messages, continuity);
    const carried = continuity && items.some((item) => item.type === "reasoning" || item.type === "custom_tool_call");
    let produced = false;
    try {
      for await (const event of this.round(request, info, items)) {
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "thinking_block" || event.type === "tool_use_block") produced = true;
        yield event;
      }
    } catch (error) {
      if (!carried || produced || request.signal?.aborted || isAbortError(error) || (error instanceof CodexTurnError && FINAL_FAILURES.has(error.kind))) throw error;
      this.continuityPausedUntil = Date.now() + 10 * 60_000;
      yield { type: "notice", level: "info", message: "ChatGPT did not accept the earlier reasoning state; continuing without it." };
      yield* this.round(request, info, toCodexInputItems(request.messages, false));
    }
  }

  private async startThread(params: Record<string, unknown>, raw: boolean): Promise<{ thread: { id: string } }> {
    try {
      return await this.rpc.request<{ thread: { id: string } }>("thread/start", raw ? { ...params, experimentalRawEvents: true } : params);
    } catch (error) {
      if (!raw || !/experimentalRawEvents|unknown field|unexpected field/i.test(error instanceof Error ? error.message : String(error))) throw error;
      this.rawEvents = false;
      return this.rpc.request<{ thread: { id: string } }>("thread/start", params);
    }
  }

  private async *round(request: SubscriptionRequest, info: ModelInfo | undefined, items: Array<Record<string, unknown>>): AsyncGenerator<ProviderTurnStreamEvent> {
    const options = this.options();
    const tools = request.tools.map((tool) => ({ type: "function", name: `blacksite_${tool.name}`, description: tool.description, inputSchema: tool.input_schema }));
    const effort = resolveCodexEffort(request.utility ? "low" : request.reasoningEffort, info?.reasoningEfforts);
    const summary = request.utility ? "none" : this.summaryRejected.has(request.model) ? undefined : options.reasoningSummary;
    const config: Record<string, unknown> = {
      "features.shell_tool": false, "features.unified_exec": false, "features.apps": false, "features.multi_agent": false, project_doc_max_bytes: 0,
      // Codex's own search stays off unless the user turned it on for this chat; a helper call
      // never searches.
      ...codexWebSearchConfig(request.utility ? undefined : request.hostedSearch),
    };
    if (options.extendedContext && !request.utility) config.model_context_window = CODEX_EXTENDED_WINDOW;
    const result = await this.startThread({
      model: request.model || null, modelProvider: "openai", ephemeral: true,
      cwd: this.home, environments: [], sandbox: "read-only", approvalPolicy: "never",
      baseInstructions: request.systemPrompt,
      developerInstructions: config["web_search"] === "cached"
        ? "Use only the blacksite_ tools and web search. Blacksite executes the blacksite_ tools and owns the conversation history."
        : "Use only the blacksite_ tools. Blacksite executes tools and owns the conversation history.",
      dynamicTools: tools,
      ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
      config,
    }, this.rawEvents && !request.utility);
    const threadId = result.thread.id;
    // Only a thread that asked for the larger window can report it; a helper call never does.
    const extendedApplied = options.extendedContext && !request.utility;
    const queue: CodexMessage[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let turnId: string | undefined;
    let completed = false;
    let call: ToolUseBlock | undefined;
    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number } | undefined;
    const unsubscribe = this.rpc.subscribe((message) => {
      if (message.params?.threadId === threadId && message.method === "thread/tokenUsage/updated") {
        const tokenUsage = message.params.tokenUsage as { total?: typeof usage; modelContextWindow?: number | null } | undefined;
        usage = tokenUsage?.total;
        if (tokenUsage?.modelContextWindow) this.observedWindows.set(`${request.model}|${extendedApplied}`, tokenUsage.modelContextWindow);
      }
      if (message.params?.threadId === threadId) { queue.push(message); wake?.(); }
    }, (error) => { failure = error; wake?.(); });
    const abort = () => { failure = new Error("ChatGPT request cancelled."); failure.name = "AbortError"; wake?.(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { failure = new Error("ChatGPT response timed out. Retry the request."); wake?.(); }, 10 * 60_000);
    try {
      request.signal?.throwIfAborted();
      if (items.length) await this.rpc.request("thread/inject_items", { threadId, items });
      const start = (withSummary: boolean) => this.rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId, input: [{ type: "text", text: "Continue from the conversation above. Respond to the latest user request or tool results." }],
        ...(effort ? { effort } : {}),
        ...(withSummary && summary ? { summary } : {}),
      });
      let turn: { turn: { id: string } };
      try { turn = await start(true); } catch (error) {
        // A model that cannot summarize its reasoning should still answer.
        if (!summary || summary === "none" || !/summary/i.test(error instanceof Error ? error.message : String(error))) throw error;
        this.summaryRejected.add(request.model);
        turn = await start(false);
      }
      turnId = turn.turn.id;
      this.activeTurns.set(threadId, turnId);
      const reasoningSeen = new Set<string>();
      let thinking = false;
      // A code-mode search is an `exec` cell that ran only the built-in web tool. Its output holds
      // the results, so the pair is kept for the next round's replay once the output arrives.
      const searchCells = new Map<string, Record<string, unknown>>();
      // Codex echoes the injected history back as rawResponseItem/completed events. Those items are
      // already in the transcript; recording them again would replay every earlier search twice
      // the next round, and twice more the round after.
      const replayedCalls = new Set<string>();
      for (const message of request.messages) {
        if (typeof message.content === "string") continue;
        for (const block of message.content) {
          if (block.type === "thinking" && block.reasoningItemId) reasoningSeen.add(block.reasoningItemId);
          if (block.type === "provider_native" && block.provider === "codex" && typeof block.block["call_id"] === "string") replayedCalls.add(block.block["call_id"]);
        }
      }
      while (!completed && !call) {
        if (failure) throw failure;
        const message = queue.shift();
        if (!message) { await new Promise<void>((resolve) => { wake = resolve; }); continue; }
        const p = message.params ?? {};
        if (message.method === "item/agentMessage/delta") yield { type: "text_delta", text: String(p.delta ?? "") };
        else if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
          const text = String(p.delta ?? "");
          if (text) { thinking = true; yield { type: "thinking_delta", text }; }
        } else if (message.method === "item/reasoning/summaryPartAdded") {
          // Each summary part is its own titled paragraph; without a break they run together.
          if (thinking) yield { type: "thinking_delta", text: "\n\n" };
        } else if (message.method === "rawResponseItem/completed") {
          const raw = p.item as { type?: string; id?: unknown; summary?: unknown; encrypted_content?: unknown; call_id?: unknown; name?: unknown; input?: unknown; output?: unknown } | undefined;
          if (raw?.type === "reasoning" && typeof raw.id === "string" && !reasoningSeen.has(raw.id)) {
            reasoningSeen.add(raw.id);
            const encryptedContent = typeof raw.encrypted_content === "string" && raw.encrypted_content ? raw.encrypted_content : undefined;
            const text = joinSummary(raw.summary);
            // A Codex that sends summaries only when the item completes would otherwise leave the
            // thinking pane empty; once any delta has streamed, the deltas are the display.
            if (text && !thinking) { thinking = true; yield { type: "thinking_delta", text }; }
            // Replaying the item is what keeps the model from starting its reasoning over after a tool call.
            if (text || encryptedContent) yield { type: "thinking_block", text, encryptedContent, reasoningItemId: raw.id };
          } else if (raw?.type === "custom_tool_call" && request.hostedSearch && typeof raw.call_id === "string" && !replayedCalls.has(raw.call_id) && isCodexSearchCell(raw.input)) {
            searchCells.set(raw.call_id, { type: "custom_tool_call", call_id: raw.call_id, name: raw.name, input: raw.input });
          } else if (raw?.type === "custom_tool_call_output" && typeof raw.call_id === "string" && searchCells.has(raw.call_id)) {
            // Without this pair the next round's fresh thread has the model's answer but not what
            // it read, and a code-mode model searches again for what it already found.
            const cell = searchCells.get(raw.call_id)!;
            searchCells.delete(raw.call_id);
            yield { type: "provider_native_block", block: { type: "provider_native", provider: "codex", block: cell } };
            yield { type: "provider_native_block", block: { type: "provider_native", provider: "codex", block: { type: "custom_tool_call_output", call_id: raw.call_id, output: raw.output } } };
          }
        } else if (message.method === "item/completed" && (p.item as { type?: string } | undefined)?.type === "webSearch") {
          const item = p.item as { id?: unknown; query?: unknown; action?: { query?: unknown; queries?: unknown } | null; results?: unknown };
          const query = typeof item.query === "string" && item.query ? item.query
            : typeof item.action?.query === "string" ? item.action.query
            : Array.isArray(item.action?.queries) ? item.action.queries.filter((q): q is string => typeof q === "string").join("; ") : "";
          yield { type: "hosted_search", id: String(item.id ?? `codex-search-${Date.now()}`), query, results: codexSearchResults(item.results) };
        } else if (message.method === "model/rerouted") {
          yield { type: "notice", level: "warn", message: `ChatGPT answered with ${String(p.toModel ?? "another model")} instead of ${String(p.fromModel ?? "the selected model")}${p.reason === "highRiskCyberActivity" ? " because the request was flagged as high-risk cyber activity" : ""}.` };
        } else if (message.method === "warning") {
          if (typeof p.message === "string" && p.message) yield { type: "notice", level: "warn", message: p.message };
        } else if (message.method === "error") {
          const detail = (p.error as { message?: string } | undefined)?.message;
          if (p.willRetry) yield { type: "provider_activity", phase: "retrying", message: `ChatGPT is retrying${detail ? `: ${detail}` : ""}` };
        } else if (message.method === "item/tool/call") {
          const name = String(p.tool ?? "").replace(/^blacksite_/, "");
          if (!request.tools.some((tool) => tool.name === name)) throw new Error("Codex requested an unavailable Blacksite tool.");
          const input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Codex returned invalid tool arguments.");
          if (typeof p.callId !== "string" || !p.callId) throw new Error("Codex returned an invalid tool call ID.");
          call = { type: "tool_use", id: String(p.callId), name, input: input as Record<string, unknown> };
        } else if (message.method === "turn/completed") {
          const final = p.turn as { status: string; error?: { message?: string; codexErrorInfo?: unknown } };
          if (final.status !== "completed") throw turnFailure(final.error);
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
    for await (const event of this.stream({ model, systemPrompt, messages, tools: [], signal, utility: true })) if (event.type === "text_delta") text += event.text;
    return text;
  }

  dispose(): void { this.disposed = true; this.accountVersion++; this.rpc.dispose(); }
}
