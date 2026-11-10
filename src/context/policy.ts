/**
 * Aging policy: which tool results to set aside, and whether doing so now is worth it.
 *
 * Pure decisions from a ledger snapshot (docs/context-economy-implementation-plan.md, Phase 3.2–3.4).
 * The session applies them; this module never touches messages.
 *
 * Order: results a later read superseded, then results by age and size. Never a pinned item, never
 * anything in the recent window, never a result with no way back (rule 3 of the design stance), and
 * never one already set aside.
 *
 * Timing is the caller's (turn boundaries, or the budget crossed). The cost check is here: setting
 * aside an old result rewrites the cached prefix from that point on, once. Unless the context is
 * over its budget, aging acts only when the reads it saves over the horizon outweigh that rewrite.
 */
import type { ContextItem } from "./model.js";
import type { LedgerSnapshot } from "./ledger.js";

/** Tokens a set-aside record costs in place of the result. */
export const STUB_TOKEN_ESTIMATE = 120;
/** At a turn's first call, aging is considered from this fraction of the compaction threshold. */
export const AGING_TURN_START_FRACTION = 0.8;
/** Aging aims to bring the context down to this fraction of the compaction threshold. */
export const AGING_TARGET_FRACTION = 0.6;

export interface AgingCache {
  /** Price of a cached read, as a multiple of the base input price. */
  readMultiplier: number;
  /** Price of a cache write, as a multiple of the base input price. */
  writeMultiplier: number;
  /** Requests the saving is counted over. */
  horizonRequests: number;
}

export interface AgingOptions {
  /** The context's size now, in tokens (calibrated where the provider reported usage). */
  currentTokens: number;
  /** Aim for at most this many tokens. */
  targetTokens: number;
  /** Messages from this index on are the recent window and are never set aside. */
  recentStart: number;
  /** Results already set aside (or stubbed by any path), by tool call id. */
  alreadySetAside: ReadonlySet<string>;
  /** Smallest result worth setting aside for age alone. */
  minAgedTokens?: number;
  /** Smallest superseded result worth setting aside. */
  minSupersededTokens?: number;
  /** Over budget: act whatever the cache says. */
  force: boolean;
  /** Absent: unpriced, so the check passes only when forced. */
  cache?: AgingCache;
}

export type SetAsideReason = "superseded" | "aged";

export interface AgingCandidate {
  id: string;
  reason: SetAsideReason;
  tokens: number;
  messageIndex: number;
  supersededBy?: string;
}

export interface AgingDecision {
  /** What to set aside, in order. Empty when nothing qualifies or it is not worth it. */
  setAside: AgingCandidate[];
  /** Everything that qualified, before the cost check — what `observe` reports. */
  candidates: AgingCandidate[];
  freedTokens: number;
  /** Cached tokens a rewrite from the earliest set-aside result would cost. */
  rewriteTokens: number;
  worthIt: boolean;
  /** Why nothing was set aside, when nothing was. */
  reason?: "under-target" | "nothing-eligible" | "not-worth-the-rewrite";
}

function eligible(item: ContextItem, options: AgingOptions): boolean {
  return item.class === "tool-result"
    && !item.pinned
    && item.recall.kind !== "none"
    && item.messageIndex !== undefined
    && item.messageIndex < options.recentStart
    && !options.alreadySetAside.has(item.id);
}

/** Tokens of history from `messageIndex` on: what a change there makes the cache write again. */
export function tokensFrom(snapshot: LedgerSnapshot, messageIndex: number): number {
  let total = 0;
  for (const item of snapshot.items) {
    if (item.messageIndex !== undefined && item.messageIndex >= messageIndex) total += item.tokens;
  }
  return total;
}

export function planAging(snapshot: LedgerSnapshot, options: AgingOptions): AgingDecision {
  const minAged = options.minAgedTokens ?? 500;
  const minSuperseded = options.minSupersededTokens ?? STUB_TOKEN_ESTIMATE * 2;
  const pool = snapshot.items.filter((item) => eligible(item, options));

  const superseded = pool
    .filter((item) => item.supersededBy && item.tokens >= minSuperseded)
    .sort((a, b) => a.messageIndex! - b.messageIndex!)
    .map((item): AgingCandidate => ({ id: item.id, reason: "superseded", tokens: item.tokens, messageIndex: item.messageIndex!, supersededBy: item.supersededBy }));
  const taken = new Set(superseded.map((candidate) => candidate.id));
  // Older and larger first: tokens × distance from the recent window.
  const aged = pool
    .filter((item) => !taken.has(item.id) && item.tokens >= minAged)
    .sort((a, b) => b.tokens * (options.recentStart - b.messageIndex!) - a.tokens * (options.recentStart - a.messageIndex!) || a.messageIndex! - b.messageIndex!)
    .map((item): AgingCandidate => ({ id: item.id, reason: "aged", tokens: item.tokens, messageIndex: item.messageIndex! }));

  const ordered = [...superseded, ...aged];
  const empty = (reason: AgingDecision["reason"], candidates: AgingCandidate[] = []): AgingDecision =>
    ({ setAside: [], candidates, freedTokens: 0, rewriteTokens: 0, worthIt: false, reason });

  if (options.currentTokens <= options.targetTokens) return empty("under-target");
  if (ordered.length === 0) return empty("nothing-eligible");

  const chosen: AgingCandidate[] = [];
  let freed = 0;
  for (const candidate of ordered) {
    if (options.currentTokens - freed <= options.targetTokens) break;
    chosen.push(candidate);
    freed += Math.max(0, candidate.tokens - STUB_TOKEN_ESTIMATE);
  }

  const earliest = Math.min(...chosen.map((candidate) => candidate.messageIndex));
  const rewriteTokens = Math.max(0, tokensFrom(snapshot, earliest) - freed);
  let worthIt = options.force;
  if (!worthIt && options.cache) {
    const saving = freed * options.cache.readMultiplier * Math.max(1, options.cache.horizonRequests);
    const cost = rewriteTokens * Math.max(0, options.cache.writeMultiplier - options.cache.readMultiplier);
    worthIt = saving > cost;
  }
  if (!worthIt) return { ...empty("not-worth-the-rewrite", chosen), freedTokens: freed, rewriteTokens };
  return { setAside: chosen, candidates: chosen, freedTokens: freed, rewriteTokens, worthIt };
}
