/* Typed contract for the webview ↔ extension-host postMessage protocol.
   Mirrors the message types handled in src/chat-provider.ts. Keep in sync. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ClaudeEffort } from "../../../thinking-modes.js";
import type { ActiveRequestMode, RequestMode } from "../../../request-modes.js";
import type { SamplingKey } from "../../../sampling-parameters.js";

/** Re-exported so UI code has one import site for the settings types. thinking-modes is a pure
 *  module — the settings panel and the request builder read the same ladder from it. */
export type { ClaudeEffort };
export type { ActiveRequestMode, RequestMode };
export type { SamplingKey };

export type ProviderName = "anthropic" | "openrouter" | "openai" | "bedrock";

export interface ThinkingConfig {
  enabled: boolean;
  /** Fixed token budget — the pre-4.6 Claude dialect. Ignored by adaptive-era models. */
  budgetTokens: number;
  /** Thinking depth — the Claude 4.6+ dialect, which replaced the token budget. Ignored by
   *  budget-era models. Both are persisted so switching models back and forth is lossless. */
  effort?: ClaudeEffort;
}

/** Mirrors the host's OpenAIReasoningEffort (agent-session.ts) — full depth ladder.
 *  "max" (GPT-5.6+) sits above "xhigh"; it is a reasoning depth rung, not "ultra mode"
 *  (a separate multi-agent orchestration feature with no reasoning_effort value). */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Mirrors the host's OpenAIServiceTier (agent-session.ts). "priority" is OpenAI's former name
 *  for "fast", still accepted on the wire and still possible in persisted settings. */
export type ServiceTier = "auto" | "default" | "flex" | "priority" | "fast";

export interface ProviderSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  /** When true, `maxTokens` is ignored and the harness requests the highest output budget
   *  it will ask for — see MAX_ESCALATED_OUTPUT_TOKENS_UNLIMITED in agent-session.ts. Not a
   *  literal absence of limit: a real provider ceiling still applies. */
  maxTokensUnlimited?: boolean;
  thinking?: ThinkingConfig;
  reasoningEffort?: ReasoningEffort;
  /** OpenAI processing tier ("flex" = reduced rates, queued latency). */
  serviceTier?: ServiceTier;
  /** Full endpoint URL override (Azure OpenAI, proxy, local OpenAI-compatible server, …).
   *  Blank/undefined = the provider's canonical endpoint. Ignored by bedrock (region-derived). */
  baseUrl?: string;
  /** Prompt-cache breakpoint TTL ("5m" default or "1h"). */
  cacheTtl?: "5m" | "1h";
  /** Anthropic fast mode (beta, Opus 4.8/4.7 only). */
  fastMode?: boolean;
  /** Task budget (beta) in tokens — Anthropic-direct only. */
  taskBudgetTokens?: number;
  /** Context editing (beta) — Anthropic-direct and Bedrock Mantle. */
  contextEditingEnabled?: boolean;
  /** Server-side refusal fallback (beta) for Claude Fable 5 / Mythos 5. Defaults to on. */
  refusalFallbackEnabled?: boolean;
  /** Server-side compaction (beta) trigger, in input tokens. Undefined/0 disables it.
   *  Anthropic-direct and Bedrock Mantle only. */
  compactionTriggerTokens?: number;
  /** Use the OpenAI Responses API instead of Chat Completions — reasoning continuity across
   *  tool-call turns. Only takes effect for a reasoning model on the openai provider. */
  useResponsesApi?: boolean;
  /** Sampling controls beyond temperature. Only the subset the active model actually
   *  accepts is sent — see SAMPLING_PARAMETERS and ModelInfo.supportedParameters. */
  sampling?: SamplingSettings;
}

/**
 * Sampling controls a model may expose beyond temperature.
 *
 * Which of these exist is per-model, not per-provider: OpenRouter reports the exact set
 * each routed model accepts in `supported_parameters`, and the same catalog row is what
 * gates both the UI and the request body. An unset field is never sent, leaving the
 * model's own default in charge — that is meaningfully different from sending a neutral
 * value, which would override a provider default that isn't neutral.
 */
