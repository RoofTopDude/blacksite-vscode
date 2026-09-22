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
 * The hard response ceiling for a model/provider. Live catalog metadata wins when supplied;
 * otherwise documented family limits cover providers whose model-list endpoint omits them. Null
 * means genuinely unknown, so the caller applies its explicit conservative fallback.
 */
export function resolveOutputCeiling(
  model: string | null | undefined,
  provider: string | null | undefined,
  reportedMaxOutputTokens?: number | null,
): number | null {
  const limits = resolveClaudeLimits(model);
  const reported = Number.isFinite(reportedMaxOutputTokens) && Number(reportedMaxOutputTokens) > 0
    ? Math.floor(Number(reportedMaxOutputTokens))
    : null;

  // A live catalog value is more authoritative than a release-family heuristic. Bedrock's
  // Claude cap is a platform constraint, however, so it still applies on top of live metadata.
  if (reported != null) {
    return provider === "bedrock" && limits
      ? Math.min(reported, BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS)
      : reported;
  }
  if (limits) {
    return provider === "bedrock"
      ? Math.min(limits.maxOutputTokens, BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS)
      : limits.maxOutputTokens;
  }

  // OpenAI's /v1/models response only identifies models; it does not include token limits.
  // Keep its documented family limits here so direct OpenAI sessions still resolve a cap, and
  // so OpenRouter has a useful offline fallback when top_provider.max_completion_tokens is absent.
  const id = (model ?? "")
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/[-:]\d{8}$/, "");
  if (!id) return null;

  if (/^gpt-(?:[5-9]|\d{2,})(?:[.-]|$)/.test(id)) return 128_000;
  if (/^gpt-4\.1(?:-|$)/.test(id)) return 32_768;
  if (/^(?:chatgpt-)?gpt-4o(?:-|$)/.test(id) || id === "chatgpt-4o-latest") return 16_384;
  if (/^gpt-4-turbo(?:-|$)/.test(id)) return 4_096;
  if (/^gpt-4(?:-|$)/.test(id)) return 8_192;
  if (/^gpt-3\.5-turbo(?:-|$)/.test(id)) return 4_096;
  if (/^o1-preview(?:-|$)/.test(id)) return 32_768;
  if (/^o1-mini(?:-|$)/.test(id)) return 65_536;
  if (/^o[134](?:-|$)/.test(id)) return 100_000;

  // OpenRouter normally supplies the live cap. This covers its bundled offline Gemini model
  // and remains conservative for the 2.5 family if the catalog cannot be reached.
  if (/^(?:google\/)?gemini-2\.5(?:-|$)/.test((model ?? "").toLowerCase())) return 65_536;
  return null;
}

/**
 * OpenAI reasoning families that use max_completion_tokens and reject custom temperature.
 * gpt-5 and everything after it (gpt-5.x, gpt-6…) is reasoning-native, so match any
 * gpt-N with N >= 5 rather than pinning to the ids known today.
 *
 * Shared by both the main turn path (agent-session.ts) and the background-compaction
 * summarizer (compressor.ts) — a model that needs this on one path needs it on the other,
 * and this single source of truth is what keeps them from silently diverging again.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  if (/^o[134](-|$)/.test(id) || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return true;
  const m = /^gpt-(\d+)/.exec(id);
  return m !== null && Number(m[1]) >= 5;
}
/**
 * The full OpenAI reasoning-depth ladder, ordered shallowest → deepest. Which rungs a
 * given model accepts varies by family (see {@link supportedReasoningEfforts}); requests
 * clamp to the nearest supported rung via {@link resolveReasoningEffort} so switching
 * models can never turn a persisted setting into a 400-per-turn failure.
 */
export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Ladder order for nearest-rung clamping — shallowest to deepest. "max" (GPT-5.6+) sits
 *  above "xhigh"; it is a reasoning DEPTH rung, unrelated to "ultra mode" (a separate
 *  multi-agent orchestration feature with no reasoning_effort value of its own). */
