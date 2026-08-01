/**
 * What the model contributes to a loop: triage, not dispatch.
 *
 * The division that keeps this safe is that **the model proposes and the user commits**. A
 * proposal is inert — it creates a draft, and a draft never dispatches. Starting one is a user
 * action taken with the ceilings and the matched ticket list on screen. A feature whose premise
 * is "spend money unattended for hours" must not begin as a side effect of a chat turn.
 *
 * Where the model actually earns its place is the analysis a user cannot do quickly by hand:
 * reading thirty vague tickets and noticing that six are duplicates, that four are blocked by
 * one unfiled piece of work, and that the territory declarations are wrong in a way that would
 * serialize the whole loop.
 *
 * Pure — no store, no vscode.
 */

import { computeReadySet, territoryOf, UNTENANTED } from "./loop-scheduler.js";
import { laneComplexityFor, type LoopQueueSpec, type LoopTicketState } from "./loop-model.js";
import { isOpenStatus, type Ticket } from "../ticket-store.js";

/**
 * Rough per-lane cost, in USD, by budget tier.
 *
 * Deliberately coarse and deliberately an over-estimate. The number exists so a user can tell
 * "a few dollars" from "a few hundred" before starting an unattended run — precision would be
 * false comfort, since actual spend depends on the model, the repo, and how much the lane reads.
 * An estimate that reads low is far worse here than one that reads high.
 */
const LANE_COST_USD: Record<"standard" | "complex" | "deep", number> = {
  standard: 0.15,
  complex: 0.45,
  deep: 1.20,
};

export interface LoopCostEstimate {
  /** Sum over matched tickets of their tier's rate. */
  usd: number;
  byTier: Record<"standard" | "complex" | "deep", number>;
  /** Retries are not free. The high end assumes every ticket needs its full attempt budget. */
  worstCaseUsd: number;
  basis: string;
}

export function estimateLoopCost(tickets: readonly Ticket[], maxAttempts = 2): LoopCostEstimate {
  const byTier = { standard: 0, complex: 0, deep: 0 };
  let usd = 0;
  for (const ticket of tickets) {
    const tier = laneComplexityFor(ticket.complexity ?? "small");
    byTier[tier] += 1;
    usd += LANE_COST_USD[tier];
  }
  return {
    usd: Number(usd.toFixed(2)),
    byTier,
    worstCaseUsd: Number((usd * maxAttempts).toFixed(2)),
    basis: "Coarse per-lane rates by complexity tier, rounded up. Actual spend depends on the "
      + "model and how much each lane reads; treat this as an order of magnitude, not a quote.",
  };
}

export type LoopConcernKind =
  | "no_acceptance_criteria"
  | "untenanted"
  | "territory_collision"
  | "blocked_by_open"
  | "possible_duplicate"
  | "unblockable";

export interface LoopConcern {
  kind: LoopConcernKind;
  ticketIds: string[];
  detail: string;
  /** What the user (or the agent, before proposing) should do about it. */
  suggestion: string;
}

/** Tickets whose titles are close enough to be worth a second look. Cheap and deliberately
 *  crude — this proposes a question, never an action. */
function possibleDuplicates(tickets: readonly Ticket[]): Array<[string, string]> {
  const normalize = (title: string): string => title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean).join(" ");
  const seen = new Map<string, string>();
  const pairs: Array<[string, string]> = [];
  for (const ticket of tickets) {
    const key = normalize(ticket.title);
    if (!key) continue;
    const prior = seen.get(key);
    if (prior) pairs.push([prior, ticket.id]);
    else seen.set(key, ticket.id);
  }
  return pairs;
}

/**
 * Everything about this queue that would make the loop worse than the user expects.
 *
 * Reported before the loop is created rather than discovered during it. Most of these are
 * cheap to fix by hand and expensive to discover at hour three.
 */
