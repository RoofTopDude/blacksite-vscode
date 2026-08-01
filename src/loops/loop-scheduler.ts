/**
 * Which ticket a loop dispatches next.
 *
 * Pure — no store, no vscode, no clock beyond an injectable `now`. Everything that decides what
 * a long-running unattended loop does to a workspace is decidable in a unit test, which is the
 * only reason to trust it at 3am.
 *
 * Ordering is delegated to rankTickets (ticket-store.ts) rather than reimplemented: it is
 * already the product's explainable "what should I pick up next" ranking, and a loop that
 * ordered work differently from the board would be a second opinion nobody asked for.
 */

import {
  isOpenStatus,
  rankTickets,
  resolveTerritory,
  type Ticket,
} from "../ticket-store.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  type LoopQueueSpec,
  type LoopTicketState,
} from "./loop-model.js";

/**
 * Stand-in territory for a ticket that declares none.
 *
 * A ticket with no territory intersects nothing, so a naive set-intersection lock would let
 * every untenanted ticket run concurrently with everything — exactly backwards, since an
 * untenanted ticket is the one whose blast radius is unknown. Treating it as conflicting with
 * everything is the safe reading, and it gives triage a visible reason to declare territory.
 */
export const UNTENANTED = "\u0000untenanted";

export interface ReadyEntry {
  ticket: Ticket;
  /** Effective territory: declared ∪ already-touched, resolved against the map index. */
  territory: ReadonlySet<string>;
  /** Why this ticket ranked where it did, straight from rankTickets. */
  reasons: string[];
}

export interface SchedulerInputs {
  tickets: readonly Ticket[];
  spec: LoopQueueSpec;
  /** Per-ticket loop state, keyed by ticket id. Absent means untried. */
  state: ReadonlyMap<string, LoopTicketState>;
  /** Territory held by lanes currently running. */
  inFlight: ReadonlyArray<ReadonlySet<string>>;
  /** Map node ids, for resolving areas to concrete files. */
  indexedFiles: readonly string[];
  maxAttempts?: number;
  now?: number;
}

/** Whether a ticket is in this loop's queue at all, before any readiness question. */
export function matchesQueue(ticket: Ticket, spec: LoopQueueSpec): boolean {
  // An explicit id list *is* the queue. Making those ids also satisfy a status filter would
  // silently drop tickets the user named one by one, which is never what they meant.
  if (spec.ids.length) return spec.ids.includes(ticket.id);

  if (!isOpenStatus(ticket.status)) return false;
  if (spec.statuses.length && !spec.statuses.includes(ticket.status)) return false;
  if (spec.priorities.length && !spec.priorities.includes(ticket.priority)) return false;
  if (spec.labels.length && !spec.labels.some((label) => ticket.labels.includes(label))) return false;
  if (spec.areas.length) {
    const inArea = spec.areas.some((area) => (
      ticket.territory.areas.includes(area)
      || ticket.territory.files.some((file) => file === area || file.startsWith(`${area}/`))
    ));
    if (!inArea) return false;
  }
  return true;
}

/**
 * A ticket's effective territory as a concrete file set.
 *
 * `touched` widens the lock as a lane runs: filesTouched comes back on every lane result, so a
 * ticket that turned out to reach beyond its declaration holds the wider claim for the rest of
 * the loop. This does not make territory enforced — a lane can still write anywhere — but it
 * stops the *next* dispatch from being scheduled into a known collision.
 */
export function territoryOf(
  ticket: Ticket,
  indexedFiles: readonly string[],
  touched: readonly string[] = [],
): Set<string> {
  const declared = resolveTerritory(ticket.territory, indexedFiles);
  const files = new Set<string>([...declared.files, ...touched]);
  // Stale declared files are kept: a declared path missing from the index may be renamed or
  // gitignored, and dropping it would quietly shrink the lock.
  for (const stale of declared.staleFiles) files.add(stale);
  if (!files.size) return new Set([UNTENANTED]);
  return files;
}

export function territoryConflicts(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.has(UNTENANTED) || b.has(UNTENANTED)) return true;
  // Iterate the smaller side; territories resolved from a broad area can be large.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const file of small) if (large.has(file)) return true;
  return false;
}

/** Tickets that are in the queue but cannot be dispatched, with the reason. Reported rather
 *  than dropped: "everything is blocked on BLK-9" and "there is nothing to do" are different
 *  situations and a loop that cannot tell them apart will report the wrong one. */
export interface WithheldEntry {
  ticket: Ticket;
  reason: "blocked" | "parked" | "exhausted" | "territory";
  detail: string;
}

