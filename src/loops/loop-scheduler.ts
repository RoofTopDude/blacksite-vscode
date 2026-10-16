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
  createTerritoryResolver,
  isOpenStatus,
  rankTickets,
  type TerritoryResolver,
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
  /** Why this ticket ranked where it did, straight from rankTickets (plus the graph's terms in graph mode). */
  reasons: string[];
  /** Graph mode: the score it was ranked by. */
  score?: number;
}

/**
 * What the graph-aware scheduler reads from the work graph (#15). Built by the host once per
 * scheduling pass; pure to consume. Ticket ids are bare ("BLK-12"), not graph node ids.
 */
export interface SchedulingGraph {
  /** Dependencies of this ticket that are not done: declared or observed ones, and ones whose target does not exist. */
  hardBlockers(ticketId: string): Array<{ id: string; missing: boolean; source: string }>;
  /** Open tickets that wait on this one, directly or further down the chain. */
  downstreamOpen(ticketId: string): string[];
  /** On the longest chain of open work, and that chain's weight. */
  criticalPath(): { ids: ReadonlySet<string>; weight: number };
  /** The dependency cycle this ticket is part of, if any. */
  cycleOf(ticketId: string): string[] | undefined;
  /** Inputs this ticket consumes that open work has yet to produce (#17 fills these in). */
  waitingInputs(ticketId: string): string[];
  /** Files receipts saw this ticket's lanes change, across attempts. */
  observedFiles(ticketId: string): string[];
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
  /** The latest receipt status per ticket, for `dependencySatisfiedBy: "verified_review"` (D6). */
  latestReceipt?: (ticketId: string) => string | undefined;
  /** Present: rank and admit with the work graph (#15). Absent: exactly the legacy behaviour. */
  graph?: SchedulingGraph;
  /** Graph mode: paths other lanes hold claims on right now (#19), path → who. */
  held?: ReadonlyMap<string, string>;
  /** Graph mode: spend left under the loop's ceiling, and the median spend of its past lanes by complexity (≥ 3 samples). */
  budget?: { remainingUsd: number; medianUsd: Partial<Record<"small" | "medium" | "large", number>> };
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
  /** The index, or a resolver already built over it — scheduling walks a whole queue, and
   *  rebuilding the index per ticket is O(tickets x indexed files) for no benefit. */
  index: readonly string[] | TerritoryResolver,
  touched: readonly string[] = [],
): Set<string> {
  const resolver = Array.isArray(index) ? createTerritoryResolver(index) : index as TerritoryResolver;
  const declared = resolver.resolve(ticket.territory);
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
  /** `incoherent` (a dependency cycle or a dependency that does not exist), `waiting_input` and
   *  `budget` come only from the graph-aware scheduler (#15). */
  reason: "blocked" | "parked" | "exhausted" | "territory" | "incoherent" | "waiting_input" | "budget";
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

/**
 * Whether a dependency counts as met. Closed is always met. With the loop's opt-in (D6), a blocker
 * in review whose latest receipt is `verified` is met too — the user still closes it.
 */
function dependencyMet(id: string, byId: ReadonlyMap<string, Ticket>, spec: LoopQueueSpec, latestReceipt?: (ticketId: string) => string | undefined): boolean {
  const blocker = byId.get(id);
  if (!blocker || !isOpenStatus(blocker.status)) return true;
  return spec.dependencySatisfiedBy === "verified_review" && blocker.status === "review" && latestReceipt?.(id) === "verified";
}

export function computeReadySet(inputs: SchedulerInputs): SchedulerResult {
  if (inputs.graph) return computeGraphReadySet(inputs, inputs.graph);
  const { tickets, spec, state, inFlight, indexedFiles } = inputs;
  const maxAttempts = inputs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const inQueue = tickets.filter((ticket) => matchesQueue(ticket, spec) || loopRetains(ticket, state));
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));

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

  const resolver = createTerritoryResolver(indexedFiles);

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
      const blockers = ticket.blockedBy.filter((id) => !dependencyMet(id, byId, spec, inputs.latestReceipt));
      if (blockers.length) {
        withheld.push({ ticket, reason: "blocked", detail: `Blocked by ${blockers.join(", ")}.` });
        continue;
      }
    }
    if (ticket.status === "blocked") {
      withheld.push({ ticket, reason: "blocked", detail: "Marked blocked." });
      continue;
    }

    const territory = territoryOf(ticket, resolver, ticketState?.touchedFiles ?? []);
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

/** Graph-mode score terms (#15). Bounded, except the starvation credit, which is what guarantees
 *  every ready ticket eventually outranks any graph-favoured rival. */
