/*
  The thinking + max_tokens + temperature plan for one request, and the opt-in Anthropic beta
  features. Pure functions of the model and the caller's settings; every provider route reads
  them so the four request shapes cannot drift.
*/
import type { BedrockThinkingConfig } from "./bedrock-types.js";
import type { ProviderName } from "./types.js";
import {
  acceptsSamplingParams,
  thinkingOffShape,
  CLAUDE_EFFORT_LADDER,
  maxEffortWithThinkingDisabled,
  needsSummarizedDisplay,
  parseClaudeVersion,
  recommendsRefusalFallback,
  resolveEffort,
  resolveThinkingMode,
  supportsFastMode,
  supportsTaskBudget,
  type ClaudeEffort,
} from "./thinking-modes.js";

export interface ThinkingConfig {
  enabled: boolean;
  /** Fixed thinking-token budget. Used only by budget-era models (Claude 3.7 – 4.5); the modern
   *  generation rejects it with a 400 and takes {@link ThinkingConfig.effort} instead. */
  budgetTokens: number;
  /** Thinking depth for adaptive-era models (Claude 4.6+). Clamped per model at request time by
   *  {@link resolveEffort}, so a value persisted against one model can't 400 on another. */
  effort?: ClaudeEffort;
}

/** Anthropic-family APIs (direct, Bedrock Converse, Mantle) accept temperature in
    [0, 1] only, while the settings slider spans the OpenAI-style [0, 2] range. A
    user who dialed 1.3 on OpenAI and then switched provider would otherwise get a
    400 on every call — clamp instead of failing the turn. */
export function clampAnthropicTemperature(t: number | undefined): number | undefined {
  return t === undefined ? undefined : Math.max(0, Math.min(1, t));
}

/** The thinking block to send, already reconciled with what the model actually accepts. */
export type ResolvedThinking =
  /** Send no `thinking` field. Only a valid "off" for budget-era models (and the only legal
   *  shape for Fable/Mythos, which think unconditionally). */
  | { kind: "omit" }
  /** `thinking: {type: "disabled"}` — the explicit off switch. Required on Sonnet 5, where an
   *  absent field runs adaptive anyway. */
  | { kind: "disabled" }
  /** `thinking: {type: "between_tools"}` and nothing else — Sonnet 5.5's off switch, which rejects
   *  `disabled`. Thinks only between tool calls, at effort `high` or below. */
  | { kind: "between_tools" }
  /** `thinking: {type: "adaptive", display?}`. Depth comes from {@link ThinkingPlan.effort}. */
  | { kind: "adaptive"; summarize: boolean }
  /** `thinking: {type: "enabled", budget_tokens: N}` — Claude 3.7 through 4.5. */
  | { kind: "budget"; budgetTokens: number };

export interface ThinkingPlan {
  maxTokens: number;
  thinking: ResolvedThinking;
  /**
   * `output_config.effort`, or undefined when the model takes no effort parameter.
   *
   * Deliberately independent of whether thinking is on. Effort governs total token spend and how
   * eagerly the model reaches for tools, not just thinking depth — and Anthropic documents
   * `thinking: {type: "disabled"}` alongside `output_config: {effort: "low"}` as the recommended
   * cheap, fast configuration. Nesting effort inside the adaptive branch made that unreachable.
   */
  effort: ClaudeEffort | undefined;
  /** The temperature to send, or undefined when it must be omitted — either because thinking is
   *  on (Anthropic requires temperature 1 / absent) or because the model rejects sampling
   *  parameters outright. */
  temperature: number | undefined;
}

export interface ThinkingPlanInput {
  model: string;
  provider: ProviderName;
  configuredMaxTokens: number;
  ceiling: number | null;
  thinkingEnabled: boolean;
  budgetTokens: number;
  effort: ClaudeEffort | undefined;
  temperature: number | undefined;
}

