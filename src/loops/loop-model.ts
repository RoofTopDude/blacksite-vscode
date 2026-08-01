/**
 * Contracts for ticket loops — a supervised drain of the ticket queue.
 *
 * A loop is deliberately *not* a scheduler in the cron sense. It is driven by queue contents:
 * it dispatches whatever is ready, sleeps until a worker frees a slot, and ends when the query
 * matches nothing further. Nothing here knows about wall-clock recurrence.
 *
 * See docs/ticket-loops-design.md for the rules these types encode.
 */

import type { TicketComplexity, TicketPriority, TicketStatus } from "../ticket-store.js";

export type LoopStatus =
  /** Configured but inert. A draft never dispatches; starting one is a user action. */
  | "draft"
  | "running"
  /** User-paused. In-flight lanes finish; none start. */
  | "paused"
  /** Tickets remain, but none are dispatchable — all blocked, parked, or exhausted. */
  | "blocked"
  /** The query matched nothing further. The success terminal. */
  | "drained"
  /** A ceiling tripped, or the user stopped it. */
  | "stopped"
  /** The supervisor itself errored. */
  | "failed";

/** Terminal in the sense that the supervisor has stopped; `blocked` is not terminal because
 *  answering a parked gate or closing a blocker can make it dispatchable again. */
export const TERMINAL_LOOP_STATUSES: ReadonlySet<LoopStatus> = new Set<LoopStatus>([
  "drained", "stopped", "failed",
]);

/**
 * Which tickets this loop drains.
 *
 * Re-evaluated before every dispatch rather than snapshotted at start: a ticket filed mid-loop
 * that matches the query should be picked up, and one closed by hand should disappear without
 * the supervisor needing a special case for either.
 */
export interface LoopQueueSpec {
  statuses: TicketStatus[];
  labels: string[];
  priorities: TicketPriority[];
  /** Restrict to tickets whose declared territory falls under these map areas. */
  areas: string[];
  /** Explicit ids. When non-empty this is the whole queue and the other filters are ignored —
   *  "just these twelve" is the common case and should not also have to satisfy a status filter. */
  ids: string[];
  /**
   * Honour Ticket.blockedBy when deciding what is dispatchable.
   *
   * Ticket links are informational everywhere else in the product. A loop is the one consumer
   * that can actually act on them, so this is opt-out rather than absent.
   */
  respectBlockedBy: boolean;
}

export interface LoopWorkerSpec {
  /** Concurrent lanes. 1 is a strictly sequential drain. */
  concurrency: number;
  /** Optional subagent profile applied to every lane. */
  profileId?: string;
  /** Overrides the Ticket.complexity → lane budget mapping. */
  complexityOverride?: TicketComplexity;
}

/**
 * Ceilings a loop cannot exceed. Declared at creation; `adjust` may lower them and never raise
 * them, because the whole premise of the feature is unattended spend.
 */
export interface LoopCeilings {
  maxTickets?: number;
  maxWallClockMs?: number;
  maxUsd?: number;
  /**
   * Consecutive ticket failures before the loop stops.
   *
   * Guards the case a per-ticket retry budget cannot see: something environmental broke — the
   * build is wedged, a credential expired — and every remaining lane will fail identically.
   */
  maxConsecutiveFailures: number;
}

/**
 * What a lane may do when no human is watching.
 *
 * Tiers are an allow-list rather than a "up to tier X" ladder because the tiers in use
 * (`write`, `network`, `destructive` — see approval-gate.ts) are not totally ordered. Asking
 * the user to rank network against file-write would be inventing a hierarchy the rest of the
 * product does not have.
 */
export interface LoopApprovalPosture {
  /** Every unattended approval is ruled on by the no-tools continuation reviewer. */
  reviewer: "continuation";
  /**
   * Retained for additive compatibility with loop documents created before reviewer-backed
   * approvals shipped. The continuation reviewer still sees and decides every gate; this list
   * is displayed only as historical configuration and is not a bypass.
   */
  autoApproveTiers: string[];
  /**
   * `park` frees the worker slot immediately and surfaces the ticket for the user; `wait` holds
   * the slot until answered. `wait` is expressible because someone supervising a short loop may
   * genuinely want it, but it means one unanswered gate costs a worker for the duration.
   */
  onGate: "park" | "wait";
  /** Notify on the first park, so a loop that parks everything is noticed early rather than
   *  discovered in the morning. */
  notify: boolean;
}

/**
 * Who closes a ticket.
 *
 * Only `user_review` exists today: a worker lane moves its ticket to `review` and stops. The
 * type is a union of one rather than a bare literal so widening it later is additive, and so
 * the persisted schema already carries the discriminator.
 */
export type LoopClosurePolicy = "user_review";