export interface SamplingSettings {
  /** Nucleus sampling: consider tokens making up the top N of probability mass. */
  topP?: number;
  /** Consider only the K most likely tokens. */
  topK?: number;
  /** Drop tokens below this fraction of the most likely token's probability. */
  minP?: number;
  /** Penalize tokens by how often they have already appeared. */
  frequencyPenalty?: number;
  /** Penalize tokens that have appeared at all, regardless of count. */
  presencePenalty?: number;
  /** Scales down logits of already-seen tokens (multiplicative; 1 = off). */
  repetitionPenalty?: number;
  /** Fixed seed for reproducible sampling, where the routed provider honours it. */
  seed?: number;
}

export interface CompressionSettings {
  enabled: boolean;
  provider?: ProviderName;
  model?: string;
  triggerPct: number;
  keepRecent: number;
}

export interface AgentMemorySettings {
  enabled: boolean;
  similarityThreshold?: number;
}

/** Unified embedding-model configuration for the agent memory index and Data workbench vectors. */
export interface EmbeddingSettings {
  /** Embedding provider — openai/openrouter/bedrock embed directly; voyage is a dedicated
   *  embeddings-only provider (not a chat ProviderName). */
  provider?: ProviderName | "voyage";
  /** Embedding model id (blank = built-in default). */
  model?: string;
  /** Output vector dimensions. Changing this requires a rebuild. */
  dims?: number;
}

/** Optional secondary model used to describe images when the active chat model has no vision support. */
export interface VisionFallbackSettings {
  provider?: ProviderName;
  model?: string;
}

/** OpenAI's speech-to-text endpoint is used as a neutral bridge: every chat provider receives
 * the resulting text, even if its selected model cannot accept raw audio. */
export interface AudioTranscriptionSettings {
  /** Defaults to enabled when an OpenAI key is available. Set false to keep audio as reference-only files. */
  enabled?: boolean;
  /** Transcription model id. Blank uses the fast default, gpt-4o-mini-transcribe. */
  model?: string;
  /** Optional BCP-47 / ISO language hint passed to the transcriber. */
  language?: string;
}

/** OpenRouter-specific request configuration beyond standard provider settings. */
export interface OpenRouterConfig {
  /** HTTP-Referer header sent to OpenRouter. Controls which site is credited for usage. */
  httpReferer?: string;
  /** X-Title header sent to OpenRouter. Displayed in the OpenRouter dashboard. */
  xTitle?: string;
  /** Model fallback list — tried in order if the primary model is unavailable. */
  fallbackModels?: string[];
  /** Provider slugs to try, in order (e.g. ["anthropic", "google-vertex"]). */
  providerOrder?: string[];
  /** When false, only the ordered providers are tried — no silent fallback to others. */
  allowFallbacks?: boolean;
  /** "deny" restricts routing to providers with a zero-data-retention policy. */
  dataCollection?: "allow" | "deny";
  sort?: "price" | "throughput" | "latency";
}

