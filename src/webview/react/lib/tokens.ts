/* Lightweight, dependency-free token estimation for the live composer gauge.

   A real BPE tokenizer (tiktoken/cl100k) would add ~1MB of rank tables to the
   webview bundle for what is only a rough "how big is this prompt" gauge. Instead
   we blend two cheap signals — a character bound (~4 chars/token) and a
   word/symbol atom count (~0.75 atoms/token) — which lands within roughly ±15% of
   cl100k / Claude tokenization across mixed prose and code. It is explicitly an
   estimate: the authoritative session totals come from provider usage events. */

/** Approximate the token count of a piece of text. Returns 0 for empty input. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Atoms = word runs and individual punctuation/symbols (BPE merges ~1.3 of these per token).
  const atoms = (text.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/gu) ?? []).length;
  const charBound = text.length / 4;
  return Math.max(1, Math.round((atoms * 0.75 + charBound) / 2));
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Grand total of billed tokens across all channels. */
export function usageTotal(u: UsageTotals): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** Total tokens the model read as prompt (fresh input + cache read + cache write). */
export function usagePromptTotal(u: UsageTotals): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/**
 * Share of prompt tokens served from the provider's prompt cache, as a whole percentage
 * (0–100), or null before any prompt tokens have been recorded. This is the headline
 * "how much is caching saving" number for the session-stats row.
 */
export function cacheHitRatePct(u: UsageTotals): number | null {
  const prompt = usagePromptTotal(u);
  if (prompt <= 0 || u.cacheRead <= 0) return null;
  return Math.round((u.cacheRead / prompt) * 100);
}

/** Session spend, accumulated event-by-event from the host's per-call cost estimate (see
    estimateUsageCostUsd in model-fetcher.ts) — never recomputed from aggregate token totals,
    since that would misattribute cost if the model changed mid-session. */
export interface CostTotals {
  usd: number;
  /** True once any usage event had an unpriced token category (or no pricing at all) — usd is
      then a lower bound on real spend, not an exact figure. Sticky for the session once set. */
  partial: boolean;
}

export function emptyCost(): CostTotals {
  return { usd: 0, partial: false };
}
