import type { AgentStopReason } from "./session-state.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /**
   * Anthropic's cryptographic signature for the reasoning block. Present only on the
   * Anthropic-direct / Mantle paths, which stream it via `signature_delta`. It MUST be
   * echoed back verbatim when the block is replayed in history: with extended thinking
   * enabled, Anthropic validates the signature and rejects an unsigned (or tampered)
   * thinking block with a 400. Bedrock Converse likewise requires its signed reasoning
   * content to be replayed verbatim; OpenAI-compatible paths do not round-trip thinking.
   */
  signature?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** Anthropic's wire shape exactly — the Anthropic-direct and Bedrock-Mantle send paths
 *  serialize ContentBlock[] unmodified, so this must match their API's image block. */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ProviderTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ProviderTurnStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_block"; text: string; signature?: string }
  | { type: "tool_use_block"; block: ToolUseBlock }
  | { type: "stop_reason"; reason: AgentStopReason }
  /** Out-of-band operational message (e.g. "retrying after 429…") surfaced to the UI as
   *  an execution diagnostic; carries no model-facing content and is ignored by the
   *  turn-result accumulator. */
  | { type: "notice"; level: "info" | "warn"; message: string }
  /** The turn is being re-attempted after a retryable mid-stream failure: everything
   *  streamed so far belongs to a generation that never completed. Consumers must discard
   *  the in-progress assistant output (the accumulator resets, and the webview clears the
   *  live bubble) — otherwise the retry's output would be appended to a partial prefix,
   *  producing a duplicated, seam-spliced message. Carries no model-facing content. */
  | { type: "turn_reset"; reason: string }
  | ProviderTurnUsageEvent;

export interface ProviderTurnUsageEvent {
  type: "usage_update";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderTurnSink {
  emit(event: ProviderTurnStreamEvent): void;
}

export interface ProviderTurnResult {
  text: string;
  thinkingBlocks: ThinkingBlock[];
  toolCalls: ToolUseBlock[];
  stopReason: AgentStopReason;
  usage?: ProviderTurnUsage;
  empty: boolean;
}

export interface ProviderTurnSession {
  runTurn(sink: ProviderTurnSink): Promise<ProviderTurnResult>;
  /** `images`, when present, become sibling content blocks in the same user turn so the
   *  model sees user-attached pictures directly (vision-capable providers only). */
  appendUserText(text: string, images?: ImageBlock[]): void;
  /** `images`, when present, are appended as sibling content in the same tool-result
   *  user turn (never a separate message — providers reject consecutive same-role turns). */
  appendToolResults(results: ToolResultBlock[], images?: ImageBlock[]): void;
  exportState?(): Record<string, unknown> | undefined;
  importState?(state?: Record<string, unknown>): void;
}