/**
 * Decide the thinking + max_tokens + temperature triple for one request.
 *
 * All three are entangled and all three are per-model, which is why they are resolved together in
 * one pure function rather than inline in each of the four provider paths (where they drifted):
 *
 *  - **Dialect.** Adaptive-era models 400 on `budget_tokens`; budget-era models 400 on `adaptive`.
 *    {@link resolveThinkingMode} picks, and the budget/effort field that doesn't apply is dropped.
 *  - **Ceiling.** The budget dialect requires `budget_tokens < max_tokens`, so a large budget has
 *    to *raise* max_tokens — which previously walked the request back over the provider ceiling
 *    the clamp had just applied (the thinking slider's 64000 maximum is exactly Bedrock Claude's
 *    hard limit, so a maxed budget produced `max_tokens: 65024` and a fatal 400 every request).
 *    Bump first, clamp second, and when the clamp bites pull the *budget* down to stay under
 *    max_tokens — clamping alone would violate the constraint the bump exists to satisfy. The
 *    adaptive dialect has no such constraint: there is no budget, so max_tokens is only clamped.
 *  - **Sampling.** `temperature` is a 400 on the modern generation whether or not thinking is on.
 */
export function planThinking(input: ThinkingPlanInput): ThinkingPlan {
  const { model, ceiling } = input;
  const clamp = (n: number): number => (ceiling != null ? Math.min(n, ceiling) : n);

  const maxTokens = clamp(input.configuredMaxTokens);
  const mode = resolveThinkingMode(model);
  // Anthropic rejects an explicit temperature whenever thinking is on, and the modern generation
  // rejects it unconditionally. The 0–1 clamp is Claude's range and must not be applied to a
  // non-Claude model — the settings slider spans OpenAI's 0–2, and squashing a GPT model to 1
  // would silently change its sampling.
  const wantsThinking = input.thinkingEnabled && mode !== "none";
  const isClaude = parseClaudeVersion(model) !== null;
  const temperature = wantsThinking || !acceptsSamplingParams(model)
    ? undefined
    : isClaude ? clampAnthropicTemperature(input.temperature) : input.temperature;
  // Sent whether or not thinking is on — see ThinkingPlan.effort.
  const effort = resolveEffort(model, input.effort);

  if (!wantsThinking) {
    // "Off" is not the same as "unset": on Sonnet 5 an absent `thinking` field still runs
    // adaptive, so off has to be stated. Fable/Mythos and Opus 5.5 cannot be turned off and
    // reject `{type: "disabled"}`, so there the only legal shape is to omit the field; Sonnet 5.5
    // spells off as `between_tools`.
    const shape = thinkingOffShape(model);
    const thinking: ResolvedThinking = { kind: shape };
    // Opus 5, Haiku 5.5 and Sonnet 5.5 reject their off switch above `high` effort — neither field
    // is invalid alone, so the conflict can only be resolved once both are known. Clamping the
    // rung honours the user's explicit "thinking off" (the setting they actually reached for)
    // instead of quietly switching thinking back on, and beats 400ing every turn on a
    // legal-looking request.
    const cap = shape !== "omit" ? maxEffortWithThinkingDisabled(model) : null;
    const cappedEffort = cap && effort && CLAUDE_EFFORT_LADDER.indexOf(effort) > CLAUDE_EFFORT_LADDER.indexOf(cap)
      ? cap
      : effort;
    return { maxTokens, thinking, effort: cappedEffort, temperature };
  }

  if (mode === "adaptive") {
    return {
      maxTokens,
      thinking: { kind: "adaptive", summarize: needsSummarizedDisplay(model) },
      effort,
      temperature,
    };
  }

  let budgetTokens = Math.max(MIN_THINKING_BUDGET_TOKENS, input.budgetTokens);
  let budgetMaxTokens = maxTokens;
  if (budgetMaxTokens <= budgetTokens) budgetMaxTokens = budgetTokens + MIN_THINKING_BUDGET_TOKENS;
  if (ceiling != null && budgetMaxTokens > ceiling) {
    budgetMaxTokens = ceiling;
    budgetTokens = Math.min(budgetTokens, budgetMaxTokens - MIN_THINKING_BUDGET_TOKENS);
  }
  return { maxTokens: budgetMaxTokens, thinking: { kind: "budget", budgetTokens }, effort, temperature };
}

