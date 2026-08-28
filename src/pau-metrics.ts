import { analyzeTrace, normalizeTrace, getProfile, getContextHogs } from "pau-profiler";
import type { CategorySummary, TokenAccountingGrade } from "pau-profiler";
import type { ModelPricing } from "./model-fetcher.js";
import type { CacheTtl } from "./agent-session.js";
import { breakEvenReads, cacheEconomicsFor } from "./pau-cache-economics.js";
import type { PauCacheObservation, PauCacheObserver } from "./pau-cache-observer.js";
import { buildCacheAwarePlan, type PauPlan } from "./pau-planner.js";

/**
 * Read-only context-utilization instrumentation, built on the companion open-source library
 * pau-profiler (github.com/RoofTopDude/pau-profiler). This module has no knowledge of
 * AgentMessage/ContentBlock — the caller (agent-session.ts) already owns the per-provider wire
 * conversion, so it hands over an already-shaped trace input plus a format label. Nothing here
 * can affect what gets sent to a model: it only ever runs against a message array that has
 * already been dispatched, and every entry point is wrapped so a failure here can't reach the
 * agent loop (mirrors the resilience compressor.ts already documents for background compaction).
 *
 * Three ledgers meet here. pau-profiler computes measurement (what context cost) and governance
 * (what must be preserved). pau-cache-economics.ts adds the third — what an action is actually
 * worth once the prompt cache is priced in — because prices are provider-specific and the
 * library rightly refuses to know them.
 */

const TOP_HOG_COUNT = 10;

export interface PauCaptureInput {
  /** `{ system, messages }` for the Anthropic-shaped path (Anthropic-direct, Bedrock Mantle), or
   *  an OpenAI-shaped messages array (system already folded in as the first message) for OpenAI/
   *  OpenRouter. Bedrock Converse has no supported format — callers must not reach this function
   *  for it (see `pauTraceFormatFor`). */
  traceInput: unknown;
  format: "anthropic" | "openai";
  runId: string;
  model: string;
  provider: string;
  contextWindow?: number;
  /**
   * The wire `tools` array. It is part of every request body but absent from any messages trace,
   * so without it the analysis silently under-counts by however large the tool catalog is — and
   * charges the difference to heuristic tokenization, depressing the accounting grade that
   * everything downstream gates on.
   */
  toolSchemas?: unknown;
  /** The turn's token classes kept apart. Collapsing them into one total, as this used to do,
   *  discards the entire subject of cache economics: they differ by up to 20x in price. */
  usage?: { input: number; cacheRead: number; cacheWrite: number };
  cacheTtl?: CacheTtl;
  /** Injected by the host — AgentSession does not own rate tables. Absent means unpriced, and
   *  unpriced degrades to "we don't know" rather than to a fabricated number. */
  pricing?: ModelPricing;
  /** Session-scoped prefix tracker. Absent disables the observed cache layer only. */
  observer?: PauCacheObserver;
  /** Turn number, used for the Lindy estimate of how long savings would have accrued. */
  iteration?: number;
}

export interface PauReceiptTopHog {
  id: string;
  type: string;
  source?: string;
  tokens: number;
  pau: number;
  pauShare: number;
  duplicateRatio: number;
  replayCount: number;
  effectiveHogScore: number;
  hogSeverity: string;
  recommendations: string[];
  /** Warm-prefix tokens a removal would invalidate. A high-scoring hog with a large blast radius
   *  is not a hog at all — it is load-bearing cache ballast. */
  blastTokens?: number;
  /** Net input-token-equivalents of removing it, after charging for the blast radius. */
  cacheNetITE?: number;
}

export interface PauEconomicsSummary {
  known: boolean;
  basis: string;
  readMultiplier: number;
  writeMultiplier: number;
  ttlSeconds: number;
  /** Reads needed before the write premium is repaid, or null where it never is. */
  breakEvenReads: number | null;
  /** Whether the session's observed reads-per-write has cleared break-even. Null when either
   *  side is unknown — this is the empirical answer to whether the configured TTL was right. */
  amortized: boolean | null;
}

