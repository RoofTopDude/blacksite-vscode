/* Message + entity shapes for the ticket surfaces. Hand-mirrored from src/ticket-store.ts
   per repo convention: the host types incoming messages loosely and coerces. */

export type TicketStatus =
  | "triage" | "backlog" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type TicketPriority = "urgent" | "high" | "normal" | "low";
export type TicketComplexity = "small" | "medium" | "large";
export type TicketOrigin = "user" | "agent" | "map_note" | "diagnostic" | "review";
export type TicketActor = "user" | "agent" | "system";
export type TicketAssignee = "unassigned" | "user" | "agent";

export interface TicketEvent {
  id: string;
  at: string;
  actor: TicketActor;
  sessionId?: string;
  kind: string;
  body?: string;
  from?: string;
  to?: string;
}

export interface TicketTerritory {
  files: string[];
  areas: string[];
}

export interface TicketReference {
  url: string;
  title?: string;
}

export interface Ticket {
  id: string;
  title: string;
  description?: string;
  status: TicketStatus;
  statusSource: "manual" | "derived";
  priority: TicketPriority;
  complexity?: TicketComplexity;
  complexityBasis?: string;
  labels: string[];
  acceptanceCriteria: string[];
  territory: TicketTerritory;
  references: TicketReference[];
  planId?: string;
  phaseId?: string;
  /** Stable references into the Execution Run store; trace data remains owned by that store. */
  runIds: string[];
  blockedBy: string[];
  blocks: string[];
  relatedTo: string[];
  duplicateOf?: string;
  assignee: TicketAssignee;
  origin: TicketOrigin;
  originRef?: string;
  events: TicketEvent[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface ResolvedTerritory {
  files: string[];
  staleFiles: string[];
  areas: Array<{ area: string; files: number; truncated: boolean }>;
}

export interface LinkablePlan {
  id: string;
  title: string;
  status?: string;
}

/** Everything the host pushes on `tickets_state`, in one shape both surfaces read. */
export interface TicketsState {
  tickets: Ticket[];
  territory: Record<string, ResolvedTerritory>;
  labels: Array<{ label: string; count: number }>;
  plans: LinkablePlan[];
  dropped: number;
  indexedCount: number;
}

export const EMPTY_STATE: TicketsState = {
  tickets: [], territory: {}, labels: [], plans: [], dropped: 0, indexedCount: 0,
};

/** Coerce a `tickets_state` message. Every array is defaulted because a v1 document read by a
 *  v2 webview during an upgrade is a real state, not a bug. */
export function readTicketsState(msg: Record<string, unknown>): TicketsState {
  const tickets = Array.isArray(msg.tickets) ? (msg.tickets as Ticket[]) : [];
  return {
    tickets: tickets.map((ticket) => ({
      ...ticket,
      labels: ticket.labels ?? [],
      acceptanceCriteria: ticket.acceptanceCriteria ?? [],
      references: ticket.references ?? [],
      runIds: ticket.runIds ?? [],
      territory: ticket.territory ?? { files: [], areas: [] },
      blockedBy: ticket.blockedBy ?? [],
      blocks: ticket.blocks ?? [],
      relatedTo: ticket.relatedTo ?? [],
      assignee: ticket.assignee ?? "unassigned",
      events: ticket.events ?? [],
    })),
    territory: (msg.territory as TicketsState["territory"]) ?? {},
    labels: Array.isArray(msg.labels) ? (msg.labels as TicketsState["labels"]) : [],
    plans: Array.isArray(msg.plans) ? (msg.plans as LinkablePlan[]) : [],
    dropped: Number(msg.dropped) || 0,
    indexedCount: Number(msg.indexedCount) || 0,
  };
}

export const OPEN_STATUSES: TicketStatus[] = ["triage", "backlog", "in_progress", "blocked", "review"];

export function isOpen(status: TicketStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export const STATUS_ORDER: TicketStatus[] = [
  "triage", "backlog", "in_progress", "blocked", "review", "done", "cancelled",
];

export const PRIORITY_ORDER: TicketPriority[] = ["urgent", "high", "normal", "low"];
export const COMPLEXITY_ORDER: TicketComplexity[] = ["small", "medium", "large"];
export const ASSIGNEE_ORDER: TicketAssignee[] = ["unassigned", "user", "agent"];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  triage: "Triage",
  backlog: "Backlog",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: "Urgent", high: "High", normal: "Normal", low: "Low",
};

export const ASSIGNEE_LABEL: Record<TicketAssignee, string> = {
  unassigned: "Unassigned", user: "You", agent: "Agent",
};

/** Status hue, shared by the icon, the group header, and the board column rail so one status
 *  reads as one colour everywhere. */
export const STATUS_TONE: Record<TicketStatus, string> = {
  triage: "var(--s-warn)",
  backlog: "var(--muted-foreground)",
  in_progress: "var(--s-info)",
  blocked: "var(--s-err)",
  review: "var(--primary)",
  done: "var(--s-ok)",
  cancelled: "var(--muted-foreground)",
};

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function byPriority(left: Ticket, right: Ticket): number {
  const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  return rank !== 0 ? rank : right.updatedAt.localeCompare(left.updatedAt);
}

export function priorityRank(priority: TicketPriority): number {
  return PRIORITY_RANK[priority];
}
