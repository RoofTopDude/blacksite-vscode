import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AgentMessage, ContentBlock, ImageBlock, ProviderTurnStreamEvent, ToolResultBlock } from "./agent-loop-contract.js";
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
  /** Identifies the conversation this round belongs to. Rounds that share one reuse a live Codex
   *  thread while it still matches the transcript. Absent for one-shot helper calls. */
  conversationId?: string;
  /** The volatile workspace block. Kept apart from `messages` so it is never mistaken for part of
   *  the conversation the thread has to agree with. */
  contextTail?: string;
}
export type SubscriptionStream = (request: SubscriptionRequest) => AsyncGenerator<ProviderTurnStreamEvent>;

/** How much of the model's reasoning Codex is asked to summarize. Without a request the
 *  server sends none at all (every catalog model defaults to "none"). */
export type ReasoningSummaryMode = "auto" | "concise" | "detailed" | "none";
/** How long ChatGPT answers run. "default" sends nothing and leaves each model's own default, which
 *  is "low" for every model in the catalog. */
export type ChatGptVerbosity = "default" | "low" | "medium" | "high";
export interface ChatGptOptions {
  reasoningSummary: ReasoningSummaryMode;
  /** Ask Codex for the model's largest context window instead of its 272K default. */
  extendedContext: boolean;
  /** Keep one Codex thread per conversation instead of seeding a new one for every model call. */
  reuseConversation: boolean;
  verbosity: ChatGptVerbosity;
}
export const DEFAULT_CHATGPT_OPTIONS: ChatGptOptions = { reasoningSummary: "detailed", extendedContext: false, reuseConversation: true, verbosity: "medium" };

const CONTINUE_TEXT = "Continue from the conversation above. Respond to the latest user request or tool results.";
/** Live threads kept at once; the least recently used idle one makes room for a new one. */
const MAX_LIVE_THREADS = 6;
/** An idle conversation's thread is released after this long. */
const IDLE_THREAD_MS = 30 * 60_000;
/** A turn parked on a tool call waits on a person's approval, so it is held longer. */
const PARKED_TURN_MS = 60 * 60_000;
/** The account is re-verified at most this often between rounds. */
const ACCOUNT_CHECK_MS = 5 * 60_000;
/** Usage and plan limits are re-read at most this often; Codex also pushes changes as they happen. */
const REFRESH_MS = 90_000;