export interface LoopDefinition {
  id: string;
  title: string;
  status: LoopStatus;
  queue: LoopQueueSpec;
  workers: LoopWorkerSpec;
  ceilings: LoopCeilings;
  approvals: LoopApprovalPosture;
  closure: LoopClosurePolicy;
  /** Set when the loop first entered `running`, so a wall-clock ceiling measures elapsed time
   *  rather than running time — a loop must not evade its ceiling by being restarted. */
  startedAt?: string;
  endedAt?: string;
  /** Why the loop left `running`. Free text aimed at the user, not a code. */
  endedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type LoopIterationOutcome =
  /** Opened at dispatch, not yet settled. Counts as dispatched and as nothing else — in
   *  particular it must not fold as a failure, or a loop at concurrency 3 would trip its own
   *  consecutive-failure ceiling the moment it filled its worker slots. */
  | "running"
  | "succeeded"
  /** The lane ran and failed. Eligible for retry until the ticket's retry budget is spent. */
  | "failed"
  /** Hit an approval gate the posture would not auto-approve. Returns to the queue once
   *  answered; distinct from `failed` because nothing about the work went wrong. */
  | "parked"
  /** The host died mid-lane. The work on disk is real, the lane is not resumable. */
  | "abandoned"
  | "cancelled";

export type LoopActivityKind =
  | "lane_started"
  | "tool_started"
  | "tool_finished"
  | "review_started"
  | "review_allowed"
  | "review_blocked"
  | "diagnostic"
  | "lane_finished";

/** A compact, persisted execution trace for inspecting a loop lane from the Loops workbench. */
export interface LoopActivityEntry {
  id: string;
  at: string;
  kind: LoopActivityKind;
  label: string;
  detail?: string;
  toolCallId?: string;
  toolName?: string;
  tier?: string;
  ok?: boolean;
}

export interface LoopIteration {
  loopId: string;
  /** One start/resume of a loop. Spend is reported per execution as well as for its lifetime. */
  executionId: string;
  ticketId: string;
  /** 1-based, monotonic per loop, never reused. */
  seq: number;
  laneId?: string;
  /** The lane's resumable handle, for answering a park via subagent_followup. */
  subRequestId?: string;
  runIds: string[];
  outcome: LoopIterationOutcome;
  /** Verbatim from the lane's failure guidance where there is one, so a post-mortem does not
   *  require re-reading the transcript. */
  detail: string;
  startedAt: string;
  endedAt?: string;
  usd?: number;
  /** Bounded host-generated lane trace; never includes hidden reasoning or unbounded deltas. */
  activity: LoopActivityEntry[];
}

export interface LoopExecution {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: LoopStatus;
  reason?: string;
  totals: LoopTotals;
}

/** Per-ticket state the scheduler needs and the ticket itself should not carry — retry counts
 *  and parks belong to this loop's attempt at the ticket, not to the ticket. */
export interface LoopTicketState {
  ticketId: string;
  attempts: number;
  /** Set while parked on an approval; cleared when the gate is answered. */
  parkedOnGate?: string;
  parkedAt?: string;
  /** The lane to resume when the park is answered. */
  parkedSubRequestId?: string;
  /** Files the lane actually touched, unioned into the ticket's declared territory for the
   *  remainder of the loop. Territory is declared, not enforced — this narrows the gap. */
  touchedFiles: string[];
}

export interface LoopRecord {
  definition: LoopDefinition;
  /** One durable ledger entry per start/resume, newest last. */
  executions: LoopExecution[];
  /** The most recent {@link MAX_RETAINED_ITERATIONS}. Older ones are folded into `retired` and
   *  dropped — see the note there. */
  iterations: LoopIteration[];
  ticketState: LoopTicketState[];
  /** Running totals, so the view does not have to fold the iteration list on every render. */
  totals: LoopTotals;
  /**
   * Totals from iterations that have aged out of the retained window.
   *
   * The alternative — keeping every iteration forever — makes the document grow without bound
   * and, because the whole thing is re-read and re-written on each lane, turns a long run into
   * quadratic I/O. That is precisely the case this feature exists for, so the history is
   * windowed and its arithmetic is preserved here rather than lost.
   */
  retired?: LoopTotals;
}

export interface LoopTotals {
  dispatched: number;
  succeeded: number;
  failed: number;
  parked: number;
  usd: number;
  consecutiveFailures: number;
}

export function emptyTotals(): LoopTotals {
  return { dispatched: 0, succeeded: 0, failed: 0, parked: 0, usd: 0, consecutiveFailures: 0 };
}

/** Default retry budget per ticket. A third identical attempt has never been the thing that
 *  worked; past this the ticket is better surfaced to the user than retried. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export function defaultQueueSpec(): LoopQueueSpec {
  return {
    // Deliberately not `in_progress` or `review`: those are already someone's business.
    statuses: ["backlog", "triage"],
    labels: [],
    priorities: [],
    areas: [],
    ids: [],
    respectBlockedBy: true,
  };
}

export function defaultCeilings(): LoopCeilings {
  return { maxConsecutiveFailures: 3 };
}

/** The safe unattended posture: an independent continuation reviewer decides every gate;
 *  anything it cannot justify becomes a ticket-level block and is surfaced once. */
export function defaultApprovalPosture(): LoopApprovalPosture {
  return { reviewer: "continuation", autoApproveTiers: [], onGate: "park", notify: true };
}

/** Ticket complexity and subagent complexity are two vocabularies for the same judgment, so a
 *  well-triaged backlog produces well-budgeted lanes with no extra input from anyone. */
export function laneComplexityFor(complexity: TicketComplexity): "standard" | "complex" | "deep" {
  switch (complexity) {
    case "large": return "deep";
    case "medium": return "complex";
    default: return "standard";
  }
}
