/* Search, filter, sort, and grouping for the ticket surfaces.
 *
 * Pure functions over the pushed state, shared by the sidebar and the board so a filter set
 * means the same thing in both. Kept out of the components because this is the part that has
 * to stay correct at three hundred tickets, and it is far easier to reason about — and to
 * change — as data in, data out.
 */

import {
  isOpen, priorityRank, STATUS_ORDER, PRIORITY_ORDER, ASSIGNEE_ORDER, STATUS_LABEL,
  PRIORITY_LABEL, ASSIGNEE_LABEL,
  type Ticket, type TicketAssignee, type TicketPriority, type TicketStatus,
} from "./types";

export type GroupBy = "status" | "priority" | "assignee" | "label" | "area" | "none";
export type SortBy = "manual" | "priority" | "updated" | "created" | "title";
/** The coarse scope tabs. Everything finer is a filter. */
export type Scope = "open" | "active" | "triage" | "mine" | "all";

export interface Filters {
  query: string;
  scope: Scope;
  statuses: TicketStatus[];
  priorities: TicketPriority[];
  assignees: TicketAssignee[];
  labels: string[];
  /** Directory prefix — matches declared areas and any file beneath them. */
  areas: string[];
  groupBy: GroupBy;
  sortBy: SortBy;
}

export const DEFAULT_FILTERS: Filters = {
  query: "",
  scope: "open",
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  areas: [],
  groupBy: "status",
  sortBy: "priority",
};

export const GROUP_LABEL: Record<GroupBy, string> = {
  status: "Status", priority: "Priority", assignee: "Assignee",
  label: "Label", area: "Area", none: "Nothing",
};

export const SORT_LABEL: Record<SortBy, string> = {
  manual: "Manual rank", priority: "Priority", updated: "Recently updated",
  created: "Recently created", title: "Title",
};

export const SCOPE_LABEL: Record<Scope, string> = {
  open: "Open", active: "Active", triage: "Triage", mine: "Mine", all: "All",
};

/**
 * Free-text match, mirroring matchesTicketQuery in the store so the panel's filter and the
 * agent's `ticket_list query` return the same set. AND across terms, substring within each.
 *
 * A leading `#` scopes the term to labels and a leading `@` to the assignee, which is the one
 * piece of query syntax worth having: those two are what you actually narrow by, and reaching
 * for the filter menu to add one label is three clicks where this is two keystrokes.
 */
export function matchesQuery(ticket: Ticket, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    ticket.id, ticket.title, ticket.description ?? "",
    ticket.labels.join(" "),
    ticket.acceptanceCriteria.join(" "),
    ticket.territory.files.join(" "), ticket.territory.areas.join(" "),
    ticket.references.map((reference) => `${reference.title ?? ""} ${reference.url}`).join(" "),
    ticket.planId ?? "", (ticket.runIds ?? []).join(" "), ticket.status, ticket.priority,
  ].join(" ").toLowerCase();

  return terms.every((term) => {
    if (term.startsWith("#") && term.length > 1) {
      return ticket.labels.some((label) => label.includes(term.slice(1)));
    }
    if (term.startsWith("@") && term.length > 1) {
      return ticket.assignee.startsWith(term.slice(1)) || (term.slice(1) === "me" && ticket.assignee === "user");
    }
    return haystack.includes(term);
  });
}

function inScope(ticket: Ticket, scope: Scope): boolean {
  switch (scope) {
    case "open": return isOpen(ticket.status);
    case "active": return ticket.status === "in_progress" || ticket.status === "review";
    case "triage": return ticket.status === "triage";
    case "mine": return ticket.assignee === "user" && isOpen(ticket.status);
    default: return true;
  }
}

function inArea(ticket: Ticket, area: string): boolean {
  return ticket.territory.areas.some((declared) => declared === area || declared.startsWith(`${area}/`))
    || ticket.territory.files.some((file) => file === area || file.startsWith(`${area}/`));
}