export interface SchedulerResult {
  ready: ReadyEntry[];
  withheld: WithheldEntry[];
  /** Tickets in the queue at all, dispatchable or not. Zero means drained. */
  queueSize: number;
}

/**
 * A loop finishes what it started.
 *
 * A ticket the loop has already attempted stays in its queue even once its status moves out of
 * the query — a lane that fails partway leaves the ticket `in_progress`, and one that hits a
 * dependency leaves it `blocked`. Under a plain status filter both silently leave the queue,
 * and the loop reports `drained`: "all work complete" while a ticket sits half-finished.
 *
 * Reaching a closed status or `review` does release it. Those are the two ways a ticket
 * legitimately stops being the loop's problem.
 */
function loopRetains(ticket: Ticket, state: ReadonlyMap<string, LoopTicketState>): boolean {
  if (!state.has(ticket.id)) return false;
  if (!isOpenStatus(ticket.status)) return false;
  return ticket.status !== "review";
}

export function computeReadySet(inputs: SchedulerInputs): SchedulerResult {
  const { tickets, spec, state, inFlight, indexedFiles } = inputs;
  const maxAttempts = inputs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const inQueue = tickets.filter((ticket) => matchesQueue(ticket, spec) || loopRetains(ticket, state));
  const openIds = new Set(tickets.filter((t) => isOpenStatus(t.status)).map((t) => t.id));

  // rankTickets only ranks open tickets and already scores blocked ones last; the ordering it
  // produces is what the board would show, so the loop and the board agree on priority.
  const rankOrder = new Map<string, { index: number; reasons: string[] }>();
  rankTickets(tickets, inputs.now).forEach((entry, index) => {
    rankOrder.set(entry.ticket.id, { index, reasons: entry.reasons });
  });

  const ready: ReadyEntry[] = [];
  const withheld: WithheldEntry[] = [];

  // Claimed territory grows as tickets are admitted: two ready tickets must not conflict with
  // each other either, or a concurrency-2 loop would dispatch both halves of a collision.
  const claimed: Array<ReadonlySet<string>> = [...inFlight];

  const candidates = inQueue.slice().sort((a, b) => (
    (rankOrder.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER) - (rankOrder.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER)
  ));

  for (const ticket of candidates) {
    const ticketState = state.get(ticket.id);

    if (ticketState?.parkedOnGate) {
      withheld.push({ ticket, reason: "parked", detail: `Waiting on approval: ${ticketState.parkedOnGate}` });
      continue;
    }
    if ((ticketState?.attempts ?? 0) >= maxAttempts) {
      withheld.push({ ticket, reason: "exhausted", detail: `${ticketState?.attempts ?? 0} attempts, none succeeded.` });
      continue;
    }
    if (spec.respectBlockedBy) {
      const blockers = ticket.blockedBy.filter((id) => openIds.has(id));
      if (blockers.length) {
        withheld.push({ ticket, reason: "blocked", detail: `Blocked by ${blockers.join(", ")}.` });
        continue;
      }
    }
    if (ticket.status === "blocked") {
      withheld.push({ ticket, reason: "blocked", detail: "Marked blocked." });
      continue;
    }

    const territory = territoryOf(ticket, indexedFiles, ticketState?.touchedFiles ?? []);
    if (claimed.some((held) => territoryConflicts(territory, held))) {
      withheld.push({
        ticket,
        reason: "territory",
        detail: territory.has(UNTENANTED)
          ? "No declared territory, so it cannot run beside anything else."
          : "Territory overlaps a lane already running.",
      });
      continue;
    }

    claimed.push(territory);
    ready.push({ ticket, territory, reasons: rankOrder.get(ticket.id)?.reasons ?? [] });
  }

  return { ready, withheld, queueSize: inQueue.length };
}

/**
 * What the supervisor should do given a scheduling pass.
 *
 * Separated from computeReadySet because the distinction between "nothing ready right now" and
 * "nothing will ever be ready" is the difference between waiting and stopping, and it depends
 * on in-flight work that the ready-set computation deliberately knows nothing about.
 */
export function nextSupervisorAction(
  result: SchedulerResult,
  inFlightCount: number,
  freeSlots: number,
): "dispatch" | "wait" | "drained" | "blocked" {
  if (result.queueSize === 0) return inFlightCount > 0 ? "wait" : "drained";
  if (result.ready.length > 0 && freeSlots > 0) return "dispatch";
  if (inFlightCount > 0) return "wait";
  // Nothing ready, nothing running, but tickets remain — every one is blocked, parked or
  // exhausted. Answering a gate or closing a blocker can revive this, so it is not terminal.
  return "blocked";
}
