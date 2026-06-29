import type { QCardOption } from "./tools/definitions.js";

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
  | "protocol_violation";

export interface PendingApprovalState {
  kind: "approval";
  toolCallId: string;
  toolName: string;
  description: string;
  tier: string;
}

export interface PendingQuestionState {
  kind: "question";
  toolCallId: string;
  question: string;
  options: QCardOption[];
  context?: string;
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
