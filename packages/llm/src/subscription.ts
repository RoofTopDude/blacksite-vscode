/*
  A subscription route: a model reached through a signed-in app (ChatGPT through Codex) rather
  than an API key. The app owns the conversation's wire format, so it takes a simpler request; this
  module maps a ModelRequest onto it and wraps the app's stream as a ModelTransport.
*/
import type { ModelTransport } from "./client.js";
import { normalizeForProvider } from "./history.js";
import type { ModelRequest } from "./transport/request.js";
import type {
  AgentMessage,
  HostedSearchPolicy,
  HostedSearchRoute,
  OpenAIServiceTier,
  ProviderTurnStreamEvent,
} from "./types.js";

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
  /** The app's own web search, when it is on for this chat. */
  hostedSearch?: HostedSearchPolicy;
  /** Identifies the conversation this round belongs to. Rounds that share one reuse a live Codex
   *  thread while it still matches the transcript. Absent for one-shot helper calls. */
  conversationId?: string;
  /** The volatile workspace block. Kept apart from `messages` so it is never mistaken for part of
   *  the conversation the thread has to agree with. */
  contextTail?: string;
}
export type SubscriptionStream = (request: SubscriptionRequest) => AsyncGenerator<ProviderTurnStreamEvent>;

export interface SubscriptionTransportOptions {
  reasoningEffort?: string;
  /** The session's tier setting; mapped to the app's names ("fast"/"priority" → "priority"). */
  serviceTier?: OpenAIServiceTier;
}

/** The ChatGPT route's name for its own web search. */
export const CHATGPT_HOSTED_SEARCH_ROUTE: HostedSearchRoute = { provider: "chatgpt", label: "ChatGPT" };

/** Map one model turn onto the subscription app's request shape. */
export function toSubscriptionRequest(req: ModelRequest, options: SubscriptionTransportOptions, signal?: AbortSignal): SubscriptionRequest {
  const hosted = req.hostedSearch;
  return {
    model: req.model,
    systemPrompt: req.systemSummary
      ? `${req.system}\n\n[COMPRESSED CONVERSATION HISTORY]\n${req.systemSummary}`
      : req.system,
    // The workspace block travels apart from the conversation: the service decides whether it
    // is sent at all, because every copy it sends stays in a reused thread.
    messages: normalizeForProvider(req.messages),
    ...(req.contextTail ? { contextTail: req.contextTail } : {}),
    conversationId: req.conversationId,
    tools: req.tools.wire,
    ...(hosted ? { hostedSearch: { scope: hosted.scope, allowedDomains: hosted.allowedDomains, deniedDomains: hosted.deniedDomains } } : {}),
    signal,
    reasoningEffort: options.reasoningEffort,
    // Codex names the tiers "priority" (Fast) and "default" (Standard); anything else
    // leaves the account's own default in charge.
    serviceTier: options.serviceTier === "fast" || options.serviceTier === "priority" ? "priority"
      : options.serviceTier === "default" ? "default" : undefined,
  };
}

/** Wrap a subscription app's stream as a ModelTransport. */
export function subscriptionTransport(stream: SubscriptionStream, options: SubscriptionTransportOptions = {}): ModelTransport {
  return {
    hostedSearchRoute: CHATGPT_HOSTED_SEARCH_ROUTE,
    stream: (req, signal) => stream(toSubscriptionRequest(req, options, signal)),
  };
}