interface PendingCall { requestId: number | string; callId: string; name: string; input: Record<string, unknown> }
/** What one round has seen so far. */
interface RoundState {
  text: string;
  thinking: boolean;
  completed: boolean;
  calls: PendingCall[];
  reasoningSeen: Set<string>;
  replayedCalls: Set<string>;
  searchCells: Map<string, Record<string, unknown>>;
}
interface Totals { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
const ZERO_TOTALS: Totals = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
/** How the next round continues a live thread. */
type ResumeStep =
  | { kind: "turn"; input: Array<Record<string, unknown>> }
  | { kind: "results"; results: Map<string, ToolResultBlock>; images: ImageBlock[] };
/** One conversation's Codex thread, kept between rounds. */
interface LiveThread {
  key: string;
  threadId: string;
  /** Thread-level inputs the thread was started with; a change needs a new thread. */
  signature: string;
  queue: CodexMessage[];
  wake?: () => void;
  failure?: Error;
  dead: boolean;
  busy: boolean;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  turnId?: string;
  /** A turn is in progress on the thread: streaming, or parked on tool calls. */
  running?: boolean;
  /** The turn is parked on these tool calls, waiting for their results. */
  open?: { turnId: string; calls: PendingCall[] };
  /** How many transcript messages this thread was seeded with, their digest, and a digest of the
   *  assistant message the last round produced. All three must still match to continue it. */
  synced: number;
  fingerprint: string;
  emitted: string;
  /** Token totals as of the last round, so each round reports only what it spent. */
  reported: Totals;
  latest: Totals;
  contextSent?: string;
  unsubscribe: () => void;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const textInput = (text: string): Record<string, unknown> => ({ type: "text", text, text_elements: [] });
function userBlocks(message: AgentMessage): ContentBlock[] {
  if (typeof message.content !== "string") return message.content;
  return message.content ? [{ type: "text", text: message.content }] : [];
}
/** A user message as a Codex turn input, with the workspace block after it when one is due. */
function promptInput(message: AgentMessage, tail?: string): Array<Record<string, unknown>> {
  const blocks = userBlocks(message);
  const images = blocks.filter((block): block is ImageBlock => block.type === "image")
    .map((image) => ({ type: "image", url: `data:${image.source.media_type};base64,${image.source.data}` }));
  const text = blocks.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
  const input = [...images, ...(text ? [textInput(text)] : []), ...(tail ? [textInput(tail)] : [])];
  return input.length ? input : [textInput(CONTINUE_TEXT)];
}
function emittedDigest(text: string, callIds: string[]): string { return sha(JSON.stringify([text, callIds])); }
function assistantDigest(message: AgentMessage): string {
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content } as ContentBlock] : message.content;
  return emittedDigest(
    blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    blocks.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])),
  );
}
/** Blacksite tool results are JSON strings; one that says `ok: false` is a failed call to Codex. */
function toolSucceeded(content: string): boolean {
  try { return (JSON.parse(content) as { ok?: unknown } | null)?.ok !== false; } catch { return true; }
}

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
  /** Live Codex threads by conversation id. */
  private live = new Map<string, LiveThread>();
  private accountVerifiedAt = 0;
  private lastRefreshAt = 0;

  constructor(
    private readonly rpc: CodexAppServer,
    private readonly home: string,
    private readonly changed: (state: ChatGptState) => void,
    private readonly openExternal: (url: string) => Promise<boolean>,
    private readonly options: () => ChatGptOptions = () => DEFAULT_CHATGPT_OPTIONS,
  ) {
    rpc.subscribe((message) => this.accountEvent(message), () => {
      this.accountVerifiedAt = 0;
      this.discardAllLive();
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
      this.accountVerifiedAt = 0;
      this.discardAllLive();
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
    this.lastRefreshAt = Date.now();
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

  /** `cached` skips the account read when it was done recently: a long tool loop made one for every
   *  model call, and sign-out is announced by Codex as it happens (see accountEvent). */
  async requireAccount(cached = false): Promise<void> {
    await this.ready();
    if (cached && Date.now() - this.accountVerifiedAt < ACCOUNT_CHECK_MS) return;
    const result = await this.rpc.request<{ account: { type: string } | null }>("account/read", { refreshToken: false });
    if (result.account?.type !== "chatgpt") { this.accountVerifiedAt = 0; throw new Error("Sign in with ChatGPT in Blacksite Settings > Model to use your subscription."); }
    this.accountVerifiedAt = Date.now();
  }

  private refreshSoon(): void {
    if (Date.now() - this.lastRefreshAt < REFRESH_MS) return;
    void this.refresh();
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
    this.accountVerifiedAt = 0;
    this.discardAllLive();
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

  /**
   * One model round. With a conversation id the round runs on that conversation's live Codex
   * thread: a tool call is left pending inside the open turn and answered with its result on the
   * next round, so the model keeps its own state (reasoning, cache) instead of being re-seeded
   * from the transcript every time. Anything that makes the thread disagree with Blacksite's
   * transcript (compaction, an edit, a changed tool list, a steer) starts a fresh thread seeded
   * from the transcript, which is also how every round used to run.
   *
   * Reasoning state is captured from the raw response stream and replayed on a fresh thread. If
   * Codex refuses that replay before producing anything, the round is retried once with the plain
   * transcript, so continuity can only ever improve a request, never fail one.
   */
  async *stream(request: SubscriptionRequest): AsyncGenerator<ProviderTurnStreamEvent> {
    request.signal?.throwIfAborted();
    await this.requireAccount(true);
    const info = await this.modelInfo(request.model);
    const continuity = !request.utility && Date.now() >= this.continuityPausedUntil;
    const carried = continuity && toCodexInputItems(request.messages, true).some((item) => item.type === "reasoning" || item.type === "custom_tool_call");
    const key = !request.utility && this.options().reuseConversation ? request.conversationId : undefined;
    const produces = (event: ProviderTurnStreamEvent) => event.type === "text_delta" || event.type === "thinking_delta" || event.type === "thinking_block" || event.type === "tool_use_block";

    if (key) {
      const plans: Array<{ reuse: boolean; continuity: boolean }> = [{ reuse: true, continuity }];
      if (this.live.has(key)) plans.push({ reuse: false, continuity });
      if (carried) plans.push({ reuse: false, continuity: false });
      for (let attempt = 0; attempt < plans.length; attempt++) {
        let produced = false;
        try {
          for await (const event of this.liveRound(request, info, key, plans[attempt]!)) {
            if (produces(event)) produced = true;
            yield event;
          }
          return;
        } catch (error) {
          await this.discardLive(key);
          const next = plans[attempt + 1];
          if (!next || produced || request.signal?.aborted || isAbortError(error) || (error instanceof CodexTurnError && FINAL_FAILURES.has(error.kind))) throw error;
          if (!next.continuity && plans[attempt]!.continuity) {
            this.continuityPausedUntil = Date.now() + 10 * 60_000;
            yield { type: "notice", level: "info", message: "ChatGPT did not accept the earlier reasoning state; continuing without it." };
          }
        }
      }
      return;
    }

    const history = request.contextTail ? [...request.messages, { role: "user" as const, content: request.contextTail }] : request.messages;
    let produced = false;
    try {
      for await (const event of this.round(request, info, toCodexInputItems(history, continuity))) {
        if (produces(event)) produced = true;
        yield event;
      }
    } catch (error) {
      if (!carried || produced || request.signal?.aborted || isAbortError(error) || (error instanceof CodexTurnError && FINAL_FAILURES.has(error.kind))) throw error;
      this.continuityPausedUntil = Date.now() + 10 * 60_000;
      yield { type: "notice", level: "info", message: "ChatGPT did not accept the earlier reasoning state; continuing without it." };
      yield* this.round(request, info, toCodexInputItems(history, false));
    }
  }

  /** Forget a conversation's live thread (its chat was reset). Safe to call for an unknown id. */
  releaseConversation(id: string): void { void this.discardLive(id); }

  private async discardLive(key: string): Promise<void> {
    const thread = this.live.get(key);
    if (!thread) return;
    this.live.delete(key);
    thread.dead = true;
    if (thread.idleTimer) clearTimeout(thread.idleTimer);
    thread.unsubscribe();
    this.activeTurns.delete(thread.threadId);
    if (thread.running && thread.turnId) await this.rpc.request("turn/interrupt", { threadId: thread.threadId, turnId: thread.turnId }).catch(() => {});
    await this.rpc.request("thread/unsubscribe", { threadId: thread.threadId }).catch(() => {});
  }

  private discardAllLive(): void {
    for (const key of [...this.live.keys()]) void this.discardLive(key);
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

  /** Everything fixed when a thread starts: tools, instructions, and the settings Codex reads from
   *  thread config. A change to any of it needs a new thread (see threadSignature). */
  private threadParams(request: SubscriptionRequest): Record<string, unknown> {
    const options = this.options();
    const tools = request.tools.map((tool) => ({ type: "function", name: `blacksite_${tool.name}`, description: tool.description, inputSchema: tool.input_schema }));
    const config: Record<string, unknown> = {
      "features.shell_tool": false, "features.unified_exec": false, "features.apps": false, "features.multi_agent": false, project_doc_max_bytes: 0,
      // Codex's own search stays off unless the user turned it on for this chat; a helper call
      // never searches.
      ...codexWebSearchConfig(request.utility ? undefined : request.hostedSearch),
    };
    if (!request.utility) {
      // The summary is requested again when each turn starts. A thread that carries it as well
      // returned summaries on turns where the turn-level request alone returned none.
      if (options.reasoningSummary !== "none" && !this.summaryRejected.has(request.model)) config["model_reasoning_summary"] = options.reasoningSummary;
      if (options.verbosity !== "default") config["model_verbosity"] = options.verbosity;
      if (options.extendedContext) config.model_context_window = CODEX_EXTENDED_WINDOW;
    }
    return {
      model: request.model || null, modelProvider: "openai", ephemeral: true,
      cwd: this.home, environments: [], sandbox: "read-only", approvalPolicy: "never",
      baseInstructions: request.systemPrompt,
      developerInstructions: config["web_search"] === "cached"
        ? "Use only the blacksite_ tools and web search. Blacksite executes the blacksite_ tools and owns the conversation history."
        : "Use only the blacksite_ tools. Blacksite executes tools and owns the conversation history.",
      dynamicTools: tools,
      ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
      config,
    };
  }

  /** Fingerprint of the thread-level inputs. A live thread is reused only while this is unchanged. */
  private threadSignature(request: SubscriptionRequest): string {
    const options = this.options();
    return sha(JSON.stringify([request.model, request.systemPrompt, request.tools, request.hostedSearch ?? null, request.serviceTier ?? null, options.extendedContext, options.reasoningSummary, options.verbosity, this.summaryRejected.has(request.model)]));
  }

  private turnParams(request: SubscriptionRequest, info: ModelInfo | undefined, threadId: string, input: Array<Record<string, unknown>>, withSummary: boolean): Record<string, unknown> {
    const effort = resolveCodexEffort(request.utility ? "low" : request.reasoningEffort, info?.reasoningEfforts);
    const summary = request.utility ? "none" : this.summaryRejected.has(request.model) ? undefined : this.options().reasoningSummary;
    return { threadId, input, ...(effort ? { effort } : {}), ...(withSummary && summary ? { summary } : {}) };
  }

  private async startTurn(request: SubscriptionRequest, info: ModelInfo | undefined, threadId: string, input: Array<Record<string, unknown>>): Promise<{ turn: { id: string } }> {
    try { return await this.rpc.request<{ turn: { id: string } }>("turn/start", this.turnParams(request, info, threadId, input, true)); } catch (error) {
      const summary = this.options().reasoningSummary;
      // A model that cannot summarize its reasoning should still answer.
      if (request.utility || summary === "none" || !/summary/i.test(error instanceof Error ? error.message : String(error))) throw error;
      this.summaryRejected.add(request.model);
      return this.rpc.request<{ turn: { id: string } }>("turn/start", this.turnParams(request, info, threadId, input, false));
    }
  }

  /**
   * Turn one Codex notification into Blacksite stream events, recording tool calls and the end of
   * the turn in `state`. Shared by the one-shot round and the live thread so the two cannot drift.
   */
  private *translate(message: CodexMessage, request: SubscriptionRequest, state: RoundState): Generator<ProviderTurnStreamEvent> {
    const p = message.params ?? {};
    if (message.method === "item/agentMessage/delta") {
      const text = String(p.delta ?? "");
      state.text += text;
      yield { type: "text_delta", text };
    } else if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      const text = String(p.delta ?? "");
      if (text) { state.thinking = true; yield { type: "thinking_delta", text }; }
    } else if (message.method === "item/reasoning/summaryPartAdded") {
      // Each summary part is its own titled paragraph; without a break they run together.
      if (state.thinking) yield { type: "thinking_delta", text: "\n\n" };
    } else if (message.method === "rawResponseItem/completed") {
      const raw = p.item as { type?: string; id?: unknown; summary?: unknown; encrypted_content?: unknown; call_id?: unknown; name?: unknown; input?: unknown; output?: unknown } | undefined;
      if (raw?.type === "reasoning" && typeof raw.id === "string" && !state.reasoningSeen.has(raw.id)) {
        state.reasoningSeen.add(raw.id);
        const encryptedContent = typeof raw.encrypted_content === "string" && raw.encrypted_content ? raw.encrypted_content : undefined;
        const text = joinSummary(raw.summary);
        // A Codex that sends summaries only when the item completes would otherwise leave the
        // thinking pane empty; once any delta has streamed, the deltas are the display.
        if (text && !state.thinking) { state.thinking = true; yield { type: "thinking_delta", text }; }
        // Replaying the item is what keeps the model from starting its reasoning over after a tool call.
        if (text || encryptedContent) yield { type: "thinking_block", text, encryptedContent, reasoningItemId: raw.id };
      } else if (raw?.type === "custom_tool_call" && request.hostedSearch && typeof raw.call_id === "string" && !state.replayedCalls.has(raw.call_id) && isCodexSearchCell(raw.input)) {
        state.searchCells.set(raw.call_id, { type: "custom_tool_call", call_id: raw.call_id, name: raw.name, input: raw.input });
      } else if (raw?.type === "custom_tool_call_output" && typeof raw.call_id === "string" && state.searchCells.has(raw.call_id)) {
        // Without this pair the next round's fresh thread has the model's answer but not what
        // it read, and a code-mode model searches again for what it already found.
        const cell = state.searchCells.get(raw.call_id)!;
        state.searchCells.delete(raw.call_id);
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
      if (message.id === undefined) throw new Error("Codex sent a tool call without a request ID.");
      state.calls.push({ requestId: message.id, callId: p.callId, name, input: input as Record<string, unknown> });
    } else if (message.method === "turn/completed") {
      const final = p.turn as { status: string; error?: { message?: string; codexErrorInfo?: unknown } };
      if (final.status !== "completed") throw turnFailure(final.error);
      state.completed = true;
    }
  }

  private newState(request: SubscriptionRequest): RoundState {
    const state: RoundState = { text: "", thinking: false, completed: false, calls: [], reasoningSeen: new Set(), replayedCalls: new Set(), searchCells: new Map() };
    // Codex echoes injected history back as rawResponseItem/completed events. Those items are
    // already in the transcript; recording them again would replay every earlier search twice
    // the next round, and twice more the round after.
    for (const message of request.messages) {
      if (typeof message.content === "string") continue;
      for (const block of message.content) {
        if (block.type === "thinking" && block.reasoningItemId) state.reasoningSeen.add(block.reasoningItemId);
        if (block.type === "provider_native" && block.provider === "codex" && typeof block.block["call_id"] === "string") state.replayedCalls.add(block.block["call_id"]);
      }
    }
    return state;
  }

  /** A turn that reasoned but returned no summary would otherwise look like a model that did not
   *  think. Say what happened, once per round, instead of leaving the thinking pane blank. */
  private silentReasoning(state: RoundState, reasoningTokens: number): ProviderTurnStreamEvent | undefined {
    if (reasoningTokens <= 0 || state.thinking || this.options().reasoningSummary === "none") return undefined;
    return { type: "thinking_delta", text: `Reasoned for ${reasoningTokens.toLocaleString("en-US")} tokens. ChatGPT sent no summary of it for this step.` };
  }

  // ── Live thread ────────────────────────────────────────────────────────────

  private async *liveRound(request: SubscriptionRequest, info: ModelInfo | undefined, key: string, plan: { reuse: boolean; continuity: boolean }): AsyncGenerator<ProviderTurnStreamEvent> {
    const signature = this.threadSignature(request);
    let thread = plan.reuse ? this.live.get(key) : undefined;
    let step: ResumeStep | undefined;
    if (thread) {
      step = this.planResume(thread, request, signature);
      if (!step) { await this.discardLive(key); thread = undefined; }
    } else if (this.live.has(key)) await this.discardLive(key);

    if (!thread) {
      thread = await this.openLive(request, key, signature);
      step = await this.seedLive(thread, request, plan.continuity);
    }
    const live = thread;
    live.busy = true;
    if (live.idleTimer) { clearTimeout(live.idleTimer); live.idleTimer = undefined; }
    this.touch(live);

    const state = this.newState(request);
    const started = live.reported;
    const abort = () => { live.failure = new Error("ChatGPT request cancelled."); live.failure.name = "AbortError"; live.wake?.(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => { live.failure = new Error("ChatGPT response timed out. Retry the request."); live.wake?.(); }, 10 * 60_000);
    let settled = false;
    try {
      request.signal?.throwIfAborted();
      if (live.failure) throw live.failure;
      if (step!.kind === "results") {
        const open = live.open!;
        live.open = undefined;
        open.calls.forEach((call, index) => {
          const result = step!.kind === "results" ? step!.results.get(call.callId)! : undefined;
          const images = index === open.calls.length - 1 && step!.kind === "results" ? step!.images : [];
          this.rpc.respond(call.requestId, { contentItems: [{ type: "inputText", text: result!.content }, ...images.map((image) => ({ type: "inputImage", imageUrl: `data:${image.source.media_type};base64,${image.source.data}` }))], success: toolSucceeded(result!.content) });
        });
      } else {
        live.queue.length = 0; // anything left over belongs to the turn that already finished
        const turn = await this.startTurn(request, info, live.threadId, step!.input);
        live.turnId = turn.turn.id;
        live.running = true;
        this.activeTurns.set(live.threadId, live.turnId);
      }
      while (!state.completed) {
        const message = await this.take(live, state.calls.length ? 250 : undefined);
        if (!message) break; // calls arrive together; a quiet moment means the batch is complete
        yield* this.translate(message, request, state);
      }
      const totals = live.latest;
      const spent = { input: totals.inputTokens - started.inputTokens, cached: totals.cachedInputTokens - started.cachedInputTokens, written: totals.cacheWriteInputTokens - started.cacheWriteInputTokens, output: totals.outputTokens - started.outputTokens, reasoning: totals.reasoningOutputTokens - started.reasoningOutputTokens };
      live.reported = { ...totals };
      const silent = this.silentReasoning(state, spent.reasoning);
      if (silent) yield silent;
      if (spent.input > 0 || spent.output > 0) yield { type: "usage_update", inputTokens: Math.max(0, spent.input - spent.cached - spent.written), outputTokens: spent.output, cacheReadTokens: spent.cached, cacheWriteTokens: spent.written };
      // What the next round must find in the transcript for this thread to still be the right one.
      live.synced = request.messages.length;
      live.fingerprint = sha(JSON.stringify(request.messages));
      live.emitted = emittedDigest(state.text, state.calls.map((call) => call.callId));
      if (state.calls.length) {
        live.open = { turnId: live.turnId!, calls: state.calls };
        for (const call of state.calls) yield { type: "tool_use_block", block: { type: "tool_use", id: call.callId, name: call.name, input: call.input } };
        yield { type: "stop_reason", reason: "tool_use" };
      } else {
        live.open = undefined;
        live.running = false;
        this.activeTurns.delete(live.threadId);
        yield { type: "stop_reason", reason: "end_turn" };
        this.refreshSoon();
      }
      settled = true;
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", abort);
      live.busy = false;
      if (settled) this.armIdle(key, live);
      else await this.discardLive(key);
    }
  }

  /** Start a Codex thread for a conversation and subscribe to everything it sends. */
  private async openLive(request: SubscriptionRequest, key: string, signature: string): Promise<LiveThread> {
    // Room for this thread: drop the least recently used idle one rather than grow without bound.
    while (this.live.size >= MAX_LIVE_THREADS) {
      const oldest = [...this.live.values()].filter((t) => !t.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      await this.discardLive(oldest.key);
    }
    const result = await this.startThread(this.threadParams(request), this.rawEvents);
    const live: LiveThread = {
      key, threadId: result.thread.id, signature, queue: [], dead: false, busy: false, lastUsed: Date.now(),
      synced: 0, fingerprint: "", emitted: "", reported: { ...ZERO_TOTALS }, latest: { ...ZERO_TOTALS },
      unsubscribe: () => {},
    };
    live.unsubscribe = this.rpc.subscribe((message) => {
      if (message.params?.threadId !== live.threadId) return;
      if (message.method === "thread/tokenUsage/updated") {
        const tokenUsage = message.params.tokenUsage as { total?: Totals; modelContextWindow?: number | null } | undefined;
        if (tokenUsage?.total) live.latest = { ...ZERO_TOTALS, ...tokenUsage.total };
        const extended = this.options().extendedContext;
        if (tokenUsage?.modelContextWindow) this.observedWindows.set(`${request.model}|${extended}`, tokenUsage.modelContextWindow);
      }
      live.queue.push(message);
      live.wake?.();
    }, (error) => { live.failure = error; live.dead = true; live.wake?.(); });
    this.live.set(key, live);
    return live;
  }

  /** Put a new live thread in the state the transcript describes, and decide what starts its turn. */
  private async seedLive(live: LiveThread, request: SubscriptionRequest, continuity: boolean): Promise<ResumeStep> {
    const messages = request.messages;
    const last = messages[messages.length - 1];
    const prompt = last && last.role === "user" && !userBlocks(last).some((block) => block.type === "tool_result");
    const items = toCodexInputItems(prompt ? messages.slice(0, -1) : messages, continuity);
    if (items.length) await this.rpc.request("thread/inject_items", { threadId: live.threadId, items });
    const input = prompt ? promptInput(last!, request.contextTail) : [textInput(CONTINUE_TEXT), ...(request.contextTail ? [textInput(request.contextTail)] : [])];
    live.contextSent = request.contextTail ?? "";
    return { kind: "turn", input };
  }

  /** What to do with an existing live thread, or undefined when it no longer matches the transcript. */
  private planResume(live: LiveThread, request: SubscriptionRequest, signature: string): ResumeStep | undefined {
    if (live.dead || live.busy || live.failure || live.signature !== signature) return undefined;
    const messages = request.messages;
    if (messages.length < live.synced + 2) return undefined;
    if (sha(JSON.stringify(messages.slice(0, live.synced))) !== live.fingerprint) return undefined;
    const assistant = messages[live.synced]!;
    if (assistant.role !== "assistant" || assistantDigest(assistant) !== live.emitted) return undefined;
    const rest = messages.slice(live.synced + 1);
    if (rest.length !== 1 || rest[0]!.role !== "user") return undefined;
    const user = rest[0]!;
    const blocks = userBlocks(user);
    const results = blocks.filter((block): block is ToolResultBlock => block.type === "tool_result");
    const hasText = blocks.some((block) => block.type === "text" && block.text.trim());
    const images = blocks.filter((block): block is ImageBlock => block.type === "image");
    if (live.open) {
      // Anything beyond the answers to the open calls (a steer, a stray result) cannot be delivered
      // into a turn that is waiting on tool output.
      if (hasText || results.length !== live.open.calls.length) return undefined;
      const byId = new Map(results.map((result) => [result.tool_use_id, result]));
      if (!live.open.calls.every((call) => byId.has(call.callId))) return undefined;
      return { kind: "results", results: byId, images };
    }
    if (results.length || (!hasText && !images.length)) return undefined;
    // The workspace block rides along only when it changed: every copy stays in the thread.
    const tail = request.contextTail && request.contextTail !== live.contextSent ? request.contextTail : undefined;
    if (tail) live.contextSent = tail;
    return { kind: "turn", input: promptInput(user, tail) };
  }

  /** The next notification for a live thread. With `quietMs`, resolves undefined once that long
   *  passes with nothing new; without it, waits as long as the round's deadline allows. */
  private async take(live: LiveThread, quietMs?: number): Promise<CodexMessage | undefined> {
    for (;;) {
      if (live.failure) throw live.failure;
      const message = live.queue.shift();
      if (message) return message;
      const woke = await new Promise<boolean>((resolve) => {
        const timer = quietMs === undefined ? undefined : setTimeout(() => { live.wake = undefined; resolve(false); }, quietMs);
        live.wake = () => { if (timer) clearTimeout(timer); live.wake = undefined; resolve(true); };
      });
      if (!woke) return undefined;
    }
  }

  private touch(live: LiveThread): void { live.lastUsed = Date.now(); }

  private armIdle(key: string, live: LiveThread): void {
    if (live.dead) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    // A turn parked on a tool the user has not approved yet is waiting on a person, so it gets
    // longer than an idle conversation; both are released rather than held forever.
    live.idleTimer = setTimeout(() => { void this.discardLive(key); }, live.open ? PARKED_TURN_MS : IDLE_THREAD_MS);
    live.idleTimer.unref?.();
  }

  // ── One-shot round (helper calls, and conversation reuse turned off) ──────

  private async *round(request: SubscriptionRequest, info: ModelInfo | undefined, items: Array<Record<string, unknown>>): AsyncGenerator<ProviderTurnStreamEvent> {
    const result = await this.startThread(this.threadParams(request), this.rawEvents && !request.utility);
    const threadId = result.thread.id;
    // Only a thread that asked for the larger window can report it; a helper call never does.
    const extendedApplied = this.options().extendedContext && !request.utility;
    const queue: CodexMessage[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let turnId: string | undefined;
    const state = this.newState(request);
    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number } | undefined;
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
      const turn = await this.startTurn(request, info, threadId, [textInput(CONTINUE_TEXT)]);
      turnId = turn.turn.id;
      this.activeTurns.set(threadId, turnId);
      while (!state.completed && !state.calls.length) {
        if (failure) throw failure;
        const message = queue.shift();
        if (!message) { await new Promise<void>((resolve) => { wake = resolve; }); continue; }
        yield* this.translate(message, request, state);
      }
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      if (turnId && !state.completed) await this.rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      this.activeTurns.delete(threadId);
      await this.rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
      unsubscribe();
      this.refreshSoon();
    }
    request.signal?.throwIfAborted();
    const silent = this.silentReasoning(state, usage?.reasoningOutputTokens ?? 0);
    if (silent) yield silent;
    if (usage) yield { type: "usage_update", inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens - (usage.cacheWriteInputTokens ?? 0)), outputTokens: usage.outputTokens, cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens ?? 0 };
    const call = state.calls[0];
    if (call) yield { type: "tool_use_block", block: { type: "tool_use", id: call.callId, name: call.name, input: call.input } };
    yield { type: "stop_reason", reason: call ? "tool_use" : "end_turn" };
  }

  async text(model: string, systemPrompt: string, messages: AgentMessage[], signal?: AbortSignal): Promise<string> {
    let text = "";
    for await (const event of this.stream({ model, systemPrompt, messages, tools: [], signal, utility: true })) if (event.type === "text_delta") text += event.text;
    return text;
  }

  dispose(): void { this.disposed = true; this.accountVersion++; this.discardAllLive(); this.rpc.dispose(); }
}