/** Anthropic's documented floor for `thinking.budget_tokens`, reused as the headroom `max_tokens`
 *  must keep above the budget. */
const MIN_THINKING_BUDGET_TOKENS = 1024;

/**
 * Write a resolved thinking plan into an Anthropic **Messages API** request body — the shape used
 * by the direct Anthropic endpoint and by Bedrock Mantle, which speaks the same wire format.
 *
 * `output_config.effort` is the adaptive dialect's depth control (the replacement for
 * `budget_tokens`); it is GA and needs no beta header. `display: "summarized"` is what makes the
 * reasoning text non-empty on the modern generation, whose default is `"omitted"` — without it the
 * UI receives thinking blocks with nothing in them and shows a long silent pause.
 */
/**
 * Map a resolved thinking plan onto Bedrock **Converse**'s `additionalModelRequestFields.thinking`.
 *
 * Only the thinking object maps here — the effort rung travels separately as
 * `ConverseOptions.effort` and lands under `additionalModelRequestFields.output_config`, the same
 * verbatim pass-through (see buildRequestBody in bedrock-client). It was previously dropped on
 * this path entirely, so the same effort setting behaved differently across Converse and Mantle.
 */
export function toBedrockThinking(thinking: ResolvedThinking): BedrockThinkingConfig | undefined {
  switch (thinking.kind) {
    case "omit":     return undefined;
    case "disabled": return { type: "disabled" };
    case "between_tools": return { type: "between_tools" };
    case "budget":   return { type: "enabled", budget_tokens: thinking.budgetTokens };
    case "adaptive": return thinking.summarize
      ? { type: "adaptive", display: "summarized" }
      : { type: "adaptive" };
  }
}

export function applyAnthropicThinking(body: Record<string, unknown>, plan: ThinkingPlan): void {
  switch (plan.thinking.kind) {
    case "omit":
      break;
    case "disabled":
      body["thinking"] = { type: "disabled" };
      break;
    case "between_tools":
      body["thinking"] = { type: "between_tools" };
      break;
    case "budget":
      body["thinking"] = { type: "enabled", budget_tokens: plan.thinking.budgetTokens };
      break;
    case "adaptive":
      body["thinking"] = plan.thinking.summarize
        ? { type: "adaptive", display: "summarized" }
        : { type: "adaptive" };
      break;
  }
  // Applied in every mode, thinking on or off — Anthropic documents disabled-thinking + low-effort
  // as the recommended cheap/fast configuration, and effort also governs tool-calling eagerness.
  if (plan.effort) {
    const existing = body["output_config"] as Record<string, unknown> | undefined;
    body["output_config"] = { ...existing, effort: plan.effort };
  }
}

/** The opt-in Anthropic features a caller may turn on. */
export interface AnthropicBetaOptions {
  fastMode?: boolean;
  taskBudgetTokens?: number;
  contextEditingEnabled?: boolean;
  compactionTriggerTokens?: number;
  refusalFallbackEnabled?: boolean;
  /** Tools whose results context editing must never clear, because they cannot be re-derived. */
  contextEditingExcludeTools?: readonly string[];
}

/** Resolved beta headers + body fields for one Anthropic/Mantle request. */
export interface AnthropicBetaExtras {
  betas: string[];
  bodyExtras: Record<string, unknown>;
  /** Merged into `output_config.task_budget` by the caller, after `applyAnthropicThinking`
   *  has had a chance to set `output_config.effort` — the two must not clobber each other. */
  taskBudgetTokens?: number;
}

