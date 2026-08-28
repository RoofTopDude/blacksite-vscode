import { fingerprint } from "pau-profiler";

/**
 * Observed cache behaviour — the layer that needs no prices at all.
 *
 * Every provider reports how many input tokens were fresh, read from cache, and written to
 * cache. From those three counts plus the harness's own view of its request prefix, the
 * questions that matter most ("is this session's cache working, and what keeps breaking it")
 * are answerable without knowing a single rate.
 *
 * That independence is the point rather than a convenience. OpenRouter routes to arbitrary
 * backends, so a rate table for it is a fiction someone has to maintain forever — but the usage
 * counts come back regardless, and so does the harness's own knowledge of which bytes it
 * resent. Everything here therefore works on a provider nobody has written a table for yet.
 * Prices arrive one layer up, in pau-cache-economics.ts, and degrade to "unpriced" when absent.
 */

export interface PauCacheObservation {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Share of this turn's input tokens served from cache. */
  hitRatio: number;
  /**
   * Longest run of leading segments byte-identical to last turn's, in tokens — the harness's own
   * view of what *should* have stayed warm. Null on a session's first measured turn, where there
   * is nothing to compare against; zero means the prefix was rewritten from the very first
   * segment, which is what a compaction looks like from here.
   */
  stablePrefixTokens: number | null;
  stablePrefixRatio: number | null;
  /** Tokens that dropped out of the stable prefix this turn. */
  invalidatedTokens: number;
  cumulativeInvalidatedTokens: number;
  /**
   * Cumulative cache reads per cache write across the session. Compared against
   * `breakEvenReads()` this answers whether caching has paid for its own write premium — and
   * therefore whether the configured TTL was the right call. Null until something is written.
   */
  readsPerWrite: number | null;
}

/** One segment as the observer needs it: identity by content, weight in tokens. */
export interface ObservedSegment {
  content: string;
  tokens: number;
}

export interface ObservedUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Session-scoped. One instance per AgentSession, including each delegated subagent lane, since
 * a lane runs its own prefix against its own model and mixing the two would make both readings
 * meaningless.
 */
export class PauCacheObserver {
  private _prevLadder: string[] = [];
  private _prevCumulativeTokens: number[] = [];
  private _prevTotalTokens = 0;
  private _seenTurn = false;
  private _cumulativeRead = 0;
  private _cumulativeWrite = 0;
  private _cumulativeInvalidated = 0;

  observe(segments: readonly ObservedSegment[], usage: ObservedUsage): PauCacheObservation {
    // A rolling fingerprint over the ordered segments: entry i identifies the whole prefix up to
    // and including segment i, so the first index at which two ladders disagree is the first
    // point at which the two requests stopped sharing a cacheable prefix.
    const ladder: string[] = [];
    const cumulativeTokens: number[] = [];
    let running = "";
    let runningTokens = 0;
    for (const segment of segments) {
      running = fingerprint(`${running}\u0000${segment.content}`);
      runningTokens += segment.tokens;
      ladder.push(running);
      cumulativeTokens.push(runningTokens);
    }

    let stablePrefixTokens: number | null = null;
    let invalidatedTokens = 0;
    if (this._seenTurn) {
      let shared = 0;
      const limit = Math.min(ladder.length, this._prevLadder.length);
      while (shared < limit && ladder[shared] === this._prevLadder[shared]) shared++;
      stablePrefixTokens = shared === 0 ? 0 : (cumulativeTokens[shared - 1] ?? 0);
      // What the previous request had cached beyond the surviving prefix is what this request
      // threw away. Growth at the tail is not invalidation — only the shortfall counts.
      invalidatedTokens = Math.max(0, this._prevTotalTokens - stablePrefixTokens);
      this._cumulativeInvalidated += invalidatedTokens;
    }

    this._prevLadder = ladder;
    this._prevCumulativeTokens = cumulativeTokens;
    this._prevTotalTokens = runningTokens;
    this._seenTurn = true;
    this._cumulativeRead += usage.cacheRead;
    this._cumulativeWrite += usage.cacheWrite;

    const billed = usage.input + usage.cacheRead + usage.cacheWrite;
    return {
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      hitRatio: billed > 0 ? usage.cacheRead / billed : 0,
      stablePrefixTokens,
      stablePrefixRatio: stablePrefixTokens == null || runningTokens === 0
        ? null
        : stablePrefixTokens / runningTokens,
      invalidatedTokens,
      cumulativeInvalidatedTokens: this._cumulativeInvalidated,
      readsPerWrite: this._cumulativeWrite > 0 ? this._cumulativeRead / this._cumulativeWrite : null,
    };
  }

  /** Token offset of the prefix believed warm going into the next turn — the bound
   *  `blastRadiusTokens` charges evictions against. */
  get warmPrefixTokens(): number {
    return this._prevTotalTokens;
  }

  /** Cumulative token ladder for the last observed turn, so callers can locate a segment's
   *  offset without rebuilding it. */
  get lastCumulativeTokens(): readonly number[] {
    return this._prevCumulativeTokens;
  }
}