export function analyzeQueue(
  tickets: readonly Ticket[],
  spec: LoopQueueSpec,
  indexedFiles: readonly string[],
): LoopConcern[] {
  const concerns: LoopConcern[] = [];
  const matched = computeReadySet({
    tickets,
    spec,
    state: new Map<string, LoopTicketState>(),
    inFlight: [],
    indexedFiles,
  });
  const inQueue = tickets.filter((ticket) => matched.ready.some((entry) => entry.ticket.id === ticket.id)
    || matched.withheld.some((entry) => entry.ticket.id === ticket.id));

  const missingCriteria = inQueue.filter((ticket) => !ticket.acceptanceCriteria.length);
  if (missingCriteria.length) {
    concerns.push({
      kind: "no_acceptance_criteria",
      ticketIds: missingCriteria.map((ticket) => ticket.id),
      detail: `${missingCriteria.length} of ${inQueue.length} ticket(s) have no acceptance criteria.`,
      suggestion: "A reviewer cannot judge \"done\" against criteria that do not exist. Add them, "
        + "or expect to read each lane's answer closely to work out what it decided \"done\" meant.",
    });
  }

  const untenanted = inQueue.filter((ticket) => territoryOf(ticket, indexedFiles).has(UNTENANTED));
  if (untenanted.length) {
    concerns.push({
      kind: "untenanted",
      ticketIds: untenanted.map((ticket) => ticket.id),
      detail: `${untenanted.length} ticket(s) declare no territory.`,
      // The counter-intuitive consequence, stated plainly, because it silently destroys the
      // benefit of raising concurrency.
      suggestion: "A ticket with no declared territory conflicts with everything, so it can never "
        + "run beside another lane. Declaring territory on these is what makes concurrency > 1 do anything.",
    });
  }

  const collisions = new Map<string, string[]>();
  const resolved = inQueue.map((ticket) => [ticket, territoryOf(ticket, indexedFiles)] as const);
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const [a, ta] = resolved[i]!;
      const [b, tb] = resolved[j]!;
      if (ta.has(UNTENANTED) || tb.has(UNTENANTED)) continue;
      const overlap = [...ta].some((file) => tb.has(file));
      if (!overlap) continue;
      collisions.set(a.id, [...(collisions.get(a.id) ?? []), b.id]);
    }
  }
  if (collisions.size) {
    concerns.push({
      kind: "territory_collision",
      ticketIds: [...collisions.keys()],
      detail: `${collisions.size} ticket(s) overlap another ticket's territory and will be serialized.`,
      suggestion: "Not an error — the lock is what prevents interleaved writes. But raising "
        + "concurrency will not speed these up.",
    });
  }

  const openIds = new Set(tickets.filter((ticket) => isOpenStatus(ticket.status)).map((ticket) => ticket.id));
  const blocked = inQueue.filter((ticket) => ticket.blockedBy.some((id) => openIds.has(id)));
  if (blocked.length && spec.respectBlockedBy) {
    const blockers = new Set(blocked.flatMap((ticket) => ticket.blockedBy.filter((id) => openIds.has(id))));
    const outsideQueue = [...blockers].filter((id) => !inQueue.some((ticket) => ticket.id === id));
    concerns.push({
      kind: outsideQueue.length ? "unblockable" : "blocked_by_open",
      ticketIds: blocked.map((ticket) => ticket.id),
      detail: outsideQueue.length
        ? `${blocked.length} ticket(s) are blocked by ${outsideQueue.length} ticket(s) the loop will never work: ${outsideQueue.slice(0, 5).join(", ")}.`
        : `${blocked.length} ticket(s) are blocked by others in the same queue and will wait their turn.`,
      suggestion: outsideQueue.length
        ? "The loop cannot unblock these. Widen the queue to include the blockers, close them by "
          + "hand first, or the loop will end \"blocked\" with real work left."
        : "Expected — the loop will order them correctly.",
    });
  }

  for (const [a, b] of possibleDuplicates(inQueue)) {
    concerns.push({
      kind: "possible_duplicate",
      ticketIds: [a, b],
      detail: `${a} and ${b} have effectively the same title.`,
      suggestion: "Check before running: two lanes doing the same work on the same files is the "
        + "one collision territory locking cannot catch, because they are separate tickets.",
    });
  }

  return concerns;
}

export interface LoopProposal {
  matchedTicketIds: string[];
  /** Dispatch order the loop would actually use, for the first pass. */
  firstWave: string[];
  withheld: Array<{ ticketId: string; reason: string; detail: string }>;
  recommendedConcurrency: number;
  concurrencyBasis: string;
  estimate: LoopCostEstimate;
  concerns: LoopConcern[];
}

/**
 * Recommend a concurrency.
 *
 * Bounded by how many tickets can actually run beside each other, which is usually far below
 * what the user would pick. Recommending 4 for a queue where every ticket collides would be
 * worse than useless: it reads as a promise of speed the lock will not deliver.
 */
export function recommendConcurrency(readyCount: number, queueSize: number): { concurrency: number; basis: string } {
  if (queueSize <= 1) return { concurrency: 1, basis: "Only one ticket to work." };
  if (readyCount <= 1) {
    return {
      concurrency: 1,
      basis: "Only one ticket can start without a territory conflict, so extra workers would idle.",
    };
  }
  const concurrency = Math.max(1, Math.min(readyCount, 4));
  return {
    concurrency,
    basis: `${readyCount} ticket(s) can run side by side without overlapping territory.`,
  };
}

export function proposeLoop(
  tickets: readonly Ticket[],
  spec: LoopQueueSpec,
  indexedFiles: readonly string[],
  maxAttempts = 2,
): LoopProposal {
  const scheduled = computeReadySet({
    tickets,
    spec,
    state: new Map<string, LoopTicketState>(),
    inFlight: [],
    indexedFiles,
  });
  const matchedIds = [
    ...scheduled.ready.map((entry) => entry.ticket.id),
    ...scheduled.withheld.map((entry) => entry.ticket.id),
  ];
  const matched = tickets.filter((ticket) => matchedIds.includes(ticket.id));
  const { concurrency, basis } = recommendConcurrency(scheduled.ready.length, scheduled.queueSize);

  return {
    matchedTicketIds: matchedIds,
    firstWave: scheduled.ready.slice(0, concurrency).map((entry) => entry.ticket.id),
    withheld: scheduled.withheld.map((entry) => ({
      ticketId: entry.ticket.id,
      reason: entry.reason,
      detail: entry.detail,
    })),
    recommendedConcurrency: concurrency,
    concurrencyBasis: basis,
    estimate: estimateLoopCost(matched, maxAttempts),
    concerns: analyzeQueue(tickets, spec, indexedFiles),
  };
}
