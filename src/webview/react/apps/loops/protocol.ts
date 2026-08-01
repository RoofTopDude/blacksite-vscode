export type LoopStatus = "draft" | "running" | "paused" | "blocked" | "drained" | "stopped" | "failed";
export type LoopOutcome = "running" | "succeeded" | "failed" | "parked" | "abandoned" | "cancelled";

export interface LoopTotals {
  dispatched: number;
  succeeded: number;
  failed: number;
  parked: number;
  usd: number;
  consecutiveFailures: number;
}

export interface LoopActivity {
  id: string;
  at: string;
  kind: "lane_started" | "tool_started" | "tool_finished" | "review_started" | "review_allowed" | "review_blocked" | "diagnostic" | "lane_finished";
  label: string;
  detail?: string;
  toolCallId?: string;
  toolName?: string;
  tier?: string;
  ok?: boolean;
}

export interface LoopIteration {
  loopId: string;
  executionId: string;
  ticketId: string;
  seq: number;
  laneId?: string;
  subRequestId?: string;
  runIds: string[];
  outcome: LoopOutcome;
  detail: string;
  startedAt: string;
  endedAt?: string;
  usd?: number;
  activity: LoopActivity[];
}

export interface LoopExecution {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: LoopStatus;
  reason?: string;
  totals: LoopTotals;
}

export interface LoopTicketState {
  ticketId: string;
  attempts: number;
  parkedOnGate?: string;
  parkedAt?: string;
  touchedFiles: string[];
}

export interface LoopTicket {
  id: string;
  title: string;
  status: string;
  priority: string;
  complexity: string;
  labels: string[];
  files: string[];
  areas: string[];
  blockedBy: string[];
  acceptanceCriteria: string[];
}

export interface LoopProposal {
  matchedTicketIds: string[];
  firstWave: string[];
  withheld: Array<{ ticketId: string; reason: string; detail: string }>;
  recommendedConcurrency: number;
  concurrencyBasis: string;
  estimate: { usd: number; worstCaseUsd: number; basis: string };
  concerns: Array<{ kind: string; ticketIds: string[]; detail: string; suggestion: string }>;
}

export interface LoopRecord {
  definition: {
    id: string;
    title: string;
    status: LoopStatus;
    queue: { statuses: string[]; ids: string[]; labels: string[]; priorities: string[]; areas: string[]; respectBlockedBy: boolean };
    workers: { concurrency: number; profileId?: string };
    ceilings: { maxTickets?: number; maxWallClockMs?: number; maxUsd?: number; maxConsecutiveFailures: number };
    approvals: { reviewer: "continuation"; autoApproveTiers: string[]; onGate: string; notify: boolean };
    startedAt?: string;
    endedAt?: string;
    endedReason?: string;
    createdAt: string;
    updatedAt: string;
  };
  executions: LoopExecution[];
  iterations: LoopIteration[];
  ticketState: LoopTicketState[];
  totals: LoopTotals;
  proposal?: LoopProposal;
  tickets: LoopTicket[];
  activeLanes: LoopIteration[];
  supervisorRunning: boolean;
}

export interface LoopsStateMessage {
  type: "loops_state";
  loops: LoopRecord[];
  selectedLoopId?: string;
  availableTickets: LoopTicket[];
  maxConcurrency: number;
  reviewer: { mode: string; label: string; detail: string };
}

export interface LoopsNoticeMessage {
  type: "loops_notice";
  tone: "success" | "error" | "info";
  message: string;
}

export type LoopConfirmationAction = "start" | "stop" | "delete";

/** A host-issued confirmation boundary. The action is only applied when its opaque token returns. */
export interface LoopsConfirmMessage {
  type: "loops_confirm";
  token: string;
  action: LoopConfirmationAction;
  loopId: string;
  title: string;
  description: string;
  details: string[];
  caution?: string;
}

/** Lets commands opened outside the webview land in the same retained UI. */
export interface LoopsIntentMessage {
  type: "loops_intent";
  intent: "open_composer";
}

export type LoopsHostMessage = LoopsStateMessage | LoopsNoticeMessage | LoopsConfirmMessage | LoopsIntentMessage;

export function isLoopsHostMessage(value: unknown): value is LoopsHostMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "loops_state" || type === "loops_notice" || type === "loops_confirm" || type === "loops_intent";
}