/** A named subagent profile that specializes the delegated lane's focus. */
export interface SubagentProfile {
  id: string;
  name: string;
  description: string;
  /** Extra text appended to the subagent's system prompt when this profile is active. */
  systemPromptAddition?: string;
  /** True for built-in profiles that cannot be deleted. */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Global subagent configuration. */
export interface SubagentSettings {
  /** Override the provider used for all subagent sessions (defaults to parent provider). */
  provider?: ProviderName;
  /** Override the model used for all subagent sessions (defaults to parent model). */
  model?: string;
  /** Maximum number of concurrent parallel subagent lanes per turn. Default: 4. */
  maxConcurrent?: number;
  /** User-defined profiles (builtin profiles are always merged in at runtime). */
  profiles: SubagentProfile[];
}

export interface ExtendedSettings {
  provider: ProviderName;
  providerSettings: Partial<Record<ProviderName, ProviderSettings>>;
  maxIterations: number;
  disabledTools: string[];
  compression?: CompressionSettings | null;
  agentMemory?: AgentMemorySettings;
  /** Unified embedding-model configuration. */
  embedding?: EmbeddingSettings | null;
  /** Optional secondary model for describing images when the active model has no vision support. */
  visionFallback?: VisionFallbackSettings | null;
  /** Cross-provider audio-to-text bridge configuration. Uses the configured OpenAI API key. */
  audioTranscription?: AudioTranscriptionSettings | null;
  /** OpenRouter-specific headers and routing config. */
  openrouterConfig?: OpenRouterConfig;
  /** Global subagent configuration and profile library. */
  subagent?: SubagentSettings;
  /** Selects the Bedrock API path: "converse" (default) or "mantle" (Messages API). */
  bedrockApi?: "converse" | "mantle";
  /** Automatic continuation of an approved plan when a turn ends without finishing it. */
  planContinuation?: PlanContinuationSettings;
}

/**
 * Off by default, and deliberately so: this spends model calls and agent turns with nobody
 * watching. `maxConsecutive` bounds how far it can run before it stops and checks in — the
 * counter resets whenever the user says anything, which is the only reliable evidence a human
 * is still engaged.
 */
export interface PlanContinuationSettings {
  enabled: boolean;
  maxConsecutive: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  inputPricePerM?: number;
  outputPricePerM?: number;
  /** USD per 1M cache-read/write tokens. Currently only populated for OpenRouter models that
      report prompt-caching pricing. */
  cacheReadPricePerM?: number;
  cacheWritePricePerM?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  /** The catalog reports native audio input. Blacksite still normalizes attached audio through
      the transcription bridge so the rest of the agent pipeline remains provider-independent. */
  supportsAudio?: boolean;
  supportsTools?: boolean;
  /** Request parameters the routed model accepts, as reported by the provider catalog
   *  (OpenRouter's `supported_parameters`). Drives which sampling controls the UI offers
   *  and which are actually sent — see SAMPLING_PARAMETERS. Undefined means the provider
   *  publishes no such list, in which case the provider-level defaults apply. */
  supportedParameters?: string[];
  source?: string;
  [k: string]: any;
}

export type KeyStatus = Record<string, boolean>;

export interface MemoryStats {
  toolCalls: number;
  chunks: number;
  memories: number;
  total: number;
}

export interface LogStats {
  /** Turns logged this session. Mirrors ExecutionLogger.stats.turnCount. */
  turnCount?: number;
  [k: string]: any;
}

export interface SessionRuntime {
  sessionId?: string;
  requestMode?: RequestMode;
  activeRequestMode?: ActiveRequestMode;
  contextLength?: number;
  lastInputTokens?: number;
  usagePct?: number | null;
  compressionEnabled?: boolean;
  isCompacting?: boolean;
  compressionCount?: number;
  hasCompressedHistory?: boolean;
  lastCompressedAt?: number;
  lastCompressedMessageCount?: number;
  lastCompressionError?: string;
  lastCompressionTrigger?: string;
  keepRecent?: number;
  activeMessageCount?: number;
  fullMessageCount?: number;
  compressedMessageCount?: number;
  compressibleMessageCount?: number;
}

export interface QCardOption {
  key: string;
  label?: string;
  description?: string;
  /** `mountCss` carries CSS extracted from a mount build's component imports; the host compiles
   *  `mount` into `code` before the option ever reaches the webview. */
  preview?: { html?: string; code?: string; mountCss?: string; height?: number; expandHint?: boolean } | null;
}

export interface QCardQuestion {
  question: string;
  options: QCardOption[];
  context?: string;
  multiSelect?: boolean;
}

export type ApprovalDecision = "allow" | "allow_all" | "allow_always" | "deny";

export interface HistorySession {
  sessionId: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  /** First user message preview from the archived session (set by SessionStore.loadHistory). */
  firstMessage?: string;
  messageCount?: number;
  messages?: ChatMessage[];
  [k: string]: any;
}

export interface ChatMessage {
  role: string;
  content: unknown;
}

/** A file the user has attached to the current conversation (permanently stored, not inlined into context). */
export interface ReferenceAttachmentInfo {
  /** Stable host-side attachment id for this conversation; usually the core_documents id when SQLite is available. */
  id: string;
  name: string;
  byteSize: number;
  /** Best-effort MIME inferred from the source file or supplied by the browser. */
  mime?: string;
  /** Presentation category chosen by the host; all categories remain attachable. */
  kind?: "image" | "audio" | "video" | "document" | "code" | "data" | "archive" | "other";
  /** A concise, honest description of what will happen when this file is sent. */
  handling?: string;
}

export interface TranscriptDocumentData {
  documentId: string;
  markdown?: string;
  error?: string;
}

/** Messages received from the extension host (host → webview). */
export type IncomingMessage =
  | { type: "history_restored"; messages?: ChatMessage[] }
  | { type: "inject_context"; text: string; label: string }
  | { type: "stream_start"; id: string }
  | { type: "stream_subagent_lane_start"; id: string; parentToolCallId?: string; laneId?: string; subRequestId?: string; label?: string; task?: string; isFollowUp?: boolean }
  | { type: "stream_iteration"; id: string; iteration?: number; laneId?: string }
  | { type: "stream_thinking"; id: string; text?: string; laneId?: string }
  | {
      type: "stream_usage"; id: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
      contextLength?: number; laneId?: string;
      /** USD cost of just this usage event, when the active model's pricing is known. */
      costUsd?: number;
      /** True when some billed token category had no known price — costUsd is a lower bound. */
      costPartial?: boolean;
    }
  | { type: "session_runtime"; runtime?: SessionRuntime | null }
  | { type: "stream_diagnostic"; id: string; level?: string; message?: string; laneId?: string }
  | { type: "stream_delta"; id: string; text?: string; laneId?: string }
  /** A retryable failure killed the in-flight generation; the deltas streamed so far are void.
   *  Clear the live bubble — the retry re-streams the turn from the beginning. */
  | { type: "stream_reset"; id: string; reason?: string; laneId?: string }
  | { type: "stream_tool_call"; id: string; toolCallId?: string; toolName?: string; inputPreview?: string; input?: any; laneId?: string }
  | { type: "stream_tool_result"; id: string; toolCallId?: string; toolName?: string; ok?: boolean; summary?: string; result?: any; elapsedMs?: number; laneId?: string }
  | { type: "stream_approval_pending"; id: string; toolCallId?: string; description?: string; tier?: string; unrecognizedCommand?: boolean; laneId?: string }
  | { type: "stream_approval_result"; id: string; toolCallId?: string; granted?: boolean; decision?: ApprovalDecision; laneId?: string }
  /** The project's compiled stylesheet, sent once per webview so question-card previews can be
   *  drawn with the product's real classes and tokens instead of hand-rebuilt CSS.
   *  See src/preview-assets.ts. */
  | { type: "preview_assets"; projectCss?: string }
  | { type: "stream_question_card"; id: string; toolCallId?: string; questions?: QCardQuestion[]; laneId?: string }
  | { type: "stream_question_card_resolved"; toolCallId: string; answers: string[][] }
  /** The host is no longer waiting on this question card / approval, so the webview must stop
   *  accepting an answer for it. Sent when a run is cancelled, the conversation is cleared, or
   *  an answer arrives for a gate the host has no record of. */
  | { type: "stream_gate_expired"; kind?: "question" | "approval"; toolCallId: string; reason?: string; laneId?: string }
  | { type: "stream_end"; id: string; stopReason?: string; iterations?: number; laneId?: string }
  | { type: "stream_subagent_lane_end"; id: string; parentToolCallId?: string; laneId?: string; subRequestId?: string; label?: string; ok?: boolean; answer?: string; error?: string; elapsedMs?: number; stopReason?: string; toolRounds?: number; budget?: any }
  | { type: "stream_error"; id?: string; message?: string; laneId?: string }
  | { type: "clear" }
  | { type: "settings_data"; settings?: ExtendedSettings; keyStatus?: KeyStatus; models?: ModelInfo[]; memoryStats?: MemoryStats | null; logStats?: LogStats | null }
  | { type: "memory_stats"; stats?: MemoryStats | null }
  | { type: "models_loading"; provider?: ProviderName }
  | { type: "models_data"; provider?: ProviderName; models?: ModelInfo[]; source?: string; error?: string; notice?: string }
  | { type: "history_data"; sessions?: HistorySession[] }
  | { type: "key_status_update"; keyStatus?: KeyStatus }
  | { type: "files_data"; query?: string; files?: string[] }
  | { type: "attachments_added"; attachments?: ReferenceAttachmentInfo[] }
  | { type: "attach_error"; message?: string }
  | { type: "transcript_document_data"; documentId: string; markdown?: string; error?: string };

/** Messages sent to the extension host (webview → host). */
export type OutgoingMessage =
  | { type: "ready" }
  | { type: "send_message"; payload: { content: string; context?: { text?: string; label?: string } | null; mentions?: string[]; attachments?: string[]; requestMode?: RequestMode } }
  | { type: "request_files"; query: string }
  | { type: "request_attach_files" }
  | { type: "attach_pasted_file"; payload: { name: string; mimeType: string; base64: string } }
  | { type: "attach_pasted_files"; payload: { files: Array<{ name: string; mimeType: string; base64: string }> } }
  | { type: "load_transcript_document"; documentId: string }
  | { type: "open_transcript_document"; documentId: string }
  | { type: "remove_attachment"; id: string }
  | { type: "cancel_current" }
  | { type: "compact_conversation" }
  | { type: "new_chat" }
  | { type: "get_history" }
  | { type: "load_session"; sessionId: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "get_settings" }
  | { type: "set_active_provider"; provider: ProviderName }
  | { type: "set_provider_model"; provider: ProviderName; model: string }
  | { type: "set_temperature"; provider: ProviderName; temperature: number }
  | { type: "set_max_tokens"; provider: ProviderName; maxTokens: number }
  | { type: "set_max_tokens_unlimited"; provider: ProviderName; unlimited: boolean }
  /** One sampling control at a time; `null` clears it back to the model's own default. */
  | { type: "set_sampling"; provider: ProviderName; key: SamplingKey; value: number | null }
  | { type: "set_thinking"; provider: ProviderName; enabled: boolean; budgetTokens: number; effort?: ClaudeEffort }
  | { type: "set_reasoning_effort"; provider: ProviderName; effort: ReasoningEffort }
  | { type: "set_service_tier"; provider: ProviderName; tier: ServiceTier }
  | { type: "set_base_url"; provider: ProviderName; baseUrl: string }
  | { type: "set_cache_ttl"; provider: ProviderName; ttl: "5m" | "1h" }
  | { type: "set_fast_mode"; provider: ProviderName; enabled: boolean }
  | { type: "set_task_budget"; provider: ProviderName; tokens: number }
  | { type: "set_context_editing"; provider: ProviderName; enabled: boolean }
  | { type: "set_refusal_fallback"; provider: ProviderName; enabled: boolean }
  | { type: "set_compaction"; provider: ProviderName; tokens: number }
  | { type: "set_responses_api"; provider: ProviderName; enabled: boolean }
  | { type: "set_max_iterations"; maxIterations: number }
  | { type: "toggle_tool"; toolName: string; enabled: boolean }
  | { type: "set_compression"; enabled: boolean; triggerPct: number; keepRecent: number; provider?: ProviderName; model?: string }
  | { type: "set_memory_index"; enabled: boolean }
  | { type: "set_embedding"; provider?: ProviderName | "voyage"; model?: string; dims?: number }
  | { type: "rebuild_embeddings" }
  | { type: "set_vision_fallback"; provider?: ProviderName; model?: string }
  | { type: "set_audio_transcription"; enabled?: boolean; model?: string; language?: string }
  | { type: "get_memory_stats" }
  | { type: "show_logs" }
  | { type: "export_logs" }
  | { type: "open_settings"; query?: string }
  | { type: "question_card_answer"; toolCallId: string; questionIndex: number; selectedKeys: string[] }
  | { type: "open_question_comparison"; toolCallId: string }
  | { type: "approval_decision"; toolCallId: string; decision: ApprovalDecision; command?: string; scope?: "workspace" | "global" }
  | { type: "fetch_models"; provider: ProviderName }
  | { type: "set_api_key"; provider: string }
  | { type: "clear_api_key"; provider: string }
  | {
      type: "set_openrouter_config";
      httpReferer?: string;
      xTitle?: string;
      fallbackModels?: string[];
      providerOrder?: string[];
      allowFallbacks?: boolean;
      dataCollection?: "allow" | "deny";
      sort?: "price" | "throughput" | "latency";
    }
  | { type: "set_bedrock_api"; api: "converse" | "mantle" }
  | { type: "set_subagent_provider"; provider?: ProviderName; model?: string }
  | { type: "set_subagent_max_concurrent"; maxConcurrent: number }
  | { type: "upsert_subagent_profile"; profile: SubagentProfile }
  | { type: "delete_subagent_profile"; profileId: string }
  | { type: "open_file"; path: string; line?: number };
