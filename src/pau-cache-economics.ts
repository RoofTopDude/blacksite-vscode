import {
  CLAUDE_CACHE_READ_RATIO,
  CLAUDE_CACHE_WRITE_RATIO_5M,
  CLAUDE_CACHE_WRITE_RATIO_1H,
  type ModelPricing,
} from "./model-fetcher.js";
import type { CacheTtl } from "./agent-session.js";

/**
 * Cache economics — the third ledger.
 *
 * pau-profiler keeps two ledgers: measurement (what context cost and what it appeared to
 * contribute) and governance (what the system must preserve). Neither knows what anything is
 * worth in money, and neither should: prices are provider-specific and would couple the library
 * to a rate table it can never keep current. This module is the third ledger, computed
 * harness-side and applied at the policy layer. Measurement says what is big, governance says
 * what is allowed, economics says what is worth it.
 *
 * Everything here is denominated in **input-token-equivalents (ITE)** rather than dollars. The
 * multipliers between fresh input, a cache read, and a cache write are far more universally
 * knowable than absolute per-million rates — an OpenRouter row may quote no price at all while
 * still behaving like a 0.1x-read cache. Converting ITE to USD is one multiply at the end, and
 * only when a base rate is actually known.
 */

/**
 * The complete provider-specific surface of prompt caching. It is this small because prefix
 * caching is structurally identical everywhere: every provider caches a prefix of the request,
 * none caches a middle segment, and each charges some multiple of the base input rate to write
 * and a smaller multiple to read.
 */
export interface CacheEconomics {
  /** Cost to write a token into the cache, as a multiple of the base input rate. */
  writeMultiplier: number;
  /** Cost to read a cached token, as a multiple of the base input rate. */
  readMultiplier: number;
  /**
   * Rent charged per cached token per hour, as a multiple of the base input rate. Zero for
   * Anthropic and OpenAI, which charge only at write and read time. Gemini-style explicit caches
   * bill for storage over time, and an abstraction that omits this field simply cannot express
   * them — so it stays, set to zero, rather than being left out.
   */
  storagePerTokenHour: number;
  ttlSeconds: number;
  /** Below this, a prefix is not cacheable at all and the multipliers do not apply. */
  minCacheableTokens: number;
  placement: "explicit-breakpoint" | "implicit-prefix";
  maxBreakpoints: number | null;
  /**
   * False when the rates could not be resolved. Callers must render "unpriced" rather than a
   * fabricated number — the same posture pau-profiler takes when it grades heuristic accounting
   * instead of pretending to exact counts.
   */
  known: boolean;
  /** How the numbers above were arrived at, for display next to any figure derived from them. */
  basis: string;
}

interface ProviderCacheDefaults {
  readMultiplier: number;
  writeMultiplier5m: number;
  writeMultiplier1h: number | null;
  minCacheableTokens: number;
  placement: "explicit-breakpoint" | "implicit-prefix";
  maxBreakpoints: number | null;
}

const PROVIDER_CACHE_DEFAULTS: Record<string, ProviderCacheDefaults> = {
  anthropic: {
    readMultiplier: CLAUDE_CACHE_READ_RATIO,
    writeMultiplier5m: CLAUDE_CACHE_WRITE_RATIO_5M,
    writeMultiplier1h: CLAUDE_CACHE_WRITE_RATIO_1H,
    minCacheableTokens: 1024,
    placement: "explicit-breakpoint",
    maxBreakpoints: 4,
  },
  // Bedrock Mantle is the Messages API over SigV4 — same cache semantics, same breakpoints.
  bedrock: {
    readMultiplier: CLAUDE_CACHE_READ_RATIO,
    writeMultiplier5m: CLAUDE_CACHE_WRITE_RATIO_5M,
    writeMultiplier1h: CLAUDE_CACHE_WRITE_RATIO_1H,
    minCacheableTokens: 1024,
    placement: "explicit-breakpoint",
    maxBreakpoints: 4,
  },
  openai: {
    readMultiplier: 0.25,
    // OpenAI does not bill a write premium: entering the cache costs the ordinary input rate.
    // That makes its break-even a single read, which is why prefix churn matters far less there.
    writeMultiplier5m: 1,
    writeMultiplier1h: null,
    minCacheableTokens: 1024,
    placement: "implicit-prefix",
    maxBreakpoints: null,
  },
};

const TTL_SECONDS: Record<string, number> = { "5m": 300, "1h": 3600 };

/**
 * Resolve cache economics for a session.
 *
 * Prefers rates derived from the live catalog row, because a provider that quotes its own
 * cache columns (an OpenRouter model, say) is authoritative in a way a hardcoded constant is
 * not. Falls back to the provider default table, and finally to `known: false` rather than
 * guessing — an unpriced session must report itself as unpriced.
 */
