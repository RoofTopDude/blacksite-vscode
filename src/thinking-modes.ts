/**
 * Which thinking API a given Claude model speaks.
 *
 * Anthropic replaced the fixed thinking-token budget with **adaptive thinking**: the model
 * decides when and how deeply to think, and depth is steered by `output_config.effort` rather
 * than a token count. The two shapes are mutually exclusive and the newer models reject the old
 * one outright:
 *
 *   - `thinking: {type: "enabled", budget_tokens: N}` → **400** on Opus 4.7+, Sonnet 5+, Fable 5.
 *   - `thinking: {type: "adaptive"}` → the only on-mode from Opus 4.6 / Sonnet 4.6 onward.
 *   - `temperature` / `top_p` / `top_k` → **400** on Opus 4.7+, Sonnet 5+, Fable 5 (removed
 *     entirely, not just when thinking is on).
 *
 * So the request shape is a function of the model, not a global setting — which is exactly the
 * kind of per-model table that goes stale. The version rules below are therefore written as
 * *thresholds*, not an enumeration: a model newer than anything listed here is assumed to speak
 * the newest dialect. Failing open that way means a model released tomorrow works on the day it
 * ships, and the worst case is a request the provider rejects with a clear error — whereas
 * failing closed would silently send `budget_tokens` to a model that 400s on it.
 *
 * Pure module (no vscode/node imports) so the webview imports it directly and the settings UI
 * and the request builder can never disagree about what a model supports.
 */

/** Thinking depth rungs, shallowest → deepest. Anthropic's ladder — unrelated to OpenAI's
 *  `reasoning_effort` (which also has "none"/"minimal" rungs Claude does not accept). */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const CLAUDE_EFFORT_LADDER: readonly ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Anthropic's own default when `effort` is omitted. */
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = "high";

export type ThinkingMode =
  /** `thinking: {type: "adaptive"}` + `output_config.effort`. Opus 4.6+, Sonnet 4.6+, Fable/Mythos. */
  | "adaptive"
  /** `thinking: {type: "enabled", budget_tokens: N}`. Claude 3.7 through 4.5. */
  | "budget"
  /** Not a Claude model, or a Claude model with no thinking support. */
  | "none";

interface ClaudeVersion {
  family: "opus" | "sonnet" | "haiku" | "fable" | "mythos";
  major: number;
  minor: number;
}

/**
 * Reduce any provider's spelling of a Claude model id to a bare `claude-...` slug.
 *
 * The same model arrives with wildly different decoration depending on the route:
 *   Anthropic    `claude-opus-4-8`
 *   Bedrock      `anthropic.claude-opus-4-8`, `us.anthropic.claude-sonnet-4-6-v1:0`
 *   Bedrock ARN  `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-v1:0`
 *   OpenRouter   `anthropic/claude-opus-4.8`  ← dots, not dashes
 */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  // ARNs and OpenRouter both end in the real id after the last slash.
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  // Regional inference-profile prefix (us./eu./apac./us-gov.), then the provider prefix.
  id = id.replace(/^(?:us|eu|apac|us-gov)\./, "").replace(/^anthropic\./, "");
  // Bedrock version suffix, then a dated snapshot suffix.
  id = id.replace(/-v\d+:\d+$/, "").replace(/[-:]\d{8}$/, "");
  // OpenRouter writes the version with dots (claude-opus-4.8); everyone else uses dashes.
  return id.replace(/\./g, "-");
}

/** Parse the family and version out of a normalized id, or null if it isn't a Claude model. */
export function parseClaudeVersion(modelId: string | null | undefined): ClaudeVersion | null {
  if (!modelId) return null;
  const id = normalizeModelId(modelId);

  const named = /^claude-(fable|mythos)-(\d+)(?:-(\d+))?/.exec(id);
  if (named) {
    return { family: named[1] as "fable" | "mythos", major: Number(named[2]), minor: Number(named[3] ?? 0) };
  }

  // Modern: claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5
  const modern = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id);
  if (modern) {
    return { family: modern[1] as ClaudeVersion["family"], major: Number(modern[2]), minor: Number(modern[3] ?? 0) };
  }

  // Legacy, version-before-family: claude-3-7-sonnet, claude-3-5-haiku
  const legacy = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)/.exec(id);
  if (legacy) {
    return { family: legacy[3] as ClaudeVersion["family"], major: Number(legacy[1]), minor: Number(legacy[2]) };
  }

  return null;
}