export function applyFilters(tickets: readonly Ticket[], filters: Filters): Ticket[] {
  return tickets.filter((ticket) => {
    /* An explicit status filter overrides the scope tab rather than intersecting with it —
       picking "Done" from the filter menu while sitting on the Open tab should show done
       tickets, not an empty list that looks like a bug. */
    if (filters.statuses.length > 0) {
      if (!filters.statuses.includes(ticket.status)) return false;
    } else if (!inScope(ticket, filters.scope)) return false;
    if (filters.priorities.length > 0 && !filters.priorities.includes(ticket.priority)) return false;
    if (filters.assignees.length > 0 && !filters.assignees.includes(ticket.assignee)) return false;
    if (filters.labels.length > 0 && !filters.labels.some((label) => ticket.labels.includes(label))) return false;
    if (filters.areas.length > 0 && !filters.areas.some((area) => inArea(ticket, area))) return false;
    if (filters.query && !matchesQuery(ticket, filters.query)) return false;
    return true;
  });
}

/** `rank` is the ticket's array position in the document — the board's drag order. */
export function sortTickets(tickets: readonly Ticket[], sortBy: SortBy, rank: Map<string, number>): Ticket[] {
  const copy = [...tickets];
  switch (sortBy) {
    case "manual":
      return copy.sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0));
    case "updated":
      return copy.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    case "created":
      return copy.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    case "title":
      return copy.sort((left, right) => left.title.localeCompare(right.title));
    default:
      return copy.sort((left, right) => (
        priorityRank(left.priority) - priorityRank(right.priority)
        || right.updatedAt.localeCompare(left.updatedAt)
      ));
  }
}

export interface TicketGroup {
  key: string;
  label: string;
  /** For status groups: the status itself, so the header can carry its icon and hue. */
  status?: TicketStatus;
  tickets: Ticket[];
}

/**
 * Split into display groups.
 *
 * Status and priority groups are emitted in canonical order and include empty ones (a Backlog
 * column that vanishes when it empties makes the board jump); label and area groups are
 * emitted by size, since their vocabulary is open-ended and an empty one has nothing to say.
 * A ticket with three labels appears under all three — that is what a label is.
 */
export function groupTickets(tickets: readonly Ticket[], groupBy: GroupBy): TicketGroup[] {
  if (groupBy === "none") {
    return [{ key: "all", label: "All", tickets: [...tickets] }];
  }

  if (groupBy === "status") {
    return STATUS_ORDER.map((status) => ({
      key: status,
      label: STATUS_LABEL[status],
      status,
      tickets: tickets.filter((ticket) => ticket.status === status),
    }));
  }

  if (groupBy === "priority") {
    return PRIORITY_ORDER.map((priority) => ({
      key: priority,
      label: PRIORITY_LABEL[priority],
      tickets: tickets.filter((ticket) => ticket.priority === priority),
    }));
  }

  if (groupBy === "assignee") {
    return ASSIGNEE_ORDER.map((assignee) => ({
      key: assignee,
      label: ASSIGNEE_LABEL[assignee],
      tickets: tickets.filter((ticket) => ticket.assignee === assignee),
    }));
  }

  const buckets = new Map<string, Ticket[]>();
  const unfiled: Ticket[] = [];
  for (const ticket of tickets) {
    const keys = groupBy === "label"
      ? ticket.labels
      : [...ticket.territory.areas, ...ticket.territory.files.map(dirnameOf).filter(Boolean)];
    const unique = [...new Set(keys)];
    if (unique.length === 0) { unfiled.push(ticket); continue; }
    for (const key of unique) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(ticket);
      else buckets.set(key, [ticket]);
    }
  }

  const groups = [...buckets.entries()]
    .map(([key, bucket]) => ({ key, label: key, tickets: bucket }))
    .sort((left, right) => right.tickets.length - left.tickets.length || left.key.localeCompare(right.key));
  if (unfiled.length > 0) {
    groups.push({ key: "__none", label: groupBy === "label" ? "No labels" : "No territory", tickets: unfiled });
  }
  return groups;
}

function dirnameOf(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut > 0 ? file.slice(0, cut) : "";
}

/** How many filter chips are active, for the "Filter (3)" affordance and the reset control. */
export function activeFilterCount(filters: Filters): number {
  return filters.statuses.length + filters.priorities.length + filters.assignees.length
    + filters.labels.length + filters.areas.length;
}

export function clearFilters(filters: Filters): Filters {
  return { ...filters, statuses: [], priorities: [], assignees: [], labels: [], areas: [] };
}

/** Toggle one value in a filter array — the interaction every multi-select chip performs. */
export function toggleIn<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}