const EMPTY_BETA_EXTRAS: AnthropicBetaExtras = { betas: [], bodyExtras: {} };

/** Minimum accepted by `context_management.edits[].trigger.value` for the compaction edit. */
const MIN_COMPACTION_TRIGGER_TOKENS = 50_000;

/**
 * Resolve the beta headers + body fields for the opt-in Anthropic features a session may have
 * enabled: fast mode, task budgets, context editing, server-side compaction, and Fable's
 * refusal fallback. Scoped per surface — fast mode and task budgets are first-party-API-only
 * (unavailable on Bedrock), and the server-side `fallbacks` param is likewise unavailable on
 * Bedrock (which would need the client-side middleware equivalent this session doesn't
 * implement). Context editing and compaction are supported on both surfaces, since they're
 * plain request-body fields — compaction's response block round-trips through the normal
 * message-history pipeline like any other content block, not through a side channel here.
 *
 * Context editing and compaction share the single `context_management.edits` array — both
 * must contribute to the same object rather than one overwriting the other when both are on.
 */
export function resolveAnthropicBetaExtras(
  model: string,
  opts: AnthropicBetaOptions,
  isMantle: boolean,
): AnthropicBetaExtras {
  if (!opts.fastMode && !opts.taskBudgetTokens && !opts.contextEditingEnabled && !opts.compactionTriggerTokens
    && opts.refusalFallbackEnabled === false) {
    return EMPTY_BETA_EXTRAS;
  }
  const betas: string[] = [];
  const bodyExtras: Record<string, unknown> = {};
  let taskBudgetTokens: number | undefined;
  const contextManagementEdits: Array<Record<string, unknown>> = [];

  if (!isMantle && opts.fastMode && supportsFastMode(model)) {
    bodyExtras["speed"] = "fast";
    betas.push("fast-mode-2026-02-01");
  }

  if (!isMantle && opts.taskBudgetTokens && supportsTaskBudget(model)) {
    taskBudgetTokens = Math.max(20_000, opts.taskBudgetTokens);
    betas.push("task-budgets-2026-03-13");
  }

  if (opts.contextEditingEnabled) {
    // `exclude_tools` keeps the server from clearing results that cannot be re-derived (a user's
    // answers, for one). Without it, `clear_tool_uses_20250919` treats them like any other stale
    // tool output and drops them once the trigger threshold is crossed.
    contextManagementEdits.push({ type: "clear_tool_uses_20250919", exclude_tools: [...(opts.contextEditingExcludeTools ?? [])] });
    betas.push("context-management-2025-06-27");
  }

  if (opts.compactionTriggerTokens) {
    contextManagementEdits.push({
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: Math.max(MIN_COMPACTION_TRIGGER_TOKENS, opts.compactionTriggerTokens) },
      pause_after_compaction: false,
      instructions: null,
    });
    betas.push("compact-2026-01-12");
  }

  if (contextManagementEdits.length > 0) {
    bodyExtras["context_management"] = { edits: contextManagementEdits };
  }

  // Default-on per Anthropic's guidance ("default to opting in") for every model whose safety
  // classifiers can decline a request — Fable/Mythos and, since it shipped with the same
  // elevated cybersecurity safeguards, Opus 5. Explicit `false` disables it. Not sent on Mantle
  // — see the doc comment above.
  //
  // `"default"` rather than a pinned `[{model: "claude-opus-4-8"}]`: the scalar form routes by
  // refusal *category*, so a cyber decline and a bio decline can land on different substitutes,
  // and it carries no model name to migrate when the pinned one is eventually deprecated. It
  // takes its own beta header — the -06-01 header gates the array form only, and pairing either
  // header with the other form is a 400.
  if (!isMantle && opts.refusalFallbackEnabled !== false && recommendsRefusalFallback(model)) {
    bodyExtras["fallbacks"] = "default";
    betas.push("server-side-fallback-2026-07-01");
  }

  return { betas, bodyExtras, taskBudgetTokens };
}
