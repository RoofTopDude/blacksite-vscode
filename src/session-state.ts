import type { QCardQuestion } from "./tools/definitions.js";

export type CompressionTrigger = "auto" | "manual";
export type AgentStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "max_iterations"
  | "approval_pending"
  | "question_pending"
  | "cancelled"
  | "error"
  /**
   * The provider declined to produce (or finished) the response on content grounds:
   * Bedrock `guardrail_intervened`/`content_filtered`, Anthropic `refusal`, OpenAI
   * `content_filter`. This is a *terminal, legitimate* outcome — distinct from
   * "protocol_violation", which means the turn ended without a valid terminal event.
   * Keeping them separate matters: the truncation-recovery path treats
   * protocol_violation as a cut-off response and retries with a doubled output budget,
   * which for a refusal just burns turns re-provoking the same refusal.
   */
  | "refusal"
  /**
   * The prompt exceeded the model's *context window* (Claude 4.5+ reports this as its own stop
   * reason). Distinct from "max_tokens", which is the output cut-off: the fix here is to shrink the
   * input, not to grant more output. Conflating the two is actively harmful — the truncation
   * recovery path responds to max_tokens by doubling the output budget, which on a context overflow
   * makes the request larger and re-provokes the same error.
   */
  | "context_window_exceeded"
  | "protocol_violation";

export interface PendingApprovalState {
  kind: "approval";
  toolCallId: string;
  toolName: string;
  description: string;
  tier: string;
  unrecognizedCommand?: boolean;
}

export interface PendingQuestionState {
  kind: "question";
  toolCallId: string;
  questions: QCardQuestion[];
}

export type PendingGateState = PendingApprovalState | PendingQuestionState;

export interface SessionMessage {
  role: "user" | "assistant";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | any[];
}

export interface PersistedSessionState {
  compressedSummary?: string;
  compressionCount?: number;
  lastInputTokens?: number;
  lastCompressedAt?: number;
  lastCompressedMessageCount?: number;
  lastCompressionError?: string;
  lastCompressionTrigger?: CompressionTrigger;
  contextLength?: number;
  lastStopReason?: AgentStopReason;
  autoContinueCount?: number;
  pendingGate?: PendingGateState;
  providerState?: Record<string, unknown>;
  fullHistory?: SessionMessage[];
  /** Workspace-relative paths edited this session with no qualifying
      Codebase Map note recorded since — see AgentSession's end-of-turn
      note-enforcement check. */
  dirtyMapFiles?: string[];
  /** Forced end-of-turn continuations issued so far to prompt for a missing
      map note, for the current unresolved batch of dirty files. */
  noteEnforcementCount?: number;
}

export interface SessionRestoreState extends PersistedSessionState {
  sessionId?: string;
  messages: SessionMessage[];
}

export interface SessionRuntimeState {
  sessionId: string;
  contextLength?: number;
  lastInputTokens: number;
  usagePct: number | null;
  compressionEnabled: boolean;
  isCompacting: boolean;
  compressionCount: number;
  hasCompressedHistory: boolean;
  lastCompressedAt?: number;
  lastCompressedMessageCount?: number;
  lastCompressionError?: string;
  lastCompressionTrigger?: CompressionTrigger;
  keepRecent: number;
  activeMessageCount: number;
  fullMessageCount: number;
  compressedMessageCount: number;
  compressibleMessageCount: number;
  lastStopReason?: AgentStopReason;
  autoContinueCount: number;
  pendingGate?: PendingGateState;
}