export function cacheEconomicsFor(
  provider: string,
  cacheTtl: CacheTtl | undefined,
  pricing?: ModelPricing,
): CacheEconomics {
  const ttlSeconds = TTL_SECONDS[cacheTtl ?? "5m"] ?? TTL_SECONDS["5m"]!;
  const defaults = PROVIDER_CACHE_DEFAULTS[provider];

  const base = pricing?.inputPricePerM;
  if (base != null && base > 0 && pricing?.cacheReadPricePerM != null && pricing?.cacheWritePricePerM != null) {
    // Catalog cache-write rates are the 5-minute figure; the 1-hour breakpoint costs more.
    // Scale by the ratio between the two rather than re-deriving from input, which is what
    // estimateUsageCostUsd already does — a live row may not agree with the canonical ratio.
    const writePerM = cacheTtl === "1h"
      ? pricing.cacheWritePricePerM * (CLAUDE_CACHE_WRITE_RATIO_1H / CLAUDE_CACHE_WRITE_RATIO_5M)
      : pricing.cacheWritePricePerM;
    return {
      readMultiplier: pricing.cacheReadPricePerM / base,
      writeMultiplier: writePerM / base,
      storagePerTokenHour: 0,
      ttlSeconds,
      minCacheableTokens: defaults?.minCacheableTokens ?? 1024,
      placement: defaults?.placement ?? "implicit-prefix",
      maxBreakpoints: defaults?.maxBreakpoints ?? null,
      known: true,
      basis: "catalog rates",
    };
  }

  if (defaults) {
    const writeMultiplier = cacheTtl === "1h" && defaults.writeMultiplier1h != null
      ? defaults.writeMultiplier1h
      : defaults.writeMultiplier5m;
    return {
      readMultiplier: defaults.readMultiplier,
      writeMultiplier,
      storagePerTokenHour: 0,
      ttlSeconds,
      minCacheableTokens: defaults.minCacheableTokens,
      placement: defaults.placement,
      maxBreakpoints: defaults.maxBreakpoints,
      known: true,
      basis: `${provider} defaults`,
    };
  }

  // OpenRouter routing to an unknown backend lands here, and so does any provider added later.
  // The multipliers below are inert placeholders that no caller should act on; `known: false`
  // is the operative field.
  return {
    readMultiplier: 1,
    writeMultiplier: 1,
    storagePerTokenHour: 0,
    ttlSeconds,
    minCacheableTokens: 1024,
    placement: "implicit-prefix",
    maxBreakpoints: null,
    known: false,
    basis: "unpriced",
  };
}

/**
 * How many times a cached segment must be read before caching it has paid for its own write.
 *
 * A cached token is not free: it costs the write premium up front and the read multiplier every
 * turn thereafter. Writing at 1.25x and reading at 0.1x means one read costs 1.35x against 1.0x
 * for simply sending it fresh — a loss. Only from ~1.4 reads on does it win. The 1-hour TTL
 * doubles the write premium and pushes break-even to ~2.2 reads, which is exactly the question
 * `blacksite.*.cacheTtl` is answering blind today.
 *
 * Returns null where the write premium can never be recovered (read rate at or above fresh).
 */
export function breakEvenReads(econ: CacheEconomics): number | null {
  if (!econ.known) return null;
  const margin = 1 - econ.readMultiplier;
  if (margin <= 0) return null;
  return econ.writeMultiplier / margin;
}

/**
 * Tokens that must be rewritten if the segment at `index` is removed.
 *
 * This is the formula the optimizer is missing. Every provider caches a prefix, so evicting a
 * segment invalidates the cache from that point on: the cost of removing something is not its
 * own size but the size of everything cached after it. Two segments of identical tokens, one
 * near the head and one near the tail, differ by an order of magnitude in real cost while
 * `removableLoadValue` ranks them identically.
 *
 * `cachedPrefixTokens` bounds the damage — anything past the warm prefix was going to be
 * rewritten regardless, so it is not charged to this eviction.
 */
export function blastRadiusTokens(
  segmentTokens: readonly number[],
  index: number,
  cachedPrefixTokens: number,
): number {
  if (index < 0 || index >= segmentTokens.length) return 0;
  let offset = 0;
  for (let i = 0; i <= index; i++) offset += segmentTokens[i] ?? 0;
  // Nothing after the warm prefix is at risk; nothing at all if the segment itself sits beyond it.
  if (offset >= cachedPrefixTokens) return 0;
  let after = 0;
  for (let i = index + 1; i < segmentTokens.length; i++) after += segmentTokens[i] ?? 0;
  return Math.max(0, Math.min(after, cachedPrefixTokens - offset));
}

export interface CacheAdjustedValue {
  /** Input-token-equivalents saved over the expected remaining life of the session. */
  savingITE: number;
  /** Input-token-equivalents burned rewriting the invalidated prefix. */
  costITE: number;
  netITE: number;
  /** Present only when a base input rate was resolvable. */
  netUsd?: number;
  /** False when economics were unpriced — net figures are then not meaningful. */
  priced: boolean;
}

/**
 * Net value of removing a segment, in input-token-equivalents.
 *
 * Saving accrues once per remaining turn at the read rate; cost is paid once, immediately, at
 * the difference between writing and reading the invalidated tail. A large stable segment
 * sitting in a warm prefix routinely comes out negative here while scoring as the session's
 * worst hog — it is not a hog, it is load-bearing cache ballast.
 */
export function cacheAdjustedNetValue(
  segmentTokens: number,
  blastTokens: number,
  expectedRemainingTurns: number,
  econ: CacheEconomics,
  baseInputPricePerM?: number,
): CacheAdjustedValue {
  const turns = Math.max(0, expectedRemainingTurns);
  const savingITE = segmentTokens * econ.readMultiplier * turns;
  const costITE = blastTokens * Math.max(0, econ.writeMultiplier - econ.readMultiplier);
  const netITE = savingITE - costITE;
  const value: CacheAdjustedValue = {
    savingITE: Math.round(savingITE),
    costITE: Math.round(costITE),
    netITE: Math.round(netITE),
    priced: econ.known,
  };
  if (econ.known && baseInputPricePerM != null) {
    value.netUsd = (netITE / 1_000_000) * baseInputPricePerM;
  }
  return value;
}
