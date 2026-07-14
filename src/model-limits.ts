/**
 * Context-window and output-token limits for Claude models — one table, two consumers.
 *
 * These were previously two independent stale tables, and both were wrong in the expensive
 * direction:
 *
 *  - The context window fell back to 200K for every Claude id, so Opus 4.8 (a **1M** window) was
 *    compacted at 60% of 200K — roughly 12% of its real capacity. Long runs were shedding history
 *    they had ample room for, which is precisely the failure the long-horizon work exists to avoid.
 *  - The output ceiling was known only for Bedrock Claude (64K), so an "Unlimited" max-tokens run
 *    on the Anthropic path could request 200K and take a hard 400.
 *
 * Keeping both in one place means a model added here fixes compaction *and* the output clamp at
 * once, and they cannot disagree about what a model is.
 *
 * Pure module (no vscode/node imports) — the webview reads it too.
 */

import { parseClaudeVersion } from "./thinking-modes.js";

export interface ClaudeLimits {
  /** Total context window (input + output). */
  contextWindow: number;
  /** Hard cap on `max_tokens`. Requests above it are rejected outright. */
  maxOutputTokens: number;
}

/** Claude 4.6 and later: 1M context, 128K output. */
const MODERN_LIMITS: ClaudeLimits = { contextWindow: 1_000_000, maxOutputTokens: 128_000 };
/** Haiku is the one current model that didn't get the big window or the big output cap. */
const HAIKU_LIMITS: ClaudeLimits = { contextWindow: 200_000, maxOutputTokens: 64_000 };
/** Claude 3.7 – 4.5. 200K context; output caps vary by model and several are undocumented here,
 *  so 64K is used as the conservative known-good ceiling for the family. */
const LEGACY_LIMITS: ClaudeLimits = { contextWindow: 200_000, maxOutputTokens: 64_000 };

/**
 * Bedrock rejects a Claude `max_tokens` above 64000 regardless of what the model supports on the
 * first-party API ("maximum tokens you requested exceeds the model limit of 64000"). This is an
 * observed platform cap, not a model property, so it is applied on top of the model's own limit
 * rather than baked into the table.
 */
const BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Limits for a Claude model, or null when the id isn't a Claude model we recognise.
 *
 * Threshold-shaped for the same reason as the thinking table: a model released after this code was
 * written resolves to the current family's limits rather than silently inheriting a 200K window
 * that would compact it five times too early.
 */
export function resolveClaudeLimits(modelId: string | null | undefined): ClaudeLimits | null {
  const v = parseClaudeVersion(modelId);
  if (!v) return null;

  if (v.family === "fable" || v.family === "mythos") return MODERN_LIMITS;
  // Haiku 4.x stayed at 200K/64K. A future Haiku 5 is assumed to join the modern family.
  if (v.family === "haiku" && v.major < 5) return HAIKU_LIMITS;
  if (v.major >= 5) return MODERN_LIMITS;
  // Opus and Sonnet crossed to 1M/128K at 4.6.
  if (v.major > 4 || (v.major === 4 && v.minor >= 6)) return MODERN_LIMITS;
  return LEGACY_LIMITS;
}

/** Context window for a model, or undefined when unknown (caller keeps its own default). */
export function resolveContextWindow(modelId: string | null | undefined): number | undefined {
  return resolveClaudeLimits(modelId)?.contextWindow;
}

/**
 * The hard `max_tokens` ceiling for a model on a given provider, or null when unknown (the request
 * passes through unclamped, and any error comes from the provider with a clear message rather than
 * from us silently truncating).
 */
export function resolveOutputCeiling(
  model: string | null | undefined,
  provider: string | null | undefined,
): number | null {
  const limits = resolveClaudeLimits(model);
  if (!limits) return null;
  return provider === "bedrock"
    ? Math.min(limits.maxOutputTokens, BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS)
    : limits.maxOutputTokens;
}
