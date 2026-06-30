/* Typed contract for the webview ↔ extension-host postMessage protocol.
   Mirrors the message types handled in src/chat-provider.ts. Keep in sync. */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ProviderName = "anthropic" | "openrouter" | "openai" | "bedrock";

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

export interface ProviderSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  thinking?: ThinkingConfig;
  reasoningEffort?: "low" | "medium" | "high";
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
  /** Embedding provider — embeddings only run on openai/openrouter. */
  provider?: ProviderName;
  /** Embedding model id (blank = built-in default). */
  model?: string;
  /** Output vector dimensions. Changing this requires a rebuild. */
  dims?: number;
}

/** OpenRouter-specific request configuration beyond standard provider settings. */
export interface OpenRouterConfig {
  /** HTTP-Referer header sent to OpenRouter. Controls which site is credited for usage. */
  httpReferer?: string;
  /** X-Title header sent to OpenRouter. Displayed in the OpenRouter dashboard. */
  xTitle?: string;
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
  /** OpenRouter-specific headers and routing config. */
  openrouterConfig?: OpenRouterConfig;
  /** Global subagent configuration and profile library. */
  subagent?: SubagentSettings;
  /** Selects the Bedrock API path: "converse" (default) or "mantle" (Messages API). */
  bedrockApi?: "converse" | "mantle";
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  inputPricePerM?: number;
  outputPricePerM?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
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
  turns?: number;
  [k: string]: any;
}

export interface SessionRuntime {
  sessionId?: string;
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
  preview?: { html?: string; code?: string } | null;
}

export type ApprovalDecision = "allow" | "allow_all" | "allow_always" | "deny";

export interface HistorySession {
  sessionId: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  messages?: ChatMessage[];
  [k: string]: any;
}

export interface ChatMessage {
  role: string;
  content: unknown;
}

/** Messages received from the extension host (host → webview). */
export type IncomingMessage =
  | { type: "history_restored"; messages?: ChatMessage[] }
  | { type: "inject_context"; text: string; label: string }
  | { type: "stream_start"; id: string }
  | { type: "stream_subagent_lane_start"; id: string; parentToolCallId?: string; laneId?: string; subRequestId?: string; label?: string; task?: string }
  | { type: "stream_iteration"; id: string; iteration?: number; laneId?: string }
  | { type: "stream_thinking"; id: string; text?: string; laneId?: string }
  | { type: "stream_usage"; id: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; contextLength?: number; laneId?: string }
  | { type: "session_runtime"; runtime?: SessionRuntime | null }
  | { type: "stream_diagnostic"; id: string; level?: string; message?: string; laneId?: string }
  | { type: "stream_delta"; id: string; text?: string; laneId?: string }
  | { type: "stream_tool_call"; id: string; toolCallId?: string; toolName?: string; inputPreview?: string; input?: any; laneId?: string }
  | { type: "stream_tool_result"; id: string; toolCallId?: string; toolName?: string; ok?: boolean; summary?: string; result?: any; elapsedMs?: number; laneId?: string }
  | { type: "stream_approval_pending"; id: string; toolCallId?: string; description?: string; tier?: string; laneId?: string }
  | { type: "stream_approval_result"; id: string; toolCallId?: string; granted?: boolean; decision?: ApprovalDecision; laneId?: string }
  | { type: "stream_question_card"; id: string; toolCallId?: string; question?: string; options?: QCardOption[]; context?: string; laneId?: string }
  | { type: "stream_end"; id: string; stopReason?: string; iterations?: number; laneId?: string }
  | { type: "stream_subagent_lane_end"; id: string; parentToolCallId?: string; laneId?: string; subRequestId?: string; label?: string; ok?: boolean; answer?: string; error?: string; elapsedMs?: number; stopReason?: string; toolRounds?: number; budget?: any }
  | { type: "stream_error"; id?: string; message?: string; laneId?: string }
  | { type: "clear" }
  | { type: "settings_data"; settings?: ExtendedSettings; keyStatus?: KeyStatus; models?: ModelInfo[]; memoryStats?: MemoryStats | null; logStats?: LogStats | null }
  | { type: "memory_stats"; stats?: MemoryStats | null }
  | { type: "models_loading"; provider?: ProviderName }
  | { type: "models_data"; provider?: ProviderName; models?: ModelInfo[]; source?: string; error?: string }
  | { type: "history_data"; sessions?: HistorySession[] }
  | { type: "key_status_update"; keyStatus?: KeyStatus }
  | { type: "files_data"; query?: string; files?: string[] };

/** Messages sent to the extension host (webview → host). */
export type OutgoingMessage =
  | { type: "ready" }
  | { type: "send_message"; payload: { content: string; context?: { text?: string; label?: string } | null; mentions?: string[] } }
  | { type: "request_files"; query: string }
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
  | { type: "set_thinking"; provider: ProviderName; enabled: boolean; budgetTokens: number }
  | { type: "set_reasoning_effort"; provider: ProviderName; effort: "low" | "medium" | "high" }
  | { type: "set_max_iterations"; maxIterations: number }
  | { type: "toggle_tool"; toolName: string; enabled: boolean }
  | { type: "set_compression"; enabled: boolean; triggerPct: number; keepRecent: number; provider?: ProviderName; model?: string }
  | { type: "set_memory_index"; enabled: boolean }
  | { type: "set_embedding"; provider?: ProviderName; model?: string; dims?: number }
  | { type: "rebuild_embeddings" }
  | { type: "get_memory_stats" }
  | { type: "show_logs" }
  | { type: "export_logs" }
  | { type: "open_settings"; query?: string }
  | { type: "question_card_answer"; toolCallId: string; selectedKey: string }
  | { type: "approval_decision"; toolCallId: string; decision: ApprovalDecision; command?: string }
  | { type: "fetch_models"; provider: ProviderName }
  | { type: "set_api_key"; provider: string }
  | { type: "clear_api_key"; provider: string }
  | { type: "set_openrouter_config"; httpReferer?: string; xTitle?: string }
  | { type: "set_bedrock_api"; api: "converse" | "mantle" }
  | { type: "set_subagent_provider"; provider?: ProviderName; model?: string }
  | { type: "set_subagent_max_concurrent"; maxConcurrent: number }
  | { type: "upsert_subagent_profile"; profile: SubagentProfile }
  | { type: "delete_subagent_profile"; profileId: string }
  | { type: "open_file"; path: string; line?: number };