export interface PauReceiptSummary {
  capturedAt: number;
  runId?: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
  totalTokens: number;
  totalPAU: number;
  tokenAccountingGrade: TokenAccountingGrade;
  tokenAccountingNote: string;
  rawUtilization: number | null;
  pauUtilization: number | null;
  duplicateTokenRatio: number;
  replayTokens: number;
  replayOverheadRatio: number;
  maxHogScore: number;
  contextHealthScore: number;
  categories: CategorySummary[];
  warnings: string[];
  /** Ranked by getContextHogs, capped — the full per-segment array (one entry per message/tool
   *  block) is not retained, so a long session can't grow this receipt unbounded. */
  topHogs: PauReceiptTopHog[];
  /** Tokens attributable to the wire tool catalog, counted for the first time. */
  toolSchemaTokens?: number;
  cache?: PauCacheObservation;
  economics?: PauEconomicsSummary;
  /** Advisory only. Rendered for a human; never fed back into the model's context. */
  plan?: PauPlan;
}

export type PauReceipt =
  | { skipped: true; reason: string }
  | ({ skipped: false } & PauReceiptSummary);

/** Maps this session's provider/API choice onto a pau-profiler trace format, or null when
 *  there's no supported shape yet. Bedrock Converse's ContentBlock shape (toolUse/toolResult)
 *  doesn't match pau-profiler's Anthropic adapter (tool_use/tool_result) or its OpenAI one —
 *  scoped out of v1 rather than risk a silently-wrong analysis; a small custom adapter is the
 *  natural fast-follow once the rest of this feature is validated against real sessions. */
export function pauTraceFormatFor(provider: string, useResponsesApi?: boolean, bedrockApi?: string): "anthropic" | "openai" | null {
  void useResponsesApi; // Responses API bodies are approximated via the same Chat-Completions-shaped conversion — see agent-session.ts.
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai" || provider === "openrouter") return "openai";
  if (provider === "bedrock") return bedrockApi === "mantle" ? "anthropic" : null;
  return null;
}

