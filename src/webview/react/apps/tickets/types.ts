/* Message + entity shapes for the ticket queue webview. Hand-mirrored from src/ticket-store.ts
   per repo convention: the host types incoming messages loosely and coerces. */

export type TicketStatus =
  | "triage" | "backlog" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type TicketPriority = "urgent" | "high" | "normal" | "low";
export type TicketComplexity = "small" | "medium" | "large";
export type TicketOrigin = "user" | "agent" | "map_note" | "diagnostic" | "review";
export type TicketActor = "user" | "agent" | "system";

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
  territory: TicketTerritory;
  planId?: string;
  phaseId?: string;
  blockedBy: string[];
  relatedTo: string[];
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

export const OPEN_STATUSES: TicketStatus[] = ["triage", "backlog", "in_progress", "blocked", "review"];

export function isOpen(status: TicketStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export const STATUS_ORDER: TicketStatus[] = [
  "triage", "backlog", "in_progress", "blocked", "review", "done", "cancelled",
];

export const PRIORITY_ORDER: TicketPriority[] = ["urgent", "high", "normal", "low"];

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function byPriority(left: Ticket, right: Ticket): number {
  const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  return rank !== 0 ? rank : right.updatedAt.localeCompare(left.updatedAt);
}
