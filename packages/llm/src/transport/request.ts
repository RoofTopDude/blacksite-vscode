/*
  What a model client is configured with (once per session) and what it is asked for (once per
  turn). The request is plain data: everything a provider route needs to build its wire body, so
  a route never reaches back into the agent that built it.
*/
import type { BedrockCredentials } from "../bedrock-types.js";
import type { OpenAIReasoningEffort } from "../model-limits.js";
import type { RetryPolicy } from "../provider-retry.js";
import type { SamplingKey } from "../sampling-parameters.js";
import type { AnthropicBetaOptions, ThinkingPlan } from "../thinking-plan.js";
import type {
  AgentMessage,
  CacheTtl,
  HostedSearchPolicy,
  HostedSearchRoute,
  OpenAIServiceTier,
  OpenRouterProviderPreferences,
  ProviderName,
  ToolSchema,
} from "../types.js";

/** The endpoint each route posts to when no base URL override is configured. */
export const PROVIDER_BASE_URLS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openaiResponses: "https://api.openai.com/v1/responses",
} as const;

/** Session-lived settings for one provider route. */
export interface ModelClientConfig {
  provider: ProviderName;
  /** Anthropic, OpenAI and OpenRouter key. Unused on Bedrock, which signs with `bedrock`. */
  apiKey?: string;
  /** Overrides the provider's endpoint (a proxy, a gateway, a local server). */
  baseUrl?: string;
  bedrock?: BedrockCredentials;
  bedrockApi?: "converse" | "mantle";
  /** Read per turn: whether Bedrock's newer stop reasons are mapped rather than collapsed. */
  bedrockExtendedStopReasons?: () => boolean;
  /** Route OpenAI reasoning models through the Responses API, which replays reasoning. */
  useResponsesApi?: boolean;
  cacheTtl?: CacheTtl;
  retryPolicy?: RetryPolicy;
  serviceTier?: OpenAIServiceTier;
  reasoningEffort?: OpenAIReasoningEffort;
  /** Sampling controls beyond temperature, filtered to `modelSupportedParameters`. */
  sampling?: Partial<Record<SamplingKey, number | undefined>>;
  modelSupportedParameters?: string[];
  /** OpenRouter attribution headers. */
  httpReferer?: string;
  xTitle?: string;
  openrouterProvider?: OpenRouterProviderPreferences;
  openrouterFallbackModels?: string[];
}

/** The tools one request declares. */
export interface ModelToolPlan {
  /** The definitions to send, in order. */
  wire: ToolSchema[];
  /** Names sent with `defer_loading: true` (Anthropic native tool search only). */
  deferred: ReadonlySet<string>;
  /** tool_search results to expand into `tool_reference` blocks, by tool_use id. */
  references?: ReadonlyMap<string, readonly string[]>;
}

/** One model turn. */
export interface ModelRequest {
  model: string;
  /** The stable system prompt. */
  system: string;
  /** A compressed summary of older history; sent next to the system prompt. Empty for none. */
  systemSummary: string;
  /** The per-request block (workspace state and the like), sent after the cache breakpoints so
   *  the cached prefix survives it changing every turn. Empty for none. */
  contextTail: string;
  /** The conversation. Each route normalizes it for its own wire format. */
  messages: AgentMessage[];
  tools: ModelToolPlan;
  /** max_tokens, thinking and temperature, already reconciled with the model. */
  thinking: ThinkingPlan;
  /** The provider's own web search, when it is on for this request. */
  hostedSearch?: HostedSearchPolicy & HostedSearchRoute;
  /** Expand `tools.references` natively (Anthropic tool search). */
  nativeToolSearch?: boolean;
  /** Stable per conversation: OpenAI's `prompt_cache_key`, and part of synthesized ids. */
  conversationId: string;
  /** Which round of the conversation this is; part of synthesized ids. */
  turnIndex: number;
  /** Opt-in Anthropic features (fast mode, task budgets, context editing, compaction, fallbacks). */
  anthropicBeta?: AnthropicBetaOptions;
}

/** Facts a route learns about its endpoint mid-session and keeps for the rest of it. */
export interface TransportLatches {
  /** The endpoint rejected `strict` tool schemas. */
  strictToolsUnsupported: boolean;
  /** This Bedrock model rejected cache points. */
  bedrockCacheUnsupported: boolean;
  /** This Bedrock model rejected the 1-hour cache TTL. */
  bedrockCacheTtlUnsupported: boolean;
  /** OpenRouter rejected the tool-result cache anchor. */
  openRouterToolCacheRejected: boolean;
}

export function freshLatches(): TransportLatches {
  return {
    strictToolsUnsupported: false,
    bedrockCacheUnsupported: false,
    bedrockCacheTtlUnsupported: false,
    openRouterToolCacheRejected: false,
  };
}

/** What every route function receives alongside the request. */
export interface TransportContext {
  config: ModelClientConfig;
  latches: TransportLatches;
  signal?: AbortSignal;
}

export function makeAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Human-readable backoff delay for a retry notice ("800ms", "3s"). */
export function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
