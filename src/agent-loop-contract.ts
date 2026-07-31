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
   * content to be replayed verbatim.
   */
  signature?: string;
  /**
   * The OpenAI Responses API's opaque encrypted reasoning payload (requested via
   * `include: ["reasoning.encrypted_content"]`, present only when `useResponsesApi` is on
   * for a reasoning model). Mutually exclusive with `signature` — a block carries one or the
   * other depending on which provider produced it, never both. Like `signature`, it MUST be
   * replayed verbatim to preserve reasoning continuity across a tool-call turn; unlike
   * `signature`, dropping it does not 400 the next request (the model just loses continuity
   * and re-reasons from scratch), so it degrades rather than breaks.
   */
  encryptedContent?: string;
  /** The Responses API reasoning item's own `id` — required to reconstruct the exact
   *  `{type:"reasoning", id, ...}` input item on replay. OpenAI-origin blocks only. */
  reasoningItemId?: string;
}

/**
 * A thinking block whose content Anthropic's safety systems encrypted. The reasoning is opaque to
 * us — only `data` survives — but it is still a *structural* part of the assistant turn and must be
 * replayed verbatim.
 *
 * Dropping it is not a cosmetic loss. With thinking enabled, Anthropic requires an assistant turn
 * that made tool calls to lead with its reasoning; replaying a turn whose reasoning was silently
 * discarded leads with `tool_use` instead and takes a 400. The parser used to have no case for this
 * block type at all, so it vanished on arrival.
 */
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
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

/**
 * A server-side conversation summary (Anthropic beta `compact-2026-01-12`). Opaque to us —
 * `content` is the model-generated summary text, but its real purpose is structural: replaying
 * it verbatim in the next request's message history is what tells the API where the compacted
 * boundary is. The API drops everything *before* this block server-side on the next request, so
 * dropping it ourselves (or extracting only surrounding text) would silently discard the
 * server's compaction state and re-send the full uncompacted history next turn.
 */
export interface CompactionBlock {
  type: "compaction";
  content: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | CompactionBlock;

/** The two block types that carry model reasoning and must be replayed ahead of any tool_use. */
export type ReasoningBlock = ThinkingBlock | RedactedThinkingBlock;

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
  | { type: "thinking_block"; text: string; signature?: string; encryptedContent?: string; reasoningItemId?: string }
  /** A safety-encrypted thinking block. Opaque, but structurally required on replay. */
  | { type: "redacted_thinking_block"; data: string }
  | { type: "tool_use_block"; block: ToolUseBlock }
  /** Server-side compaction summary (Anthropic beta) — see {@link CompactionBlock}. */
  | { type: "compaction_block"; content: string }
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
  /** The processing tier that actually served the request, as echoed back by the provider —
   *  not the tier that was requested, which OpenAI may decline to honour and downgrade. Cost
   *  estimation scales the model's rates by it (flex bills at half, fast at double), so this
   *  must come from the response rather than from settings. Undefined on providers with no
   *  such concept. */
  serviceTier?: string;
}

export interface ProviderTurnSink {
  emit(event: ProviderTurnStreamEvent): void;
}

export interface ProviderTurnResult {
  text: string;
  /** Thinking and redacted-thinking blocks, in arrival order. Replayed ahead of text and tool_use
   *  on the next turn — Anthropic rejects an assistant turn that made tool calls but leads with
   *  something other than its reasoning. */
  thinkingBlocks: ReasoningBlock[];
  toolCalls: ToolUseBlock[];
  stopReason: AgentStopReason;
  usage?: ProviderTurnUsage;
  empty: boolean;
  /** Present only when server-side compaction fired this turn. Always placed first in the
   *  reconstructed assistant turn — see {@link CompactionBlock}. */
  compactionBlock?: CompactionBlock;
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
