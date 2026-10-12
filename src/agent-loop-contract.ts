/* The provider-neutral types live in @blacksite-agent/llm. This module re-exports them for the
   extension's existing imports and keeps the one contract that belongs to the agent loop: how
   the loop drives a provider turn. */
import type { ImageBlock, ProviderTurnResult, ProviderTurnSink, ToolResultBlock } from "@blacksite-agent/llm";

export type {
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  CompactionBlock,
  ProviderNativeBlock,
  ContentBlock,
  HostedSearchResult,
  ReasoningBlock,
  AgentMessage,
  ProviderTurnUsage,
  ProviderTurnStreamEvent,
  ProviderActivityEvent,
  ProviderTurnUsageEvent,
  ProviderTurnSink,
  ProviderTurnResult,
} from "@blacksite-agent/llm";

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
