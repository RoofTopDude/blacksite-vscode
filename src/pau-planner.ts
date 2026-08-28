import { buildOptimizationPlan } from "pau-profiler";
import type { ContextReceipt, OptimizationPolicyName } from "pau-profiler";
import {
  blastRadiusTokens,
  cacheAdjustedNetValue,
  type CacheAdjustedValue,
  type CacheEconomics,
} from "./pau-cache-economics.js";

/**
 * Advisory optimization planning, re-ranked by cache economics.
 *
 * pau-profiler's optimizer ranks candidate actions by `removableLoadValue` — expected savings
 * weighted by quality risk, confidence, and governance feasibility. What it has no term for is
 * *position*. Because every provider caches a prefix, removing a segment invalidates everything
 * cached after it, so two identically-sized segments at opposite ends of the conversation differ
 * by an order of magnitude in real cost while the library ranks them the same.
 *
 * This module takes the library's plan and re-sorts it by net value after charging each action
 * for the prefix it would invalidate. It does not modify the library, and it deliberately does
 * not push prices down into it via the `utility`/`density` knobs — that would make an explicitly
 * provider-agnostic profiler provider-coupled forever.
 *
 * Nothing here actuates. The plan is rendered for a human and never enters the model's context:
 * feeding it back would change what is sent, which is precisely the guarantee
 * `blacksite.pau.enabled` advertises.
 */

/** Kept small — this rides into a webview on every turn and the panel shows a shortlist. */
const MAX_PLANNED_ACTIONS = 12;

export interface PauPlannedAction {
  segmentId: string;
  /** Stable, harness-owned identity (`tool:{tool_use_id}`) where the adapter supplied one.
   *  Segment ids are positional and are renumbered by compaction; any future actuation must key
   *  on this instead. */
  source?: string;
  segmentType: string;
  action: string;
  transformation: string;
  reason: string;
  confidence: string;
  currentTokenSavings: number;
  futureReplayTokenSavings: number;
  qualityRiskProbability: number;
  /** The library's own ranking, before cache economics — kept so the two can be compared. */
  removableLoadValue: number;
  /** Tokens of warm prefix this action would force a rewrite of. */
  blastTokens: number;
  cache: CacheAdjustedValue;
  /** The library ranked this worth doing; charged for its blast radius, it is not. */
  cacheNegative: boolean;
}

export interface PauPlan {
  policy: string;
  totalCurrentTokenSavings: number;
  projectedTotalTokens: number;
  governanceLockedSegments: number;
  actions: PauPlannedAction[];
  /** How many of the library's positive-value actions cache economics pushes below zero. When
   *  this is always zero, the economics ledger is not doing anything and something is miswired. */
  demotedByCache: number;
  priced: boolean;
  expectedRemainingTurns: number;
}

/**
 * How many more turns a segment would have been re-read had it stayed.
 *
 * Savings accrue once per remaining turn, so this term scales the entire benefit side — and it
 * is genuinely unknowable. A Lindy estimate is the least-wrong option available: assume a
 * session runs about as long again as it already has, bounded so neither a first turn nor a
 * marathon produces an absurd multiplier. Exported and named so that the assumption is visible
 * rather than buried in a magic number.
 */
export function expectedRemainingTurns(iteration: number): number {
  return Math.max(1, Math.min(20, iteration));
}

export function buildCacheAwarePlan(
  receipt: ContextReceipt,
  econ: CacheEconomics,
  warmPrefixTokens: number,
  iteration: number,
  baseInputPricePerM?: number,
  policy: OptimizationPolicyName = "balanced",
): PauPlan {
  const plan = buildOptimizationPlan(receipt, policy);
  const turns = expectedRemainingTurns(iteration);

  const segmentTokens = receipt.segments.map((segment) => segment.tokens);
  const indexById = new Map<string, number>();
  receipt.segments.forEach((segment, index) => indexById.set(segment.id, index));

  let demotedByCache = 0;
  const actions: PauPlannedAction[] = plan.actions.map((action) => {
    const index = indexById.get(action.segmentId);
    const blastTokens = index == null ? 0 : blastRadiusTokens(segmentTokens, index, warmPrefixTokens);
    const tokens = index == null ? 0 : (segmentTokens[index] ?? 0);
    const cache = cacheAdjustedNetValue(tokens, blastTokens, turns, econ, baseInputPricePerM);
    const cacheNegative = econ.known && cache.netITE < 0;
    if (cacheNegative) demotedByCache++;
    const planned: PauPlannedAction = {
      segmentId: action.segmentId,
      segmentType: action.segmentType,
      action: action.action,
      transformation: action.transformation,
      reason: action.reason,
      confidence: action.confidence,
      currentTokenSavings: action.currentTokenSavings,
      futureReplayTokenSavings: action.futureReplayTokenSavings,
      qualityRiskProbability: action.qualityRiskProbability,
      removableLoadValue: action.removableLoadValue,
      blastTokens,
      cache,
      cacheNegative,
    };
    if (action.source !== undefined) planned.source = action.source;
    return planned;
  });

  // Unpriced sessions keep the library's ordering rather than sorting on numbers that mean
  // nothing — an honest "we don't know" beats a confident wrong order.
  if (econ.known) actions.sort((a, b) => b.cache.netITE - a.cache.netITE);

  return {
    policy: plan.policy,
    totalCurrentTokenSavings: plan.totalCurrentTokenSavings,
    projectedTotalTokens: plan.projectedTotalTokens,
    governanceLockedSegments: plan.governanceLockedSegments.length,
    actions: actions.slice(0, MAX_PLANNED_ACTIONS),
    demotedByCache,
    priced: econ.known,
    expectedRemainingTurns: turns,
  };
}