export const GRAPH_SCORE = {
  unblockPerTicket: 8,
  unblockMax: 40,
  criticalPath: 25,
  passedOver: 10,
  recentConflict: -30,
} as const;

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * The graph-aware ready set (#15). The same withholding as legacy — parked, out of attempts,
 * blocked — plus what only the graph can see: a dependency that does not exist or a dependency
 * cycle (shown as `incoherent`, never silently run or dropped), inputs still being produced, live
 * claims held by other lanes, and spend. Ranked by the board's own score plus how much open work
 * each ticket unblocks and whether it sits on the critical path, with a starvation credit for
 * every pass a ready ticket waited. Ties break by priority, recency, then id: the same inputs in
 * any order give the same decision.
 */
export function computeGraphReadySet(inputs: SchedulerInputs, graph: SchedulingGraph): SchedulerResult {
  const { tickets, spec, state, inFlight, indexedFiles } = inputs;
  const maxAttempts = inputs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const inQueue = tickets.filter((ticket) => matchesQueue(ticket, spec) || loopRetains(ticket, state));
  const ranked = new Map(rankTickets(tickets, inputs.now).map((entry) => [entry.ticket.id, entry] as const));
  const critical = graph.criticalPath();
  const resolver = createTerritoryResolver(indexedFiles);
  const heldKeys = new Map<string, string>();
  for (const [file, who] of inputs.held ?? []) heldKeys.set(file.toLowerCase(), who);

  const withheld: WithheldEntry[] = [];
  const candidates: Array<{ ticket: Ticket; score: number; reasons: string[] }> = [];

  for (const ticket of inQueue) {
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
      const cycle = graph.cycleOf(ticket.id);
      if (cycle) {
        withheld.push({ ticket, reason: "incoherent", detail: `In a dependency cycle: ${[...cycle, cycle[0]].join(" → ")}.` });
        continue;
      }
      const blockers = graph.hardBlockers(ticket.id);
      const missing = blockers.filter((entry) => entry.missing).map((entry) => entry.id);
      if (missing.length) {
        withheld.push({ ticket, reason: "incoherent", detail: `Depends on ${missing.join(", ")}, which ${missing.length === 1 ? "does" : "do"} not exist.` });
        continue;
      }
      const unmet = blockers.filter((entry) => !dependencyMet(entry.id, byId, spec, inputs.latestReceipt)).map((entry) => entry.id);
      if (unmet.length) {
        withheld.push({ ticket, reason: "blocked", detail: `Blocked by ${unmet.join(", ")}.` });
        continue;
      }
    }
    if (ticket.status === "blocked") {
      withheld.push({ ticket, reason: "blocked", detail: "Marked blocked." });
      continue;
    }
    const inputsPending = graph.waitingInputs(ticket.id);
    if (inputsPending.length) {
      withheld.push({ ticket, reason: "waiting_input", detail: `Waiting on ${inputsPending.slice(0, 3).join(", ")} to be produced.` });
      continue;
    }

    const base = ranked.get(ticket.id);
    let score = base?.score ?? 0;
    // The board's own reasons, minus a "blocked by" that the dependency check has just ruled met.
    const reasons = (base?.reasons ?? []).filter((reason) => !reason.startsWith("blocked by"));
    if (base && base.blockedByOpen.length) score += 1000;
    const downstream = graph.downstreamOpen(ticket.id);
    if (downstream.length) {
      score += Math.min(GRAPH_SCORE.unblockMax, GRAPH_SCORE.unblockPerTicket * downstream.length);
      reasons.push(`unblocks ${downstream.length} ticket${downstream.length === 1 ? "" : "s"} (${downstream.slice(0, 3).join(", ")}${downstream.length > 3 ? ", …" : ""})`);
    }
    if (critical.ids.has(ticket.id)) {
      score += GRAPH_SCORE.criticalPath;
      reasons.push(`on the critical path (weight ${critical.weight})`);
    }
    const waited = ticketState?.passedOver ?? 0;
    if (waited > 0) {
      score += GRAPH_SCORE.passedOver * waited;
      reasons.push(`passed over ${waited} time${waited === 1 ? "" : "s"}`);
    }
    if (ticketState?.lastClaimConflict) {
      score += GRAPH_SCORE.recentConflict;
      reasons.push(`collided last time (${ticketState.lastClaimConflict})`);
    }
    candidates.push({ ticket, score, reasons });
  }

  candidates.sort((a, b) => b.score - a.score
    || (PRIORITY_ORDER[a.ticket.priority] ?? 9) - (PRIORITY_ORDER[b.ticket.priority] ?? 9)
    || b.ticket.updatedAt.localeCompare(a.ticket.updatedAt)
    || a.ticket.id.localeCompare(b.ticket.id));

  const ready: ReadyEntry[] = [];
  const claimed: Array<ReadonlySet<string>> = [...inFlight];
  for (const { ticket, score, reasons } of candidates) {
    const ticketState = state.get(ticket.id);
    const territory = territoryOf(ticket, resolver, [...(ticketState?.touchedFiles ?? []), ...graph.observedFiles(ticket.id)]);
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
    const heldBy = territory.has(UNTENANTED)
      ? (heldKeys.size ? [...heldKeys.values()][0] : undefined)
      : [...territory].map((file) => heldKeys.get(file.toLowerCase())).find((who) => who !== undefined);
    if (heldBy) {
      withheld.push({ ticket, reason: "territory", detail: `${heldBy} is writing files this ticket covers.` });
      continue;
    }
    // Large work, and work that collided last time, runs alone (plan §4.5 tier 2).
    const runsAlone = ticket.complexity === "large" || !!ticketState?.lastClaimConflict;
    if (runsAlone && (claimed.length > 0)) {
      withheld.push({ ticket, reason: "territory", detail: ticket.complexity === "large" ? "Large: runs only when nothing else is running." : "Collided with another lane last time: runs alone." });
      continue;
    }
    const median = inputs.budget?.medianUsd[ticket.complexity ?? "small"];
    if (inputs.budget && median !== undefined && inputs.budget.remainingUsd < median) {
      withheld.push({ ticket, reason: "budget", detail: `About $${median.toFixed(2)} for a lane like this; $${inputs.budget.remainingUsd.toFixed(2)} of the ceiling is left.` });
      continue;
    }
    claimed.push(runsAlone ? new Set([UNTENANTED]) : territory);
    ready.push({ ticket, territory, reasons, score });
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