/** `true` when (major, minor) >= the threshold. */
function atLeast(v: ClaudeVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/**
 * The generation that dropped `budget_tokens`, sampling parameters, and (unless asked) visible
 * thinking text. Fable/Mythos and anything at major 5+ are in it by definition; within the 4.x
 * line, Opus crossed at 4.7 and Sonnet went straight from 4.6 to 5.
 *
 * Threshold-shaped on purpose: an unreleased Opus 4.9 or Haiku 5 lands on the right side of this
 * without a code change.
 */
function isModernGeneration(v: ClaudeVersion): boolean {
  if (v.family === "fable" || v.family === "mythos") return true;
  if (v.major >= 5) return true;
  if (v.family === "opus") return atLeast(v, 4, 7);
  return false;
}

/** Which thinking request shape this model accepts. */
export function resolveThinkingMode(modelId: string | null | undefined): ThinkingMode {
  const v = parseClaudeVersion(modelId);
  if (!v) return "none";
  if (isModernGeneration(v)) return "adaptive";
  // Adaptive arrived (alongside a still-working budget_tokens) with the 4.6 pair. Prefer it —
  // it is the long-term shape and outperforms a fixed budget on Anthropic's own evals.
  if ((v.family === "opus" || v.family === "sonnet") && atLeast(v, 4, 6)) return "adaptive";
  // Claude 3.7 was the first model with extended thinking at all.
  if (atLeast(v, 3, 7)) return "budget";
  return "none";
}

/** Whether the model supports extended thinking in any form (drives the UI toggle). */
export function supportsThinking(modelId: string | null | undefined): boolean {
  return resolveThinkingMode(modelId) !== "none";
}

/**
 * `temperature`, `top_p`, and `top_k` are **removed** on the modern generation — sending any of
 * them is a 400 even with thinking switched off. Steer those models with prompting instead.
 */
export function acceptsSamplingParams(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  if (!v) return true; // not a Claude model — leave the provider's own rules alone
  return !isModernGeneration(v);
}

/**
 * Thinking depth rungs the model accepts, shallowest → deepest. Empty when `output_config.effort`
 * is not supported at all (it errors on Sonnet 4.5 / Haiku 4.5 and everything older).
 */
export function supportedEfforts(modelId: string | null | undefined): readonly ClaudeEffort[] {
  const v = parseClaudeVersion(modelId);
  if (!v) return [];
  if (isModernGeneration(v)) return CLAUDE_EFFORT_LADDER;                    // incl. xhigh (added at Opus 4.7)
  if ((v.family === "opus" || v.family === "sonnet") && atLeast(v, 4, 6)) {
    return ["low", "medium", "high", "max"];                                 // 4.6 pair: no xhigh
  }
  if (v.family === "opus" && atLeast(v, 4, 5)) return ["low", "medium", "high"];
  return [];                                                                 // Sonnet/Haiku 4.5 and older: effort 400s
}

/**
 * Clamp a requested effort to the nearest rung the model actually accepts, so a setting persisted
 * against one model can never turn into a per-turn 400 after switching to another. Returns
 * undefined when the model takes no effort parameter at all.
 */
export function resolveEffort(
  modelId: string | null | undefined,
  requested: ClaudeEffort | undefined,
): ClaudeEffort | undefined {
  const supported = supportedEfforts(modelId);
  if (supported.length === 0) return undefined;
  const target = requested ?? DEFAULT_CLAUDE_EFFORT;
  if (supported.includes(target)) return target;
  // Walk down the ladder from the requested rung to the deepest one this model does support.
  const wanted = CLAUDE_EFFORT_LADDER.indexOf(target);
  for (let i = wanted; i >= 0; i--) {
    const rung = CLAUDE_EFFORT_LADDER[i]!;
    if (supported.includes(rung)) return rung;
  }
  return supported[0];
}

/**
 * Whether thinking can be switched off at all.
 *
 * Fable/Mythos think unconditionally: `{type: "disabled"}` is a 400 there, and omitting the
 * parameter still thinks. Every other model can be turned off — but note that *omitting* the
 * parameter is not a reliable "off" switch either: on Sonnet 5 an absent `thinking` field runs
 * adaptive, while on Opus 4.8/4.7 it runs without thinking. So "off" must be sent explicitly as
 * `{type: "disabled"}` rather than expressed by leaving the field out.
 */
export function canDisableThinking(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  return !(v?.family === "fable" || v?.family === "mythos");
}

/**
 * Whether the model needs `thinking.display: "summarized"` to return readable reasoning.
 *
 * The modern generation defaults `display` to `"omitted"`: thinking blocks still stream, but with
 * an empty text field. A UI that renders them shows a long silent pause and then an answer. The
 * 4.6 pair still defaults to `"summarized"`, so this is only needed above that line. (The raw
 * chain of thought is never returned on any model — `"summarized"` is a readable summary of it,
 * and display affects visibility only: thinking happens, and is billed, either way.)
 */
export function needsSummarizedDisplay(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  return v !== null && isModernGeneration(v);
}

/**
 * Opus 4.8+ — the fast-capable generation (`"speed": "fast"`, beta fast-mode-2026-02-01).
 * First-party Anthropic API only; not available on Bedrock, Vertex, Foundry, or the Batches
 * API. Callers restrict the toggle to `provider === "anthropic"` on top of this check.
 *
 * The floor is 4.8, not 4.7: Opus 4.7 had fast mode at launch and Anthropic has since **removed
 * it** — `speed: "fast"` on 4.7 now returns an error rather than degrading to standard speed. So
 * this is one of the few rules here that had to move *up* rather than extend downward; a 4.7
 * session with the fast toggle on was failing every turn outright.
 */
export function supportsFastMode(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  if (!v || v.family !== "opus") return false;
  return atLeast(v, 4, 8);
}

/**
 * The deepest effort rung that still accepts `thinking: {type: "disabled"}`, or null when the
 * model imposes no such cap.
 *
 * Opus 5 accepts disabled thinking only at `high` or below — pairing it with `xhigh`/`max` is a
 * 400, and the check is per request, so a session that raises effort mid-run starts failing even
 * though earlier turns succeeded. Nothing in the request is invalid on its own; it is the
 * *combination* that is rejected, which is why this can't live in {@link supportedEfforts}.
 *
 * Threshold-shaped like the rest of this module: a future Opus inherits the cap rather than
 * silently 400ing on it. Deliberately not applied to Sonnet 5 — Anthropic documents the cap for
 * Opus only, and over-applying it would quietly shallow out a rung the model does accept.
 */
export function maxEffortWithThinkingDisabled(modelId: string | null | undefined): ClaudeEffort | null {
  const v = parseClaudeVersion(modelId);
  if (!v || v.family !== "opus") return null;
  return v.major >= 5 ? "high" : null;
}

/**
 * True for models whose safety classifiers may decline a request outright (`stop_reason:
 * "refusal"` on an HTTP 200), and for which Anthropic recommends a default-on server-side
 * refusal fallback.
 *
 * Covers Fable 5 / Mythos 5 *and* Opus 5, which ships the same elevated cybersecurity
 * safeguards. Benign adjacent work — security tooling, life-sciences tasks — trips them as a
 * false positive often enough that Anthropic's guidance is to opt in by default; without a
 * fallback the turn simply stops with empty content.
 */
export function recommendsRefusalFallback(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  if (!v) return false;
  if (v.family === "fable" || v.family === "mythos") return true;
  return v.family === "opus" && v.major >= 5;
}

/**
 * Fable 5 / Mythos 5 / Sonnet 5 / Opus 4.8 / Opus 4.7 — the models documented to accept
 * `output_config.task_budget` (beta task-budgets-2026-03-13). Not available on Amazon
 * Bedrock/Vertex/Foundry — callers restrict it to the first-party Anthropic path.
 */
export function supportsTaskBudget(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  if (!v) return false;
  if (v.family === "fable" || v.family === "mythos") return true;
  if (v.family === "sonnet") return v.major >= 5;
  if (v.family === "opus") return atLeast(v, 4, 7);
  return false;
}

/**
 * True for Claude Fable 5 / Claude Mythos 5 — the models whose safety classifiers may decline
 * a request (`stop_reason: "refusal"`), and for which Anthropic recommends a default-on
 * server-side refusal fallback.
 */
export function isFableFamily(modelId: string | null | undefined): boolean {
  const v = parseClaudeVersion(modelId);
  return !!v && (v.family === "fable" || v.family === "mythos");
}