const REASONING_EFFORT_LADDER: readonly OpenAIReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Reasoning-effort rungs each OpenAI model family accepts. Known families are pinned to
 * what their API actually takes. "minimal" is NOT a monotonically-growing feature: 5.0 had
 * it, 5.1 replaced it with "none", and it stayed gone through 5.6 — so the fail-open
 * default for versions newer than the table does NOT include "minimal" (offering a rung a
 * model actually rejects would 400 the request; under-offering only hides a rung the user
 * could otherwise pick, which {@link resolveReasoningEffort} degrades gracefully from
 * anyway). "max" (confirmed on the whole 5.6 family — gpt-5.6/-terra/-luna/-sol) IS
 * included in the fail-open default, since the deepest levels are exactly what a newer
 * model is likely to keep adding.
 */
export function supportedReasoningEfforts(model: string): OpenAIReasoningEffort[] {
  const id = model.toLowerCase();
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (!gpt) return ["low", "medium", "high"]; // o-series and unknown reasoning models
  const major = Number(gpt[1]);
  const minor = gpt[2] ? Number(gpt[2]) : 0;
  if (major === 5 && minor === 0) return ["minimal", "low", "medium", "high"];
  if (major === 5 && minor === 1) {
    // 5.1 swapped "minimal" for "none"; the codex-max line added "xhigh".
    return id.includes("codex") && id.includes("max")
      ? ["none", "low", "medium", "high", "xhigh"]
      : ["none", "low", "medium", "high"];
  }
  // gpt-5.2+ (confirmed on 5.6) and future majors: none/low/medium/high/xhigh/max — no
  // "minimal" (dropped at 5.1 and never reintroduced).
  return ["none", "low", "medium", "high", "xhigh", "max"];
}

/**
 * Clamp a requested reasoning effort to what the target model supports, preferring the
 * nearest shallower rung, then the nearest deeper one ("xhigh" on a plain 5.1 → "high";
 * "minimal" on 5.1 → "none"; "none" on an o-series model → "low"). Returns undefined for
 * no effort at all — the caller then omits the parameter and the model uses its default.
 * This is what lets a persisted setting survive a model switch instead of 400ing.
 */
export function resolveReasoningEffort(
  model: string,
  effort: OpenAIReasoningEffort | undefined,
): OpenAIReasoningEffort | undefined {
  if (!effort) return undefined;
  const supported = supportedReasoningEfforts(model);
  if (supported.includes(effort)) return effort;
  const idx = REASONING_EFFORT_LADDER.indexOf(effort);
  if (idx < 0) return undefined;
  for (let step = 1; step < REASONING_EFFORT_LADDER.length; step++) {
    const shallower = REASONING_EFFORT_LADDER[idx - step];
    if (shallower && supported.includes(shallower)) return shallower;
    const deeper = REASONING_EFFORT_LADDER[idx + step];
    if (deeper && supported.includes(deeper)) return deeper;
  }
  return undefined;
}

/**
 * The shallowest rung the model accepts — its cheapest, fastest reasoning setting, and as
 * close to "off" as the OpenAI wire gets. "none" on gpt-5.1+, "minimal" on gpt-5.0, "low"
 * on the o-series, which has no shallower rung to offer. Used by background compaction,
 * which wants a transcript summarised rather than thought about.
 */
export function shallowestReasoningEffort(model: string): OpenAIReasoningEffort {
  return supportedReasoningEfforts(model)[0] ?? "low";
}

/**
 * Collapse the full OpenAI effort ladder onto OpenRouter's unified-reasoning vocabulary
 * (low/medium/high). Returns undefined for "none" — the caller then sends no `reasoning`
 * field at all, because the unified param *enables* reasoning on the routed model, and an
 * explicit off-rung doesn't exist in OpenRouter's vocabulary.
 */
export function toOpenRouterReasoningEffort(effort: OpenAIReasoningEffort): "low" | "medium" | "high" | undefined {
  if (effort === "none") return undefined;
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}