export function capturePauReceipt(input: PauCaptureInput): PauReceipt {
  try {
    const trace = normalizeTrace(input.traceInput, {
      format: input.format,
      runId: input.runId,
      model: input.model,
      provider: input.provider,
      contextWindow: input.contextWindow,
      providerTokenTotal: input.usage
        ? input.usage.input + input.usage.cacheRead + input.usage.cacheWrite
        : undefined,
      // Blacksite only has an aggregate per-turn token count (usage_update), never exact
      // per-segment counts — heuristic mode is exactly the scenario pau-profiler's
      // providerTokenTotal reconciliation and accounting-grade system were designed for.
      analysisMode: "heuristic",
    });

    // Tool schemas lead the cache prefix on every provider that has an explicit tools field, so
    // they go in front of the adapter's segments rather than at the end. Protected: the catalog
    // is not a candidate for eviction by this feature at any score.
    if (input.toolSchemas !== undefined) {
      const toolText = typeof input.toolSchemas === "string"
        ? input.toolSchemas
        : JSON.stringify(input.toolSchemas);
      if (toolText && toolText !== "[]") {
        trace.segments.unshift({
          id: "tools.0",
          type: "system",
          source: "wire.tools",
          content: toolText,
          protected: true,
          metadata: { blockType: "tool_schema" },
        });
      }
    }

    const receipt = analyzeTrace(trace, { profile: getProfile("coding") });

    const econ = cacheEconomicsFor(input.provider, input.cacheTtl, input.pricing);
    const observation = input.observer?.observe(
      receipt.segments.map((segment) => ({
        content: segment.contentHash ?? segment.id,
        tokens: segment.tokens,
      })),
      input.usage ?? { input: 0, cacheRead: 0, cacheWrite: 0 },
    );

    // Charge each candidate for the prefix it would invalidate. Before this turn's observation
    // the warm prefix is whatever survived into it, which is what the next eviction would break.
    const warmPrefixTokens = observation?.stablePrefixTokens ?? 0;
    const segmentTokens = receipt.segments.map((segment) => segment.tokens);
    const indexById = new Map<string, number>();
    receipt.segments.forEach((segment, index) => indexById.set(segment.id, index));

    const topHogs = getContextHogs(receipt)
      .slice(0, TOP_HOG_COUNT)
      .map((segment): PauReceiptTopHog => {
        const hog: PauReceiptTopHog = {
          id: segment.id,
          type: segment.type,
          tokens: segment.tokens,
          pau: segment.pau,
          pauShare: segment.pauShare,
          duplicateRatio: segment.duplicateRatio,
          replayCount: segment.replayCount,
          effectiveHogScore: segment.effectiveHogScore,
          hogSeverity: segment.hogSeverity,
          recommendations: segment.recommendations,
        };
        if (segment.source !== undefined) hog.source = segment.source;
        const index = indexById.get(segment.id);
        if (index != null && econ.known) {
          const blast = blastFor(segmentTokens, index, warmPrefixTokens);
          hog.blastTokens = blast.blastTokens;
          hog.cacheNetITE = blast.netITE(segment.tokens, econ.readMultiplier, econ.writeMultiplier, input.iteration ?? 1);
        }
        return hog;
      });

    const toolSegment = receipt.segments.find((segment) => segment.id === "tools.0");
    const readsPerWrite = observation?.readsPerWrite ?? null;
    const breakEven = breakEvenReads(econ);

    const summary: PauReceipt = {
      skipped: false,
      capturedAt: Date.now(),
      runId: receipt.runId,
      model: receipt.model,
      provider: receipt.provider,
      contextWindow: receipt.contextWindow,
      totalTokens: receipt.totalTokens,
      totalPAU: receipt.totalPAU,
      tokenAccountingGrade: receipt.tokenAccountingGrade,
      tokenAccountingNote: receipt.tokenAccountingNote,
      rawUtilization: receipt.rawUtilization,
      pauUtilization: receipt.pauUtilization,
      duplicateTokenRatio: receipt.duplicateTokenRatio,
      replayTokens: receipt.replayTokens,
      replayOverheadRatio: receipt.replayOverheadRatio,
      maxHogScore: receipt.maxHogScore,
      contextHealthScore: receipt.contextHealthScore,
      categories: receipt.categories,
      warnings: receipt.warnings,
      topHogs,
      economics: {
        known: econ.known,
        basis: econ.basis,
        readMultiplier: econ.readMultiplier,
        writeMultiplier: econ.writeMultiplier,
        ttlSeconds: econ.ttlSeconds,
        breakEvenReads: breakEven,
        amortized: breakEven == null || readsPerWrite == null ? null : readsPerWrite >= breakEven,
      },
    };
    if (toolSegment) summary.toolSchemaTokens = toolSegment.tokens;
    if (observation) summary.cache = observation;

    // The plan is the only part of this that reads the full segment array, and it is discarded
    // with the receipt — the slim summary above is what crosses the bus and fills the ring
    // buffer, so a long session cannot accumulate per-segment detail in memory.
    summary.plan = buildCacheAwarePlan(
      receipt,
      econ,
      warmPrefixTokens,
      input.iteration ?? 1,
      input.pricing?.inputPricePerM,
    );

    return summary;
  } catch (err) {
    return { skipped: true, reason: `analysis-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Local helper so the hog loop doesn't re-import the economics module's two functions per
 *  segment; keeps the blast-radius maths in exactly one place. */
function blastFor(segmentTokens: readonly number[], index: number, warmPrefixTokens: number) {
  let offset = 0;
  for (let i = 0; i <= index; i++) offset += segmentTokens[i] ?? 0;
  let after = 0;
  for (let i = index + 1; i < segmentTokens.length; i++) after += segmentTokens[i] ?? 0;
  const blastTokens = offset >= warmPrefixTokens
    ? 0
    : Math.max(0, Math.min(after, warmPrefixTokens - offset));
  return {
    blastTokens,
    netITE: (tokens: number, readMultiplier: number, writeMultiplier: number, iteration: number): number => {
      const turns = Math.max(1, Math.min(20, iteration));
      const saving = tokens * readMultiplier * turns;
      const cost = blastTokens * Math.max(0, writeMultiplier - readMultiplier);
      return Math.round(saving - cost);
    },
  };
}
