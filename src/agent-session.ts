import type * as vscode from "vscode";
import type { LocalRuntime } from "@blacksite/local-runtime";
import {
  WORKSPACE_TOOLS, MEMORY_TOOLS, DIAGNOSTICS_TOOLS, CODE_INTEL_TOOLS, GIT_TOOLS, TEST_TOOLS, WORKTREE_TOOLS, SUBAGENT_TOOLS, SERVICE_TOOLS, BROWSER_TOOLS, UI_TOOLS, PLANNING_TOOLS, GRAPH_TOOLS, DATA_TOOLS, TRANSCRIPT_TOOLS, TRANSCRIPT_DOCUMENT_TOOLS, AGENT_MEMORY_TOOLS, RESULT_PAGING_TOOLS, REFERENCE_TOOLS,
  resolveToolDispatch,
  validateToolInput,
  coerceToolInput,
  suggestToolName,
} from "./tools/definitions.js";
import type { ToolDefinition, QCardOption, QCardQuestion } from "./tools/definitions.js";
import { capToolResult, pageResult, searchResult, DEFAULT_PAGE_CHAR_LIMIT, JSON_ESCAPED_NEWLINE } from "./tool-result-paging.js";
import type { AgentMemoryIndex } from "./agent-memory-index.js";
import type { BrowserRunner } from "./chromium-runner.js";
import type { EditProvider } from "./diff-edit-service.js";
import type { JsonOperation } from "./json-pointer.js";
import type { DiagnosticsProvider, ProblemInput } from "./diagnostics-publisher.js";
import type { LspProvider } from "./lsp-service.js";
import type { PlanningProvider } from "./planning-store.js";
import { normalizeStoredPath, type GraphAnnotationProvider } from "./graph-annotation-store.js";
import type {
  AgentStopReason,
  CompressionTrigger,
  PendingGateState,
  PersistedSessionState,
  SessionMessage,
  SessionRestoreState,
  SessionRuntimeState,
} from "./session-state.js";
import { requestApprovalWithDetails, type ApprovalDecision } from "./approval-gate.js";
import { saveCheckpoint, clearCheckpoint } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";
import { streamBedrockConverse, signBedrockRequest, mantleEndpoint } from "./bedrock-client.js";
import type { BedrockThinkingConfig, ConverseOptions } from "./bedrock-client.js";
import {
  DEFAULT_RETRY_POLICY,
  FLEX_STREAM_IDLE_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  computeBackoffMs,
  interruptibleSleep,
  isRetryableError,
  isRetryableStatus,
  isContextOverflowErrorMessage,
  extractContextOverflowLimit,
  parseRetryAfter,
  ProviderStreamError,
} from "./provider-retry.js";
import { resolveOutputCeiling, isOpenAIReasoningModel } from "./model-limits.js";

// Re-exported: call sites and tests reach these through agent-session.
export { resolveOutputCeiling, isOpenAIReasoningModel };
import {
  acceptsSamplingParams,
  canDisableThinking,
  DEFAULT_CLAUDE_EFFORT,
  isFableFamily,
  needsSummarizedDisplay,
  parseClaudeVersion,
  resolveEffort,
  resolveThinkingMode,
  supportsFastMode,
  supportsTaskBudget,
  type ClaudeEffort,
} from "./thinking-modes.js";
// Re-exported: the webview UI gates the new beta-feature toggles on these.
export { isFableFamily, supportsFastMode, supportsTaskBudget };
import type { RetryPolicy } from "./provider-retry.js";
import type {
  BedrockCredentials,
  BedrockCachePoint,
  BedrockContentBlock,
  BedrockConverseStreamEvent,
  BedrockImageFormat,
  BedrockMessage,
  BedrockToolDef,
} from "./bedrock-types.js";
import type {
  AgentMessage,
  CompactionBlock,
  ContentBlock,
  ImageBlock,
  ProviderTurnResult,
  ProviderTurnSession,
  ProviderTurnSink,
  ProviderTurnStreamEvent,
  TextBlock,
  ReasoningBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./agent-loop-contract.js";

const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_MAX_ITER   = 40;
/**
 * Conservative context-window assumed when a model's real window is unknown (not in the
 * static table, absent from the live model catalog, and the catalog fetch failed). Its
 * only job is to keep the compaction and emergency-shedding safety nets engaged — without
 * it, an unrecognized model (exactly the "bring any model" case) ran with *no* context
 * management at all until it hit a hard provider context-overflow 400, which then recurred
 * every send. 128k is low enough to trigger compaction before most modern models overflow,
 * and compaction shrinking history is harmless even if the true window is larger.
 */
const ASSUMED_CONTEXT_LENGTH = 128_000;
/**
 * Above this percentage of the (real or assumed) context window, a compaction pass blocks
 * the turn — headroom must be freed before the next send or the request risks a hard
 * over-length 400. At or below it there is slack to spare, so the pass runs in the
 * background and its summariser round-trip overlaps ongoing work instead of stalling the
 * loop. This is the crux of keeping compaction off the hot path: it's normally triggered at
 * the soft threshold (~60%), lands in the background, and is done well before this ceiling.
 */
const COMPACTION_CRITICAL_PCT = 82;
/**
 * Consecutive compaction failures (see _consecutiveCompressionFailures) before the circuit
 * breaker opens. Each attempt already survives its own intra-call retry (_compressWithRetry),
 * so tripping this requires several fully-failed provider round-trips with zero successes
 * interleaved — a strong signal of persistent misconfiguration (bad model id, wrong key, ...)
 * rather than a blip, since a single success anywhere resets the counter to 0.
 */
const COMPACTION_CIRCUIT_BREAKER_THRESHOLD = 3;
/**
 * Hard ceiling on how long a *blocking* (critical-path) compaction may stall the turn,
 * regardless of the summariser's internal retries, before the loop falls back to emergency
 * tool-output shedding. The pass keeps running in the background past this — its result
 * still lands for a later turn — the deadline only bounds how long the turn waits on it.
 */
const BLOCKING_COMPACTION_DEADLINE_MS = 75_000;
/**
 * Outcome of a single compaction attempt, distinguishing a genuine failure from a legitimate
 * no-op. `_compressHistory` no-ops (returns "skipped", not "failed") when there isn't enough
 * history yet, or when the compressible prefix can't be cut without splitting a tool_use from
 * its tool_result — neither is an error, and treating them as one previously caused a stale
 * `_lastCompressionError` (left over from an earlier, unrelated real failure) to be
 * misreported as "compression just failed" on a run that never attempted anything this pass.
 */
type CompactionOutcome = "compressed" | "skipped" | "failed";
/**
 * Names of the always-on, non-toggleable UI tools (currently just question_card) — mirrors
 * the carve-out in `_getTools()`, which appends UI_TOOLS after the disabled-tool filter so
 * they can never be hidden. The dispatch-time disabled-tool gate (`_toolValidationError`)
 * checks against this too, so a stale or malformed disabledTools entry can never block one
 * of these: advertised-always must mean dispatchable-always, or the two would disagree.
 */
const UI_TOOL_NAMES = new Set(UI_TOOLS.map((t) => t.name));

/** The JSON schema checks types and required fields, but JSON Schema's optional item-count
 * constraints are not part of the compact tool-definition helpers. Validate the interaction
 * contract here so a malformed model call cannot render a card with nothing selectable and
 * suspend the agent indefinitely. */
function validateQuestionCardQuestions(questions: QCardQuestion[]): string | null {
  if (questions.length < 1 || questions.length > 4) {
    return "Invalid question card: provide between 1 and 4 questions.";
  }
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
    const question = questions[questionIndex]!;
    if (!question.question.trim()) return `Invalid question card: question ${questionIndex + 1} is empty.`;
    if (question.options.length < 1 || question.options.length > 4) {
      return `Invalid question card: question ${questionIndex + 1} needs between 1 and 4 options.`;
    }
    const optionKeys = new Set<string>();
    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
      const option = question.options[optionIndex]!;
      if (!option.key.trim()) return `Invalid question card: option ${optionIndex + 1} in question ${questionIndex + 1} has no key.`;
      if (!option.label.trim()) return `Invalid question card: option ${optionIndex + 1} in question ${questionIndex + 1} has no label.`;
      if (optionKeys.has(option.key)) return `Invalid question card: option keys in question ${questionIndex + 1} must be unique.`;
      optionKeys.add(option.key);
    }
  }
  return null;
}

const MAX_INTERNAL_AUTO_CONTINUE_TURNS = 3;
/**
 * Forced end-of-turn continuations allowed to prompt for a Codebase Map note
 * on a file the session edited, before the requirement fails open. Separate
 * from MAX_INTERNAL_AUTO_CONTINUE_TURNS (which recovers from truncated/
 * malformed tool calls — a different failure mode) so the two counters can't
 * compound into a longer stall than either was designed for. Deliberately
 * small and fail-open: this is a nudge toward the harness's preferred
 * behavior, not a hard gate that could strand a long-running session.
 */
const MAX_NOTE_ENFORCEMENT_CONTINUATIONS = 2;
/**
 * A prompt is only useful when the agent is demonstrably stuck, not merely investigating.
 * Three *identical* tool rounds (same calls, arguments, and returned results) have supplied
 * no new evidence and are a reliable loop signal; six arbitrary read-only calls are not.
 */
const DUPLICATE_TOOL_ROUND_THRESHOLD = 3;
/** Capped so a model that ignores a recovery prompt still reaches its normal turn limit. */
const MAX_DUPLICATE_TOOL_ROUND_NUDGES = 3;
/** Oldest-truncated-result eviction cap for _resultOverflow — bounds memory on a long
 *  session that keeps triggering large-output tools; only overflowed results are kept. */
const RESULT_OVERFLOW_MAX_ENTRIES = 30;
/** Hard ceiling when auto-escalating the output budget after truncation recovery. */
const MAX_ESCALATED_OUTPUT_TOKENS = 65536;
/**
 * Escalation ceiling used instead of MAX_ESCALATED_OUTPUT_TOKENS when the user has enabled
 * "Unlimited" max tokens (opts.maxTokensUnlimited). There is no such thing as a truly
 * unlimited request — every provider has a real ceiling — so this is a generous sanity bound
 * (matching the Max Tokens field's own UI input cap) rather than an actual absence of limit.
 * resolveOutputCeiling below still clamps to any known hard provider ceiling (e.g. Bedrock
 * Claude's 64000) on top of this, so "unlimited" can never produce a request the provider is
 * documented to reject outright.
 */
const MAX_ESCALATED_OUTPUT_TOKENS_UNLIMITED = 200_000;
/**
 * Maximum characters for the accumulated compressed-history summary before
 * a re-condensation pass collapses it back to a single block. Keeps the
 * uncached system-prompt summary block bounded so it doesn't become the new
 * unbounded-context vector across a long-horizon (e.g. 1000-iteration) run.
 * ~30k chars ≈ 7-8k tokens at typical English density.
 */
const MAX_SUMMARY_CHARS = 30_000;
/**
 * Persist the full uncompressed `_fullHistory` only every N checkpoint writes.
 * On the iterations between, only the active (compressed) message window is
 * serialised — bounded by `keepRecent`, so O(1) rather than O(n) per iteration.
 * Full history is always written on the first checkpoint and on terminal states
 * (error / cancelled) so resume fidelity is never compromised.
 */
const FULL_HISTORY_CHECKPOINT_CADENCE = 10;
/** The thinking block to send, already reconciled with what the model actually accepts. */
export type ResolvedThinking =
  /** Send no `thinking` field. Only a valid "off" for budget-era models (and the only legal
   *  shape for Fable/Mythos, which think unconditionally). */
  | { kind: "omit" }
  /** `thinking: {type: "disabled"}` — the explicit off switch. Required on Sonnet 5, where an
   *  absent field runs adaptive anyway. */
  | { kind: "disabled" }
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
    // adaptive, so off has to be stated. Fable/Mythos are the exception — they cannot be turned
    // off and reject `{type: "disabled"}`, so there the only legal shape is to omit the field.
    const thinking: ResolvedThinking = mode === "adaptive" && canDisableThinking(model)
      ? { kind: "disabled" }
      : { kind: "omit" };
    return { maxTokens, thinking, effort, temperature };
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
  opts: Pick<AgentSessionOptions, "fastMode" | "taskBudgetTokens" | "contextEditingEnabled" | "compactionTriggerTokens" | "refusalFallbackEnabled">,
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
    contextManagementEdits.push({ type: "clear_tool_uses_20250919" });
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

  // Default-on for Fable/Mythos per Anthropic's guidance ("default to opting in"); explicit
  // `false` disables it. Not sent on Mantle — see the doc comment above.
  if (!isMantle && opts.refusalFallbackEnabled !== false && isFableFamily(model)) {
    bodyExtras["fallbacks"] = [{ model: "claude-opus-4-8" }];
    betas.push("server-side-fallback-2026-06-01");
  }

  return { betas, bodyExtras, taskBudgetTokens };
}

const INTERNAL_AUTO_CONTINUE_PROMPT = [
  "[Internal continuation]",
  "Continue working on the current task.",
  "Do not stop yet unless the task is complete, you need user approval/input, or you are blocked by a concrete external failure.",
  "If the previous response ended right after tool work, inspect the latest result and take the next step now.",
].join("\n");

function noteEnforcementPrompt(paths: string[]): string {
  return [
    "[Internal continuation]",
    `You edited the following file(s) without leaving a Codebase Map note: ${paths.join(", ")}.`,
    "Recording a note is required after an edit. Call map_note_add for each file (or map_note_update, if map_note_list shows a related note already worth refining instead) — a short sentence on what changed and why is enough — then finish.",
  ].join("\n");
}

/**
 * A focused progress check for a verified duplicate-work loop. This is deliberately a
 * plain reminder, not a forced continuation: the model still controls whether to act,
 * explain a blocker, or finish after it has considered the evidence already gathered.
 */
function duplicateToolRoundPrompt(rounds: number, tools: string): string {
  return [
    "[Internal progress check]",
    `The last ${rounds} tool rounds repeated the same work (${tools}) and returned the same results.`,
    "That has not produced new evidence. Use the results already available to take a decisive next step, or explain the concrete blocker to the user. Only call another tool when it will gather different information or perform the next action.",
  ].join("\n");
}

// ── Provider config ────────────────────────────────────────────────────────────

export type ProviderName = "anthropic" | "openrouter" | "openai" | "bedrock";

const PROVIDER_DEFAULTS: Record<ProviderName, { baseUrl: string; authHeader: "x-api-key" | "Bearer" }> = {
  anthropic:  { baseUrl: "https://api.anthropic.com/v1/messages",          authHeader: "x-api-key" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1/chat/completions",   authHeader: "Bearer" },
  openai:     { baseUrl: "https://api.openai.com/v1/chat/completions",      authHeader: "Bearer" },
  // Bedrock signs requests per-call (SigV4) and resolves its endpoint from the
  // region; this entry only satisfies the Record type — the Bedrock path never reads it.
  bedrock:    { baseUrl: "",                                                authHeader: "x-api-key" },
};

// ── Public event types ─────────────────────────────────────────────────────────

export type BaseAgentEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** A retryable failure killed the in-flight generation. Every text/thinking delta emitted
   *  since the last turn boundary is void — discard the live assistant bubble; the retry's
   *  output follows and replaces it. */
  | { type: "turn_reset"; reason: string }
  | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "runtime_state"; state: SessionRuntimeState }
  | { type: "execution_diagnostic"; level: "info" | "warn" | "error"; message: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string; inputPreview: string; input: Record<string, unknown> }
  | { type: "tool_call_result"; toolCallId: string; toolName: string; ok: boolean; summary: string; result: unknown; elapsedMs: number }
  | { type: "approval_pending"; toolCallId: string; description: string; tier: string; unrecognizedCommand?: boolean }
  | { type: "approval_result"; toolCallId: string; granted: boolean; decision: ApprovalDecision }
  | { type: "question_card_pending"; toolCallId: string; questions: QCardQuestion[] }
  | { type: "question_card_result"; toolCallId: string; answers: string[][] }
  | { type: "turn_complete"; stopReason: AgentStopReason; iterations: number }
  | { type: "error"; message: string };

export type SubagentComplexity = "auto" | "standard" | "complex" | "deep";

export interface SubagentSpawnInput {
  task: string;
  context?: string;
  complexity?: SubagentComplexity;
  label?: string;
  parallel?: boolean;
  profileId?: string;
  /** Optional link to one step of a tracked plan (see plan_create/plan_update) — when all three
   *  are set, the linked step is synced automatically as this lane runs (see
   *  AgentSession._syncSubagentStepStart/_syncSubagentStepEnd). */
  planId?: string;
  phaseId?: string;
  stepId?: string;
}

export interface SubagentBudgetSummary {
  complexity: Exclude<SubagentComplexity, "auto">;
  timeoutSeconds: number;
  maxToolRounds: number;
}

export interface SubagentSpawnToolResult {
  ok: true;
  subRequestId: string;
  answer: string;
  toolRounds: number;
  usage: null;
  scratchFiles: [];
  budget: SubagentBudgetSummary;
  nextStep?: string;
}

export type SubagentProviderMessage =
  | {
    type: "subagent_lane_start";
    parentToolCallId: string;
    laneId: string;
    subRequestId: string;
    label: string;
    task: string;
  }
  | {
    type: "subagent_lane_event";
    parentToolCallId: string;
    laneId: string;
    event: BaseAgentEvent;
  }
  | {
    type: "subagent_lane_complete";
    parentToolCallId: string;
    laneId: string;
    subRequestId: string;
    label: string;
    ok: boolean;
    answer: string;
    error?: string;
    elapsedMs: number;
    stopReason: string;
    toolRounds: number;
    budget: SubagentBudgetSummary;
  }
  | {
    type: "subagent_tool_result";
    result: { ok: false; error: string } | SubagentSpawnToolResult;
  };

export interface SubagentSpawnRequest {
  parentSessionId: string;
  parentToolCallId: string;
  input: SubagentSpawnInput;
  signal?: AbortSignal;
}

export interface SubagentProvider {
  spawn(request: SubagentSpawnRequest): AsyncGenerator<SubagentProviderMessage>;
}

export type AgentEvent = BaseAgentEvent
  | Exclude<SubagentProviderMessage, { type: "subagent_tool_result" }>;

export type { QCardOption, QCardQuestion };

// ── Anthropic message types ────────────────────────────────────────────────────


// ── OpenAI message types ───────────────────────────────────────────────────────

interface OAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
type OAIContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string } };
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OAIContentPart[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

/** Anthropic-family APIs (direct, Bedrock Converse, Mantle) accept temperature in
    [0, 1] only, while the settings slider spans the OpenAI-style [0, 2] range. A
    user who dialed 1.3 on OpenAI and then switched provider would otherwise get a
    400 on every call — clamp instead of failing the turn. */
function clampAnthropicTemperature(t: number | undefined): number | undefined {
  return t === undefined ? undefined : Math.max(0, Math.min(1, t));
}

/** Stop reasons the harness owns rather than the provider — passed through untouched by every
 *  normalizer so a value the loop itself assigned can round-trip. */
function isHarnessStopReason(reason: string): reason is AgentStopReason {
  return reason === "max_iterations" || reason === "approval_pending" || reason === "question_pending"
    || reason === "cancelled" || reason === "error" || reason === "refusal"
    || reason === "context_window_exceeded" || reason === "protocol_violation";
}

export function normalizeOpenAIStopReason(reason: string): AgentStopReason {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  // A filtered completion is a real terminal outcome, not a malformed turn. Mapping it to
  // protocol_violation (as before) sent it into the truncation-recovery path, which reverts
  // the turn and retries with a doubled output budget against a model that will filter again.
  if (reason === "content_filter") return "refusal";
  if (reason === "end_turn" || isHarnessStopReason(reason)) return reason as AgentStopReason;
  return "protocol_violation";
}

/**
 * Classify an OpenAI-compatible mid-stream error chunk (`{"error":{...}}`, sent by OpenRouter
 * and some gateways after the HTTP response already streamed 200 + partial content), or `null`
 * if `ev` isn't one. Exported pure function for the same reason as `anthropicStreamError` —
 * directly testable without driving the private `_streamTurnOpenAI` streaming method.
 *
 * Retryability comes from the chunk's own `code`, which these gateways populate with the HTTP
 * status of the upstream failure (429 on a rate limit, 502/503 when the routed model is
 * unreachable). Absent a recognisable status the error is treated as fatal: an unknown
 * mid-stream failure is more likely a broken request than a blip, and retrying it would just
 * burn the same error four more times before failing anyway.
 */
export function openAIStreamError(ev: Record<string, unknown>): ProviderStreamError | null {
  const streamError = ev["error"] as Record<string, unknown> | string | undefined;
  if (!streamError) return null;
  if (typeof streamError === "string") return new ProviderStreamError(streamError, false);
  const message = String(streamError["message"] ?? JSON.stringify(streamError));
  const rawCode = streamError["code"] ?? streamError["status"];
  const code = typeof rawCode === "number" ? rawCode : Number.parseInt(String(rawCode ?? ""), 10);
  return new ProviderStreamError(message, Number.isFinite(code) && isRetryableStatus(code));
}

export function normalizeAnthropicStopReason(reason: string): AgentStopReason {
  if (!reason || reason === "end_turn") return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  // An input-side overflow, not an output cut-off — recovered by compacting, never by escalating
  // the output budget (which would make the very request that overflowed even bigger).
  if (reason === "model_context_window_exceeded") return "context_window_exceeded";
  // See normalizeOpenAIStopReason: a refusal is terminal, not a truncated turn.
  if (reason === "refusal") return "refusal";
  // `pause_turn` ends a long-running turn that the model expects to continue. The harness has
  // no server-side tools that produce it, and treating it as a clean stop lets the normal
  // end_turn/tool_use handling decide what happens next — unlike protocol_violation, which
  // would revert the (perfectly valid) turn and escalate the output budget.
  if (reason === "pause_turn" || reason === "stop_sequence") return "end_turn";
  if (isHarnessStopReason(reason)) return reason;
  return "protocol_violation";
}

/** Anthropic SSE error types that are transient (the request itself was fine). `overloaded_error`
 *  is Anthropic's 529 and by far the most common; the rest mirror the retryable HTTP statuses. */
const ANTHROPIC_RETRYABLE_STREAM_ERRORS = new Set([
  "overloaded_error",
  "api_error",
  "rate_limit_error",
  "timeout_error",
]);

/**
 * Classify an Anthropic-shaped SSE `{"type":"error","error":{...}}` event (also sent by Bedrock
 * Mantle, which shares the parser). Exported as a pure function (same pattern as
 * `isBedrockCacheValidationError` below) so the classification is directly unit-testable without
 * driving the private streaming methods that call it.
 */
export function anthropicStreamError(ev: Record<string, unknown>): ProviderStreamError {
  const err = ev["error"] as Record<string, unknown> | undefined;
  const errType = String(err?.["type"] ?? "unknown_error");
  const errMsg = String(err?.["message"] ?? "Anthropic reported a stream error.");
  return new ProviderStreamError(
    `Anthropic stream error (${errType}): ${errMsg}`,
    ANTHROPIC_RETRYABLE_STREAM_ERRORS.has(errType),
  );
}

// ── Options ────────────────────────────────────────────────────────────────────

export interface ThinkingConfig {
  enabled: boolean;
  /** Fixed thinking-token budget. Used only by budget-era models (Claude 3.7 – 4.5); the modern
   *  generation rejects it with a 400 and takes {@link ThinkingConfig.effort} instead. */
  budgetTokens: number;
  /** Thinking depth for adaptive-era models (Claude 4.6+). Clamped per model at request time by
   *  {@link resolveEffort}, so a value persisted against one model can't 400 on another. */
  effort?: ClaudeEffort;
}

/**
 * The full OpenAI reasoning-depth ladder, ordered shallowest → deepest. Which rungs a
 * given model accepts varies by family (see {@link supportedReasoningEfforts}); requests
 * clamp to the nearest supported rung via {@link resolveReasoningEffort} so switching
 * models can never turn a persisted setting into a 400-per-turn failure.
 */
export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * OpenAI processing tier. "flex" trades latency (queued, capacity-dependent) for roughly
 * half-price tokens on supported flagship models; "priority" is the inverse. "auto"/unset
 * sends no service_tier field at all, leaving the account default in charge.
 */
export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";

/**
 * OpenRouter's `provider` routing-preferences object, forwarded verbatim on the request.
 * All fields optional — an empty/all-undefined object sends nothing, leaving OpenRouter's
 * own defaults (try every provider of the routed model, no ZDR requirement) in charge.
 */
export interface OpenRouterProviderPreferences {
  /** Provider slugs to try, in order (e.g. ["anthropic", "google-vertex"]). */
  order?: string[];
  /** When false, only the ordered providers are tried — no silent fallback to others. */
  allowFallbacks?: boolean;
  /** "deny" restricts routing to providers with a zero-data-retention policy. */
  dataCollection?: "allow" | "deny";
  sort?: "price" | "throughput" | "latency";
}

/** Prompt-cache breakpoint TTL. "5m" (the default — sends the bare `{type:"ephemeral"}`
 *  shape) or "1h" (adds `ttl:"1h"`, a 2x cache-write premium instead of 1.25x, but survives
 *  gaps in bursty traffic that would otherwise miss a 5-minute cache). */
export type CacheTtl = "5m" | "1h";

export interface AgentSessionOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  workspaceRoot: string;
  runtime: LocalRuntime;
  context: vscode.ExtensionContext;
  provider?: ProviderName;
  baseUrl?: string;
  /** AWS region + credentials for the Bedrock provider (provider === "bedrock"). */
  bedrock?: BedrockCredentials;
  /** Selects the Bedrock API path: "converse" (default) or "mantle" (Messages API). */
  bedrockApi?: "converse" | "mantle";
  signal?: AbortSignal;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** When true, ignore `maxTokens` and request the highest output budget the harness will
   *  ask for (see MAX_ESCALATED_OUTPUT_TOKENS_UNLIMITED) — still clamped by any known hard
   *  provider ceiling (resolveOutputCeiling). Not a literal absence of limit; see that
   *  constant's comment for why one can't exist. */
  maxTokensUnlimited?: boolean;
  /** Extended thinking for Claude models that support it (claude-3-7+, claude-4+). */
  thinking?: ThinkingConfig;
  /**
   * Reasoning depth for OpenAI reasoning models (o-series, gpt-5+). Accepts the full
   * ladder incl. the newer "none"/"minimal"/"xhigh" rungs; clamped per model family at
   * request time (see {@link resolveReasoningEffort}).
   */
  reasoningEffort?: OpenAIReasoningEffort;
  /**
   * OpenAI processing tier (direct OpenAI provider only). "flex" runs supported flagship
   * models at reduced rates with queued, capacity-dependent latency — the session
   * automatically retries once at the standard tier if flex capacity is unavailable.
   */
  serviceTier?: OpenAIServiceTier;
  /**
   * Use the OpenAI Responses API instead of Chat Completions for this session's turns.
   * Only takes effect for `provider: "openai"` on a reasoning model (o-series, gpt-5+) — a
   * no-op everywhere else (OpenRouter, non-reasoning OpenAI models). The benefit is reasoning
   * continuity across a tool-call round trip: the model's encrypted reasoning state from one
   * turn is replayed into the next, instead of Chat Completions' every-turn-from-scratch
   * reasoning. See {@link isOpenAIReasoningModel}.
   */
  useResponsesApi?: boolean;
  /** Tool names to suppress — these are not passed to the model. */
  disabledTools?: string[];
  /**
   * Service families (github/gitlab/jira/confluence/salesforce) whose credentials are
   * configured. Only these are advertised to the model; the rest are withheld so the
   * catalog reflects real capability. Omit (undefined) to advertise all service tools —
   * back-compat for callers that don't resolve credentials up front.
   */
  configuredServices?: ReadonlySet<string>;
  /**
   * Supplies the live "Current workspace state" block, refreshed before every provider
   * turn (including internal post-tool continuations).
   * Injected at the message tail so it stays current without invalidating the cached
   * static system prompt. Omit to send no live workspace block.
   */
  workspaceContextProvider?: () => Promise<string>;
  /** Provides service-layer credentials for github/gitlab/jira/confluence/salesforce calls. */
  serviceKeyProvider?: (service: string) => Promise<string | undefined>;
  /** Chromium runner — enables browser_* tools via local Playwright instance. */
  browserRunner?: BrowserRunner;
  /** Resolves question_card tool calls by presenting the question set to the user and returning the
   *  selected keys for each question, index-aligned with the input array. */
  questionCardProvider?: (toolCallId: string, questions: QCardQuestion[]) => Promise<string[][]>;
  /** Resolves approval-gated tool calls through the extension UI instead of a modal host prompt. */
  approvalProvider?: (toolCallId: string, toolName: string, description: string, tier: string) => Promise<ApprovalDecision>;
  /** Backs the memory_* tools with persistent project memory/context storage. */
  memoryProvider?: MemoryProvider;
  /** Backs the plan_* and todo_* tools with persistent workspace planning state. */
  planningProvider?: PlanningProvider;
  /** Backs the map_note_* tools with persistent Codebase Map working memory. */
  graphProvider?: GraphAnnotationProvider;
  /** Backs the db_* tools with the embedded database surface (read-only + classify). */
  dataProvider?: DataToolProvider;
  /** Backs the reference_* tools with permanent per-conversation attachment storage. */
  referenceProvider?: ReferenceToolProvider;
  /** True when the active model can see image content blocks directly. */
  supportsVision?: boolean;
  /** Describes an image via a secondary model, for reference_zoom_image when supportsVision is false. */
  visionFallbackProvider?: VisionFallbackProvider;
  /** Backs the file_edit tool with a diff-preview-and-apply flow in the editor. */
  editProvider?: EditProvider;
  /**
   * Collects language-server diagnostics for freshly mutated files (host-side, needs
   * vscode). When present, a successful file_write result gains the same `diagnostics`
   * field file_edit and the mutating code_* tools already attach — every mutation then
   * reports its fallout in the same turn, instead of file_write alone needing a
   * follow-up code_diagnostics round.
   */
  mutationDiagnosticsProvider?: (paths: string[]) => Promise<unknown | undefined>;
  /** Backs the report_problems tool with VS Code's Problems panel. */
  diagnosticsProvider?: DiagnosticsProvider;
  /** Backs the code_* tools with VS Code's language-server intelligence. */
  lspProvider?: LspProvider;
  /** HTTP-Referer header for OpenRouter requests. Defaults to "https://blacksite.dev". */
  httpReferer?: string;
  /** X-Title header for OpenRouter requests. Defaults to "Blacksite". */
  xTitle?: string;
  /** OpenRouter provider-routing preferences (order, fallback policy, ZDR, sort). */
  openrouterProvider?: OpenRouterProviderPreferences;
  /** OpenRouter model fallback list — sent as the top-level `models` field alongside
   *  `model`; OpenRouter tries them in order if the primary is rate-limited/unavailable. */
  openrouterFallbackModels?: string[];
  /** Prompt-cache breakpoint TTL for every provider path that marks `cache_control`
   *  (Anthropic, Bedrock Mantle, OpenRouter). Omit for the "5m" default. */
  cacheTtl?: CacheTtl;
  /**
   * Anthropic fast mode (beta fast-mode-2026-02-01, Opus 4.8/4.7 only, first-party API).
   * Runs the same model at up to 2.5x higher output tokens/sec at premium pricing. No-op on
   * an ineligible model or a non-Anthropic provider — see {@link supportsFastMode}.
   */
  fastMode?: boolean;
  /**
   * Task budget (beta task-budgets-2026-03-13) in tokens — gives the model a self-paced
   * ceiling for an agentic loop instead of an enforced per-response cut-off. Minimum 20,000
   * (clamped up). Anthropic-direct only (not available on Bedrock/Vertex/Foundry); no-op on
   * an ineligible model — see {@link supportsTaskBudget}.
   */
  taskBudgetTokens?: number;
  /**
   * Context editing (beta context-management-2025-06-27) — clears stale tool_use/tool_result
   * content server-side before the model sees it, keeping the effective prompt lean without
   * summarizing. Available on Anthropic-direct and Bedrock Mantle.
   */
  contextEditingEnabled?: boolean;
  /**
   * Server-side compaction (beta compact-2026-01-12) in input tokens — when the conversation's
   * input reaches this size, the API summarizes earlier history into a `compaction` content
   * block server-side before generating, and automatically drops everything before that block
   * on future requests. Minimum 50,000 (clamped up). Undefined/0 disables it. Available on
   * Anthropic-direct and Bedrock Mantle. When set, the session skips its own client-side
   * auto-compaction trigger for this provider — running both would double-summarize and waste
   * a full extra model call for no benefit.
   */
  compactionTriggerTokens?: number;
  /**
   * Server-side refusal fallback (beta server-side-fallback-2026-06-01) for Claude Fable 5 /
   * Mythos 5 — retries a policy-declined turn on claude-opus-4-8 within the same request.
   * Anthropic recommends opting in by default; set `false` to disable. No-op on non-Fable
   * models or on Bedrock Mantle (the server-side param isn't available there — see the
   * skill's refusal-fallback docs for the client-side-middleware alternative this session
   * does not implement).
   */
  refusalFallbackEnabled?: boolean;
  /** Maximum number of concurrent parallel subagent lanes per turn. Default: 4. */
  subagentMaxConcurrent?: number;
  /** Spawns delegated child sessions that stream into nested transcript lanes. */
  subagentProvider?: SubagentProvider;
  /** Persist checkpoints for resume; disable for delegated child sessions. */
  checkpointingEnabled?: boolean;
  /** Maximum context window for the current model (tokens). Used for the context usage meter. */
  contextLength?: number;
  /**
   * Transient-failure retry policy for provider calls (429 / 529 / 5xx / dropped sockets).
   * Omit for {@link DEFAULT_RETRY_POLICY}. Set `{ maxAttempts: 1, … }` to disable retrying.
   */
  retryPolicy?: RetryPolicy;
  /**
   * How a confirm-tier (write/network/destructive) tool call is resolved when no
   * interactive approver is wired — i.e. autonomous/headless runs and delegated
   * subagents. "interactive" (default) prompts via the host modal and can block
   * indefinitely; "deny" refuses with an actionable error so the model can adapt;
   * "allow" auto-confirms. Ignored when an approvalProvider is supplied.
   */
  autonomousApprovalPolicy?: "interactive" | "deny" | "allow";
  /** When set, enables model-based compression of older history once the context fills up. */
  compressionProvider?: CompressionProvider;
  /** Percentage of contextLength (0–100) that triggers compression. Default: 60. */
  compressionTriggerPct?: number;
  /** Number of most-recent messages to keep verbatim after compression. Default: 20. */
  compressionKeepRecent?: number;
  /** Provides the agent's transcript_read tool with access to the full uncompressed history. */
  transcriptProvider?: TranscriptProvider;
  /** Creates long-form Markdown deliverables as conversation-scoped attachments. */
  transcriptDocumentProvider?: TranscriptDocumentProvider;
  /** Semantic memory index — enables tool-call similarity injection and rolling transcript chunk search. */
  agentMemoryIndex?: AgentMemoryIndex;
  providerTurnSessionFactory?: (session: AgentSession) => ProviderTurnSession;
}

export interface MemoryProvider {
  append(note: string): void;
  readMemory(): string;
  readContext(): string;
}

/** Routes db_* tool calls to the embedded database surface. Writes are never executed. */
export interface DataToolProvider {
  dispatch(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Routes reference_* tool calls to permanent per-conversation attachment storage, scoped by sessionId. */
export interface ReferenceToolProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: { sessionId: string }): Promise<Record<string, unknown>>;
}

/** Describes an image via a configured secondary model, for models with no vision support. */
export interface VisionFallbackProvider {
  describeImage(mediaType: string, base64Data: string, instruction: string): Promise<string>;
}

export interface CompressionProvider {
  compress(messages: AgentMessage[]): Promise<string>;
}

export interface TranscriptProvider {
  getFullHistory(): AgentMessage[];
}

/** Routes transcript_document to durable storage tied to the current conversation. */
export interface TranscriptDocumentProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: { sessionId: string }): Promise<Record<string, unknown>>;
}

// ── AgentSession ───────────────────────────────────────────────────────────────

export class AgentSession {
  sessionId: string;
  private messages: AgentMessage[] = [];
  private _iteration = 0;
  private readonly provider: ProviderName;
  /**
   * The abort signal is mutable because the owning BackgroundRunner creates its
   * AbortController only when a run actually starts — after this session has been
   * constructed. Reading opts.signal directly would capture `undefined` and break
   * cancellation, so the runner calls attachSignal() right before iterating.
   */
  private _signal?: AbortSignal;
  /** Set once the user chooses "Allow All" — suppresses further approval prompts for this session. */
  private _autoApprove = false;
  /** Accumulated JSON summary from model-based compression of older history. */
  private _compressedSummary = "";
  /** Number of compressions applied this session. */
  private _compressionCount = 0;
  /** Total input token count from the most recent API response (including cache tokens). */
  private _lastInputTokens = 0;
  /** Whether a compression pass is currently running. */
  private _isCompacting = false;
  /**
   * In-flight background compaction, if any. Guards against starting overlapping passes and
   * lets a later critical trigger await the pass already running rather than duplicating it.
   */
  private _compactionInFlight?: Promise<CompactionOutcome>;
  /**
   * Diagnostics produced by a background compaction that finished between yields. A
   * background task can't yield into the event stream itself, so it queues its completion
   * message here and the loop surfaces it at the next iteration boundary.
   */
  private _pendingCompactionNotices: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  /**
   * Consecutive compaction failures (reset to 0 on any success). A persistently broken
   * compression config — bad model id, wrong key, unsupported param — otherwise gets retried
   * on nearly every subsequent qualifying tool round for the rest of the session, hammering a
   * doomed call every 20-60s. See _compactionCircuitOpen.
   */
  private _consecutiveCompressionFailures = 0;
  /**
   * Set once _consecutiveCompressionFailures reaches COMPACTION_CIRCUIT_BREAKER_THRESHOLD.
   * While open, automatic (background/critical) compaction triggers skip straight to shedding
   * old tool output instead of attempting another doomed provider call. Reset only by a
   * successful compaction pass (including a user-triggered manualCompact, which is never
   * gated by this flag) — never auto-resets on a timer, since the observed failure mode is a
   * persistent config error, not a transient outage.
   */
  private _compactionCircuitOpen = false;
  /** Timestamp of the most recent successful compression pass. */
  private _lastCompressedAt: number | undefined;
  /** Number of messages compacted during the most recent successful pass. */
  private _lastCompressedMessageCount: number | undefined;
  /** Last compression failure message, if any. */
  private _lastCompressionError = "";
  /** Whether the most recent compression was automatic or manual. */
  private _lastCompressionTrigger: CompressionTrigger | undefined;
  /** Last normalized terminal reason observed for this session. */
  private _lastStopReason: AgentStopReason | undefined;
  /** Number of internal auto-continue prompts issued in the current session. */
  private _autoContinueCount = 0;
  /** Workspace-relative paths edited this session with no qualifying
      Codebase Map note recorded since (see _trackToolResultForNotes and the
      end-of-turn check in _run()). */
  private _dirtyMapFiles = new Set<string>();
  /** Forced end-of-turn continuations issued so far for the current
      unresolved batch of dirty files — resets to 0 once _dirtyMapFiles empties,
      so a later, unrelated editing episode gets its own fresh budget rather
      than a single lifetime cap for the whole session. */
  private _noteEnforcementCount = 0;
  /** Last complete tool round, ignoring ephemeral tool-call ids. Used only to detect an
      exact no-new-evidence loop; legitimate multi-step investigation never trips it. */
  private _lastToolRoundFingerprint = "";
  private _duplicateToolRoundCount = 0;
  private _duplicateToolRoundNudgeCount = 0;
  /** Set after the missing-contextLength diagnostic has been emitted once. */
  private _contextLengthWarned = false;
  /**
   * Set once a Bedrock Converse call rejects a request specifically because of its
   * cache breakpoints (some models/regions/quota configurations don't support prompt
   * caching, and unlike the ARN-based context-length gap, this can't be capability-checked
   * ahead of time from the model id alone). Once set, subsequent Bedrock turns this
   * session skip cache breakpoints entirely instead of paying a failed-request retry
   * every turn.
   */
  private _bedrockCacheUnsupported = false;
  /** Set after an endpoint rejects `strict: true` tool definitions (Anthropic/Mantle) — the
   *  session then sends plain schemas for the rest of its life instead of probing every turn. */
  private _strictToolsUnsupported = false;
  /** Current pending user gate, if the loop is waiting on approval or an answer. */
  private _pendingGate: PendingGateState | undefined;
  /** Timestamp when the first checkpoint was saved for this session; preserved across updates. */
  private _checkpointCreatedAt: number | undefined;
  /** How many times _saveCheckpoint has been called; used to throttle full-history writes. */
  private _checkpointCount = 0;
  /** Immutable transcript: every message ever appended, never trimmed by compression. */
  private _fullHistory: AgentMessage[] = [];
  /** Per-turn output-token budget override; escalates on truncation recovery, resets on success. */
  private _maxTokensOverride?: number;
  /** Set once a browser call reports the runtime missing; stops re-advertising browser tools. */
  private _browserUnavailable = false;
  /** Live "Current workspace state" block, refreshed before each provider turn and injected at the message tail. */
  private _workspaceContext = "";
  /**
   * Full text of tool results too large to send to the model in one piece, keyed by the
   * tool_call id the model already has from its own tool_use block — so resuming a read
   * needs no new id scheme, just the offset from the truncation notice. FIFO-evicted past
   * RESULT_OVERFLOW_MAX_ENTRIES so a long session pinning many huge outputs can't leak memory.
   */
  private readonly _resultOverflow = new Map<string, string>();
  /** Provider-turn session driving the next model turn. */
  private readonly _providerTurnSession: ProviderTurnSession;
  /**
   * Live copy of the disabled-tool set, seeded from opts.disabledTools but mutable via
   * {@link updateDisabledTools} — unlike the rest of `opts` (frozen for the session's
   * lifetime), this one needs to react to a mid-conversation settings change. The
   * subagent-delegation toggle in particular exists specifically so a user can cut off
   * further token spend on an *already-running* conversation, not just the next one — so
   * "disable subagents" has to take effect on the live session, not just future sessions.
   */
  private _disabledTools: Set<string>;

  constructor(private readonly opts: AgentSessionOptions) {
    this.sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.provider = opts.provider ?? "anthropic";
    this._signal = opts.signal;
    this._disabledTools = new Set(opts.disabledTools ?? []);
    this._providerTurnSession = opts.providerTurnSessionFactory
      ? opts.providerTurnSessionFactory(this)
      : this._createBuiltinProviderTurnSession();
  }

  /** Attach (or replace) the abort signal used to cancel in-flight requests and tool calls. */
  attachSignal(signal: AbortSignal): void {
    this._signal = signal;
  }

  /**
   * Refresh best-effort: a transient git/index/filesystem failure must not block
   * the run, and retaining the last known-good block is safer than replacing it
   * with an empty snapshot. Called at model-turn granularity so edits, diagnostics,
   * plans, memory, and architectural knowledge from the previous tool round are
   * visible when the agent decides what to do next.
   */
  private async _refreshWorkspaceContext(): Promise<void> {
    if (!this.opts.workspaceContextProvider) return;
    try {
      this._workspaceContext = await this.opts.workspaceContextProvider();
    } catch { /* keep the last-known workspace block */ }
  }

  /**
   * Live-update which tools are hidden from the model and blocked at dispatch. Takes effect
   * immediately — the very next tool-list build (every iteration) stops advertising a newly
   * disabled tool, and any call to it (including one already in flight when the model decided
   * to make it, or a stale/hallucinated call to a name the model still remembers from earlier
   * in the transcript) is rejected at dispatch. Deliberately does not touch the cached system
   * prompt: the prompt is a static, cache-eligible block that may reference delegation, and
   * regenerating it per toggle would invalidate the Anthropic/Bedrock prompt cache on every
   * settings change — a hint the model can no longer act on is harmless, since the tool is
   * simply unavailable if it tries.
   */
  updateDisabledTools(disabledTools: string[]): void {
    this._disabledTools = new Set(disabledTools);
  }

  get iteration(): number { return this._iteration; }
  get history(): SessionMessage[] { return [...this.messages]; }
  /** Full uncompressed transcript — every message since session start, never trimmed. */
  get fullHistory(): SessionMessage[] { return [...this._fullHistory]; }
  get runtimeState(): SessionRuntimeState { return this._buildRuntimeState(); }
  /** Whether this session's model can see image content blocks. Callers building image
   *  payloads must consult THIS (not a fresh capability resolve) so the text note and the
   *  actual blocks can never disagree about what the model receives. */
  get supportsVision(): boolean { return this.opts.supportsVision === true; }

  exportState(includeFullHistory = false): PersistedSessionState {
    const state: PersistedSessionState = {
      compressedSummary: this._compressedSummary || undefined,
      compressionCount: this._compressionCount || undefined,
      lastInputTokens: this._lastInputTokens || undefined,
      lastCompressedAt: this._lastCompressedAt,
      lastCompressedMessageCount: this._lastCompressedMessageCount,
      lastCompressionError: this._lastCompressionError || undefined,
      lastCompressionTrigger: this._lastCompressionTrigger,
      contextLength: this.opts.contextLength,
      lastStopReason: this._lastStopReason,
      autoContinueCount: this._autoContinueCount || undefined,
      pendingGate: this._pendingGate,
      providerState: this._providerTurnSession.exportState?.(),
      dirtyMapFiles: this._dirtyMapFiles.size > 0 ? [...this._dirtyMapFiles] : undefined,
      noteEnforcementCount: this._noteEnforcementCount || undefined,
    };
    if (includeFullHistory) state.fullHistory = stripImagesForPersistence(this._fullHistory);
    return state;
  }

  restoreState(state: SessionRestoreState): void {
    if (state.sessionId) this.sessionId = state.sessionId;
    this.messages = [...state.messages as AgentMessage[]];
    this._fullHistory = [...(state.fullHistory ?? state.messages) as AgentMessage[]];
    this._compressedSummary = state.compressedSummary ?? "";
    this._compressionCount = state.compressionCount ?? 0;
    this._lastInputTokens = state.lastInputTokens ?? 0;
    this._lastCompressedAt = state.lastCompressedAt;
    this._lastCompressedMessageCount = state.lastCompressedMessageCount;
    // A mid-session correction (see isContextOverflowErrorMessage's caller) narrows this below
    // the catalog-reported value when a provider's real enforced limit turns out to be smaller.
    // Without restoring it here, that correction was silently discarded on the next checkpoint
    // resume even though exportState already persists it.
    if (state.contextLength) this.opts.contextLength = state.contextLength;
    this._lastCompressionError = state.lastCompressionError ?? "";
    this._lastCompressionTrigger = state.lastCompressionTrigger;
    this._lastStopReason = state.lastStopReason;
    this._autoContinueCount = state.autoContinueCount ?? 0;
    this._pendingGate = state.pendingGate;
    this._dirtyMapFiles = new Set(state.dirtyMapFiles ?? []);
    this._noteEnforcementCount = state.noteEnforcementCount ?? 0;
    this._isCompacting = false;
    this._providerTurnSession.importState?.(state.providerState);
  }

  /** Feeds the note-enforcement tracker from any tool
      result — a direct call in the sequential dispatch loop, or a subagent lane's relayed
      tool_call_result (a subagent's edits are still this session's responsibility to leave
      a note for). Keyed on the public tool name (tc.name), not the internal runtime type,
      since that's the shape both call sites already have on hand. Best-effort path matching
      (see normalizeStoredPath — shared with GraphAnnotationStore so a path recorded here and
      a path recorded in a note always agree) — this only ever nudges via forced
      continuations, capped and fail-open, so an occasional missed match degrades to "no
      reminder" rather than a stuck session. */
  private _trackToolResultForNotes(toolName: string, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const r = result as Record<string, unknown>;
    if (r.ok !== true) return;

    if (toolName === "file_edit" || toolName === "file_write" || toolName === "code_insert" || toolName === "code_replace" || toolName === "json_edit") {
      if (typeof r.path === "string") this._dirtyMapFiles.add(normalizeStoredPath(r.path));
      return;
    }
    if (toolName === "file_edit_batch" || toolName === "code_replace_batch") {
      const edits = Array.isArray(r.results) ? r.results as Array<Record<string, unknown>> : [];
      for (const edit of edits) {
        if (typeof edit.path === "string") this._dirtyMapFiles.add(normalizeStoredPath(edit.path));
      }
      return;
    }
    if (toolName === "map_note_add" || toolName === "map_note_update" || toolName === "map_link") {
      const note = r.note as { from?: unknown; to?: unknown } | undefined;
      if (note && typeof note === "object") {
        if (typeof note.from === "string") this._dirtyMapFiles.delete(normalizeStoredPath(note.from));
        if (typeof note.to === "string") this._dirtyMapFiles.delete(normalizeStoredPath(note.to));
      }
      if (this._dirtyMapFiles.size === 0) this._noteEnforcementCount = 0;
    }
  }

  /**
   * When a subagent_spawn call links to a plan step (planId/phaseId/stepId all set), mark that
   * step in_progress the moment the lane actually starts — the observable, unambiguous fact of
   * "this step's work has been delegated," recorded automatically so the orchestrating agent
   * doesn't have to remember a separate plan_update call just to say a lane is running. A linked
   * lane must honor the plan's execution gate: if the status update is explicitly rejected (for
   * example because execution is still awaiting approval), the lane must not start and thereby
   * bypass the guard. Transport/storage failures remain best-effort so a bookkeeping outage never
   * blocks valid delegated work.
   */
  private async _syncSubagentStepStart(input: SubagentSpawnInput): Promise<{ canStart: boolean; error?: string }> {
    if (!this.opts.planningProvider || !input.planId || !input.phaseId || !input.stepId) return { canStart: true };
    try {
      const result = await this.opts.planningProvider.dispatch("update", {
        planId: input.planId,
        phaseId: input.phaseId,
        stepId: input.stepId,
        stepStatus: "in_progress",
        stepNote: `Delegated to a subagent lane${input.label ? ` ("${input.label}")` : ""}.`,
      }, { sessionId: this.sessionId, requestId: undefined });
      if (result.ok === false) {
        return { canStart: false, error: typeof result.error === "string" ? result.error : "The linked plan step could not be started." };
      }
    } catch {
      // Best-effort bookkeeping only: an unavailable store is not execution approval denial.
    }
    return { canStart: true };
  }

  /**
   * Counterpart to _syncSubagentStepStart, called once the lane finishes. A failed lane is
   * unambiguously "blocked" and safe to mark automatically; a successful one only gets a note
   * with the lane's answer — actually marking the step completed is left to the orchestrating
   * agent's own plan_update call, once it has reviewed the answer against the step's acceptance
   * criteria (the same discipline plan_update already asks for around maxIterations steps).
   */
  private async _syncSubagentStepEnd(
    input: SubagentSpawnInput, finalResult: { ok: false; error: string } | SubagentSpawnToolResult,
  ): Promise<void> {
    if (!this.opts.planningProvider || !input.planId || !input.phaseId || !input.stepId) return;
    try {
      if (finalResult.ok === true) {
        await this.opts.planningProvider.dispatch("update", {
          planId: input.planId,
          phaseId: input.phaseId,
          stepId: input.stepId,
          stepNote: `Subagent lane finished: ${String(finalResult.answer ?? "").slice(0, 400)}`,
        }, { sessionId: this.sessionId, requestId: undefined });
      } else {
        await this.opts.planningProvider.dispatch("update", {
          planId: input.planId,
          phaseId: input.phaseId,
          stepId: input.stepId,
          stepStatus: "blocked",
          stepNote: `Subagent lane failed: ${String(finalResult.error ?? "unknown error").slice(0, 400)}`,
        }, { sessionId: this.sessionId, requestId: undefined });
      }
    } catch { /* best-effort bookkeeping only */ }
  }

  /**
   * Records an entire completed tool round. Unlike the former edit-only counter, this treats
   * research, diagnosis, planning, and a no-code final answer as normal work. It intervenes
   * only after the model repeats the *same* requests and receives the *same* output, which
   * cannot advance the task without a different decision.
   */
  private _observeToolRound(toolCalls: ToolUseBlock[], results: ToolResultBlock[]): { rounds: number; tools: string } | null {
    const fingerprint = stableJson(toolCalls.map((tc, index) => ({
      name: tc.name,
      input: tc.input,
      result: results[index]?.content ?? "",
    })));
    if (fingerprint === this._lastToolRoundFingerprint) {
      this._duplicateToolRoundCount += 1;
    } else {
      this._lastToolRoundFingerprint = fingerprint;
      this._duplicateToolRoundCount = 1;
    }
    if (this._duplicateToolRoundCount < DUPLICATE_TOOL_ROUND_THRESHOLD
      || this._duplicateToolRoundNudgeCount >= MAX_DUPLICATE_TOOL_ROUND_NUDGES) return null;

    this._duplicateToolRoundNudgeCount += 1;
    const tools = [...new Set(toolCalls.map((tc) => tc.name))].join(", ");
    const rounds = this._duplicateToolRoundCount;
    // Start a fresh observation window after issuing a reminder; otherwise the same loop
    // would inject a prompt on every later iteration rather than at a bounded cadence.
    this._duplicateToolRoundCount = 0;
    return { rounds, tools };
  }

  private _appendUserText(text: string, images?: ImageBlock[]): void {
    // Images ride in the same user turn as sibling blocks (a separate message would create
    // consecutive same-role turns, which providers reject) — mirroring _appendToolResults.
    const content: string | ContentBlock[] = images?.length
      ? [{ type: "text", text }, ...images]
      : text;
    this.messages.push({ role: "user", content });
    this._fullHistory.push({ role: "user", content });
  }

  private _appendAssistantTurn(result: ProviderTurnResult): void {
    const assistantBlocks: ContentBlock[] = [];
    // Compaction always leads, ahead of thinking — the one confirmed example orders it first,
    // and it represents an earlier "iteration" (a separate summarization pass the API ran
    // before generating the rest of the turn), so it belongs before whatever came out of that
    // later generation.
    if (result.compactionBlock) assistantBlocks.push(result.compactionBlock);
    for (const thinking of result.thinkingBlocks) assistantBlocks.push(thinking);
    if (result.text) assistantBlocks.push({ type: "text", text: result.text });
    for (const toolCall of result.toolCalls) assistantBlocks.push(toolCall);
    // An empty turn (the model returned nothing at all) must still occupy a slot in the
    // transcript: the empty-post-tool recovery below answers it with a continuation *user*
    // message, and dropping the assistant turn would leave two consecutive user messages —
    // which Bedrock and Anthropic both reject outright. But an assistant message with no
    // content is equally invalid on those APIs, and it is never removed, so a single empty
    // response used to poison every subsequent request in the session. Stand a placeholder in
    // its place: alternation is preserved and the wire stays valid.
    this.messages.push({ role: "assistant", content: nonEmptyAssistantContent(assistantBlocks) });
    this._fullHistory.push({ role: "assistant", content: nonEmptyAssistantContent(assistantBlocks) });
  }

  private _appendToolResults(results: ToolResultBlock[], images?: ImageBlock[]): void {
    const content: ContentBlock[] = images?.length ? [...results, ...images] : results;
    this.messages.push({ role: "user", content });
    this._fullHistory.push({ role: "user", content });
  }

  private _recordUsage(event: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }): void {
    this._lastInputTokens = event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens;
  }

  private _createBuiltinProviderTurnSession(): ProviderTurnSession {
    return {
      appendUserText: (text, images) => this._appendUserText(text, images),
      appendToolResults: (results, images) => this._appendToolResults(results, images),
      runTurn: (sink: ProviderTurnSink): Promise<ProviderTurnResult> => this._runProviderTurnWithRetry(sink),
    };
  }

  /**
   * Run one provider turn, retrying a transient failure that struck *after* streaming began.
   *
   * `_fetchWithRetry` only covers the pre-stream phase (connect + response status), because a
   * retry there cannot duplicate output — nothing has been emitted yet. But every provider also
   * reports failures *inside* a 200 stream (see {@link ProviderStreamError}), and those were
   * thrown straight to the turn's terminal error handler with no retry at all. On Bedrock that
   * was close to fatal: AWS delivers throttles as in-band exception frames, so the single most
   * common transient failure on that provider bypassed the entire retry layer.
   *
   * Retrying mid-stream is safe here only because the turn is not committed until this method
   * returns: the accumulators below are re-initialised per attempt, and a `turn_reset` tells the
   * UI to drop the partial bubble. The re-issued request is byte-identical (it is rebuilt from
   * `this.messages`, which the loop has not touched), so the model simply generates again.
   */
  private async _runProviderTurnWithRetry(sink: ProviderTurnSink): Promise<ProviderTurnResult> {
    const policy = this.opts.retryPolicy ?? DEFAULT_RETRY_POLICY;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      // Re-initialised per attempt: a retry must not splice its output onto the partial
      // generation that failed.
      const thinkingBlocks: ReasoningBlock[] = [];
      const toolCalls: ToolUseBlock[] = [];
      let text = "";
      let stopReason: AgentStopReason | undefined;
      let compactionBlock: CompactionBlock | undefined;
      let usage:
        | {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        }
        | undefined;

      const stream = this.provider === "anthropic"
        ? this._streamTurnAnthropic()
        : this.provider === "bedrock"
        ? (this.opts.bedrockApi === "mantle" ? this._streamTurnBedrockMantle() : this._streamTurnBedrock())
        : (this.provider === "openai" && this.opts.useResponsesApi && isOpenAIReasoningModel(this.opts.model))
        ? this._streamTurnOpenAIResponses()
        : this._streamTurnOpenAI();

      try {
        for await (const event of stream) {
          sink.emit(event);
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "thinking_block") {
            thinkingBlocks.push({
              type: "thinking",
              thinking: event.text,
              ...(event.signature ? { signature: event.signature } : {}),
              ...(event.encryptedContent ? { encryptedContent: event.encryptedContent } : {}),
              ...(event.reasoningItemId ? { reasoningItemId: event.reasoningItemId } : {}),
            });
          } else if (event.type === "redacted_thinking_block") {
            thinkingBlocks.push({ type: "redacted_thinking", data: event.data });
          } else if (event.type === "tool_use_block") {
            toolCalls.push(event.block);
          } else if (event.type === "compaction_block") {
            compactionBlock = { type: "compaction", content: event.content };
          } else if (event.type === "stop_reason") {
            stopReason = event.reason;
          } else if (event.type === "usage_update") {
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
            };
          }
        }
      } catch (err) {
        const isLast = attempt >= policy.maxAttempts - 1;
        if (this._signal?.aborted || isLast || !isRetryableError(err)) throw err;

        // Release the provider stream before re-issuing — without this the abandoned generator
        // holds its socket open for the whole backoff, and a Bedrock retry storm would leak one
        // connection per attempt.
        await stream.return(undefined).catch(() => { /* generator may already be done */ });

        const reason = err instanceof Error ? err.message : String(err);
        const delayMs = computeBackoffMs(attempt, policy, null);
        sink.emit({ type: "turn_reset", reason });
        sink.emit({
          type: "notice",
          level: "warn",
          message: `${this.provider} stream failed mid-response (${reason}) — discarding the partial answer and retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
        });
        await interruptibleSleep(delayMs, this._signal);
        continue;
      }

      let normalizedStopReason = stopReason ?? "protocol_violation";
      if (toolCalls.length > 0 && normalizedStopReason !== "tool_use") {
        normalizedStopReason = "protocol_violation";
      } else if (toolCalls.length === 0 && normalizedStopReason === "tool_use") {
        normalizedStopReason = "protocol_violation";
      }
      return {
        text,
        thinkingBlocks,
        toolCalls,
        stopReason: normalizedStopReason,
        usage,
        empty: text.trim().length === 0 && thinkingBlocks.length === 0 && toolCalls.length === 0 && !compactionBlock,
        compactionBlock,
      };
    }

    // Unreachable: the loop either returns a result or throws on the final attempt.
    throw new Error(`${this.provider}: provider turn failed after ${policy.maxAttempts} attempts`);
  }

  private _keepRecentCount(): number {
    return this.opts.compressionKeepRecent ?? 20;
  }

  /**
   * Context window used for compaction and emergency-shedding math: the model's real
   * window when known, otherwise a conservative assumed default (see
   * {@link ASSUMED_CONTEXT_LENGTH}). Gating compaction on this rather than on the raw,
   * frequently-undefined `opts.contextLength` is what keeps the safety nets alive for
   * unrecognized models. The UI meter still reads the real value, so an assumed window
   * is never presented to the user as fact.
   */
  private _effectiveContextLength(): number {
    return this.opts.contextLength && this.opts.contextLength > 0
      ? this.opts.contextLength
      : ASSUMED_CONTEXT_LENGTH;
  }

  /** Returns the output token budget for the current call, respecting any active escalation
   *  override. "Unlimited" mode ignores the configured maxTokens and starts from a generous
   *  budget instead — see MAX_ESCALATED_OUTPUT_TOKENS_UNLIMITED. */
  private _effectiveMaxTokens(): number {
    const base = this.opts.maxTokensUnlimited ? MAX_ESCALATED_OUTPUT_TOKENS : (this.opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    return this._clampToOutputCeiling(this._maxTokensOverride ?? base);
  }

  /** Clamp an output-token budget to what the provider/model will accept (or pass through if unknown). */
  private _clampToOutputCeiling(requested: number): number {
    const ceiling = resolveOutputCeiling(this.opts.model, this.provider);
    return ceiling != null ? Math.min(requested, ceiling) : requested;
  }

  /**
   * Resolve `max_tokens` together with the extended-thinking budget, for every Anthropic-family
   * path (direct, Bedrock Converse, Bedrock Mantle) and OpenRouter's unified `reasoning` param.
   *
   * These APIs require `budget_tokens < max_tokens`, so a budget larger than the configured
   * output limit has to raise `max_tokens`. Each path used to do that inline, *after*
   * `_effectiveMaxTokens()` had already clamped to the provider ceiling — so the bump walked the
   * request straight back over it. The thinking slider tops out at exactly 64000, which is also
   * Bedrock Claude's hard limit, so a maxed-out budget produced max_tokens = 65024 and a fatal
   * `exceeds the model limit of 64000` on every single request.
   *
   * Order matters: bump first, then clamp, and when the clamp bites, pull the *budget* down to
   * keep it strictly below max_tokens — otherwise clamping alone would violate the constraint
   * the bump existed to satisfy.
   */
  private _planThinking(): ThinkingPlan {
    return planThinking({
      model: this.opts.model,
      provider: this.provider,
      configuredMaxTokens: this._effectiveMaxTokens(),
      ceiling: resolveOutputCeiling(this.opts.model, this.provider),
      thinkingEnabled: this.opts.thinking?.enabled ?? false,
      budgetTokens: this.opts.thinking?.budgetTokens ?? 10_000,
      effort: this.opts.thinking?.effort,
      temperature: this.opts.temperature,
    });
  }

  /** How high a truncation-recovery retry may escalate the output budget — see
   *  MAX_ESCALATED_OUTPUT_TOKENS_UNLIMITED for why "unlimited" still has a real ceiling. */
  private _maxEscalationCeiling(): number {
    return this.opts.maxTokensUnlimited ? MAX_ESCALATED_OUTPUT_TOKENS_UNLIMITED : MAX_ESCALATED_OUTPUT_TOKENS;
  }

  private _compressibleMessageCount(): number {
    const keepRecent = this._keepRecentCount();
    if (this.messages.length <= keepRecent + 4) return 0;
    return this.messages.length - keepRecent;
  }

  private _buildRuntimeState(): SessionRuntimeState {
    const contextLength = this.opts.contextLength;
    const usagePct = contextLength && this._lastInputTokens > 0
      ? Math.min(this._lastInputTokens / contextLength * 100, 100)
      : null;
    const activeMessageCount = this.messages.length;
    const fullMessageCount = this._fullHistory.length;
    return {
      sessionId: this.sessionId,
      contextLength,
      lastInputTokens: this._lastInputTokens,
      usagePct,
      compressionEnabled: !!this.opts.compressionProvider,
      isCompacting: this._isCompacting,
      compressionCount: this._compressionCount,
      hasCompressedHistory: !!this._compressedSummary,
      lastCompressedAt: this._lastCompressedAt,
      lastCompressedMessageCount: this._lastCompressedMessageCount,
      lastCompressionError: this._lastCompressionError || undefined,
      lastCompressionTrigger: this._lastCompressionTrigger,
      keepRecent: this._keepRecentCount(),
      activeMessageCount,
      fullMessageCount,
      compressedMessageCount: Math.max(fullMessageCount - activeMessageCount, 0),
      compressibleMessageCount: this._compressibleMessageCount(),
      lastStopReason: this._lastStopReason,
      autoContinueCount: this._autoContinueCount,
      pendingGate: this._pendingGate,
    };
  }

  async manualCompact(compressionProvider: CompressionProvider): Promise<{ ok: boolean; message: string }> {
    // Route through the same overlap guard the loop uses: if a background pass is already
    // running, await it rather than starting a second concurrent pass (two passes would each
    // slice the prefix and corrupt the message window). Only reject for "nothing to compact"
    // when no pass is in flight.
    if (!this._compactionInFlight && this._compressibleMessageCount() <= 0) {
      return { ok: false, message: `Not enough history to compact yet (${this.messages.length} messages).` };
    }
    const outcome = await this._beginBackgroundCompaction(compressionProvider, "manual");
    this._takePendingCompactionNotices(); // consume queued notices; manualCompact reports inline
    if (outcome === "skipped") {
      return { ok: false, message: "Nothing safe to compact right now — the recent tool calls and their results are too interleaved to cut cleanly." };
    }
    if (outcome === "failed") {
      return {
        ok: false,
        message: this._lastCompressionError
          ? `Compression failed: ${this._lastCompressionError}`
          : "Compression failed.",
      };
    }
    return {
      ok: true,
      message: `Compression ×${this._compressionCount} applied. ${this.messages.length} recent messages kept.`,
    };
  }

  /**
   * Whether browser tools should be advertised this turn. We require a runner, that the runner
   * reports itself available (playwright-core actually installed), and that no earlier browser
   * call this session already reported the runtime missing. Gating advertisement — rather than
   * letting every call fail — stops the agent burning turns on a guaranteed-unavailable tool.
   */
  private _browserToolsUsable(): boolean {
    const runner = this.opts.browserRunner;
    if (!runner || this._browserUnavailable) return false;
    return runner.available ? runner.available() : true;
  }

  /** Detects the "playwright-core not installed" sentinel from a browser dispatch result. */
  private _isBrowserUnavailableResult(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    return r["ok"] === false && typeof r["error"] === "string" && /playwright-core/i.test(r["error"]);
  }

  /**
   * Service tools filtered to the provider families whose credentials are configured
   * (github/gitlab/jira/confluence/salesforce), so the catalog reflects real capability
   * instead of advertising integrations that would only fail at dispatch. An undefined
   * configuredServices set means "no credential info supplied" ⇒ advertise all (back-compat).
   */
  private _advertisedServiceTools(): ToolDefinition[] {
    return filterConfiguredServiceTools(this.opts.configuredServices);
  }

  private _getTools(): ToolDefinition[] {
    // Ordered by how often the agent reaches for each family — highest-frequency first, so
    // the most-used tools sit early in the catalog the model scans and rarely-used
    // integrations sit last. Conditional families appear only when their provider is wired.
    const all: ToolDefinition[] = [...WORKSPACE_TOOLS];
    if (this.opts.lspProvider) all.push(...CODE_INTEL_TOOLS);
    if (this.opts.diagnosticsProvider) all.push(...DIAGNOSTICS_TOOLS);
    all.push(...TEST_TOOLS, ...GIT_TOOLS);
    if (this.opts.planningProvider) all.push(...PLANNING_TOOLS);
    if (this.opts.memoryProvider) all.push(...MEMORY_TOOLS);
    if (this.opts.agentMemoryIndex) all.push(...AGENT_MEMORY_TOOLS);
    if (this.opts.graphProvider) all.push(...GRAPH_TOOLS);
    if (this.opts.subagentProvider) all.push(...SUBAGENT_TOOLS);
    all.push(...RESULT_PAGING_TOOLS);
    if (this.opts.transcriptProvider || this._compressedSummary) all.push(...TRANSCRIPT_TOOLS);
    if (this.opts.transcriptDocumentProvider) all.push(...TRANSCRIPT_DOCUMENT_TOOLS);
    all.push(...WORKTREE_TOOLS);
    if (this.opts.referenceProvider) all.push(...REFERENCE_TOOLS);
    if (this.opts.dataProvider) all.push(...DATA_TOOLS);
    if (this._browserToolsUsable()) all.push(...BROWSER_TOOLS);
    // Integrations last, and only the configured ones.
    all.push(...this._advertisedServiceTools());
    // editor-backed edit tools only work with an editProvider — drop them otherwise.
    const EDITOR_BACKED_TOOLS = new Set(["file_edit", "file_edit_batch", "json_edit"]);
    const usable = this.opts.editProvider ? all : all.filter((t) => !EDITOR_BACKED_TOOLS.has(t.name));
    const filtered = this._disabledTools.size ? usable.filter((t) => !this._disabledTools.has(t.name)) : usable;
    // UI_TOOLS are always included and not user-toggleable
    return [...filtered, ...UI_TOOLS];
  }

  private _handleTranscriptRead(payload: Record<string, unknown>): unknown {
    const query = payload["query"] ? String(payload["query"]).trim() : null;
    const summarySection = this._compressedSummary
      ? `## Compressed History Summary\n${this._compressedSummary}\n\n`
      : "";

    const rangeInput = payload["messageRange"] as { from?: unknown; to?: unknown } | undefined;
    if (rangeInput || query) {
      const fullHistory = this.opts.transcriptProvider?.getFullHistory() ?? [];
      if (query && !rangeInput) {
        const lq = query.toLowerCase();
        const matches: string[] = [];
        fullHistory.forEach((m, i) => {
          const text = typeof m.content === "string" ? m.content :
            (Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string; thinking?: string }>)
                  .filter((b) => b.type === "text" || b.type === "thinking")
                  .map((b) => b.text ?? b.thinking ?? "")
                  .join(" ")
              : "");
          if (text.toLowerCase().includes(lq)) {
            const idx = text.toLowerCase().indexOf(lq);
            const start = Math.max(0, idx - 100);
            const end = Math.min(text.length, idx + 200);
            matches.push(`[msg ${i}] ${m.role.toUpperCase()}: …${text.slice(start, end).trim()}…`);
          }
        });
        const searchResult = matches.length
          ? matches.slice(0, 20).join("\n\n")
          : "No matches found.";
        return { ok: true, result: `${summarySection}## Search: "${query}"\n${searchResult}` };
      }
      if (rangeInput) {
        const from = Math.max(0, Math.floor(Number(rangeInput.from ?? 0)));
        const to = Math.min(fullHistory.length, Math.ceil(Number(rangeInput.to ?? fullHistory.length)));
        const msgs = fullHistory.slice(from, to).map((m, i) => {
          const text = typeof m.content === "string" ? m.content :
            (Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string }>)
                  .filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
              : "");
          return `[${from + i}] ${m.role.toUpperCase()}: ${text.slice(0, 600)}${text.length > 600 ? "…" : ""}`;
        });
        return { ok: true, result: `${summarySection}## Messages ${from}–${to - 1}\n${msgs.join("\n\n")}` };
      }
    }

    if (!summarySection) {
      return { ok: true, result: "No compressed history. All conversation history is within the active context window." };
    }
    return { ok: true, result: summarySection };
  }

  /**
   * Caps a JSON-stringified tool result before it becomes the model-facing tool_result
   * content. Results within the ceiling pass through untouched. An oversized result is
   * cut at a line boundary with a notice telling the model the toolCallId (its own
   * tool_use id — no new id scheme needed) and offset to resume from, and the original
   * is kept in `_resultOverflow` so `tool_output_page` can serve the rest on request.
   * Snaps on JSON_ESCAPED_NEWLINE (not a literal "\n") because `stringified` is
   * JSON.stringify output, where a real newline is always the two-character sequence.
   */
  /**
   * Pulls a base64 data-URL field out of a tool result and turns it into a real
   * vision content block (or a text description, via the fallback model, when the
   * active model can't see images) — then returns a copy of the result with that
   * field removed. Without this, an image field just gets JSON.stringify'd into the
   * model-facing tool_result text: unreadable as a picture, and expensive (base64
   * tokenizes far worse than the ~1-2k tokens a real vision block costs), and
   * usually eaten entirely by the 20k-char result cap before the model sees anything
   * useful. Used for reference_zoom_image and browser_screenshot alike.
   */
  private async _extractImageForModel(
    result: Record<string, unknown>,
    field: string,
    pendingImages: ImageBlock[],
    describeInstruction: string,
  ): Promise<Record<string, unknown>> {
    const dataUrl = result[field];
    const parsed = typeof dataUrl === "string" ? parseDataUrl(dataUrl) : null;
    if (!parsed) return result;
    const rest = { ...result };
    delete rest[field];

    if (this.opts.supportsVision) {
      pendingImages.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
      return { ...rest, imageAttached: true };
    }
    if (this.opts.visionFallbackProvider) {
      try {
        const description = await Promise.race([
          this.opts.visionFallbackProvider.describeImage(parsed.mediaType, parsed.data, describeInstruction),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Vision fallback timed out after 30s")), 30_000)),
        ]);
        return { ...rest, description, _visionNote: "Described via the configured vision fallback model — the active model has no vision support." };
      } catch (err) {
        return { ...rest, _visionFallbackError: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ...rest, _visionNote: "Image captured, but the active model has no vision support and no vision fallback is configured — only metadata is available." };
  }

  /** Same as _extractImageForModel, but for browser_run_script's `steps` array —
      each screenshot step's dataUrl is extracted in order so the resulting images
      stay positionally correlated with their step in the returned step list. */
  private async _extractRunScriptImages(
    result: Record<string, unknown>,
    pendingImages: ImageBlock[],
  ): Promise<Record<string, unknown>> {
    const steps = Array.isArray(result["steps"]) ? result["steps"] as Record<string, unknown>[] : null;
    if (!steps) return result;
    const describeInstruction = "Describe this browser screenshot in detail — visible text, layout, UI elements, colors, and anything relevant to verifying the page rendered correctly.";
    const mapped: Record<string, unknown>[] = [];
    for (const step of steps) {
      mapped.push(step["action"] === "screenshot"
        ? await this._extractImageForModel(step, "dataUrl", pendingImages, describeInstruction)
        : step);
    }
    return { ...result, steps: mapped };
  }

  /**
   * Per-tool gate applied just before dispatch: rejects a call to a disabled tool, or one
   * whose arguments fail schema validation (missing required field, wrong type, bad enum).
   * Returns null when the call is clear to dispatch. Answering the one bad call with an
   * error — rather than discarding the whole assistant turn — lets the sibling valid calls
   * run and lets the model correct course next turn. Unknown *tool names* are not caught
   * here (validateToolInput has no schema for them); those are handled at dispatch by
   * {@link runtimeResultOrError}.
   *
   * The disabled-tool check is defense-in-depth beyond `_getTools()` filtering the tool out
   * of what's advertised: a call to a just-disabled tool can still reach here from a
   * hallucination, from a model that doesn't strictly honour the tool list, or from history
   * the model still remembers after the toggle flipped mid-conversation (see
   * {@link updateDisabledTools}) — advertisement-only filtering does not stop execution.
   */
  private _toolValidationError(tc: ToolUseBlock): { ok: false; error: string } | null {
    if (this._disabledTools.has(tc.name) && !UI_TOOL_NAMES.has(tc.name)) {
      return { ok: false, error: `The "${tc.name}" tool is disabled in this session's settings and cannot be used. Continue without it.` };
    }
    const issues = validateToolInput(tc.name, tc.input);
    if (issues.length === 0) return null;
    const detail = issues.map((i) => i.message).join(" ");
    return { ok: false, error: `Invalid arguments for ${tc.name}: ${detail} Correct the arguments and call the tool again.` };
  }

  private _capToolResult(toolCallId: string, stringified: string): string {
    const capped = capToolResult(stringified, toolCallId, DEFAULT_PAGE_CHAR_LIMIT, JSON_ESCAPED_NEWLINE);
    if (capped.overflowed) {
      if (this._resultOverflow.size >= RESULT_OVERFLOW_MAX_ENTRIES) {
        const oldest = this._resultOverflow.keys().next().value;
        if (oldest !== undefined) this._resultOverflow.delete(oldest);
      }
      this._resultOverflow.set(toolCallId, stringified);
    }
    return capped.content;
  }

  /** Shared lookup for both tool_output_page and tool_output_search: resolves a toolCallId to its stored full text, or a uniform not-found error. */
  private _lookupOverflow(toolCallId: string): { ok: true; fullText: string } | { ok: false; error: string } {
    const fullText = this._resultOverflow.get(toolCallId);
    if (fullText === undefined) {
      return {
        ok: false,
        error: `No stored output found for toolCallId "${toolCallId}". It may never have been truncated, `
          + `may already have been fully read, or may have been evicted — only the ${RESULT_OVERFLOW_MAX_ENTRIES} `
          + "most recently truncated results are kept.",
      };
    }
    return { ok: true, fullText };
  }

  /** Handles the tool_output_page tool: serves a requested slice of a previously truncated result. */
  private _handleToolResultPage(payload: Record<string, unknown>): unknown {
    const toolCallId = String(payload["toolCallId"] ?? "").trim();
    if (!toolCallId) return { ok: false, error: "toolCallId is required." };

    const lookup = this._lookupOverflow(toolCallId);
    if (!lookup.ok) return lookup;

    const offset = Math.max(0, Math.floor(Number(payload["offset"] ?? 0)) || 0);
    const limitRaw = Number(payload["limit"]);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_PAGE_CHAR_LIMIT;
    const page = pageResult(lookup.fullText, offset, limit, JSON_ESCAPED_NEWLINE);
    return {
      ok: true,
      toolCallId,
      offset: page.offset,
      totalLength: page.totalLength,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      content: page.content,
    };
  }

  /** Handles the tool_output_search tool: finds matching lines with context inside a previously truncated result. */
  private _handleToolResultSearch(payload: Record<string, unknown>): unknown {
    const toolCallId = String(payload["toolCallId"] ?? "").trim();
    if (!toolCallId) return { ok: false, error: "toolCallId is required." };
    const pattern = String(payload["pattern"] ?? "");
    if (!pattern) return { ok: false, error: "pattern is required." };

    const lookup = this._lookupOverflow(toolCallId);
    if (!lookup.ok) return lookup;

    const contextLines = Number(payload["contextLines"]);
    const maxMatches = Number(payload["maxMatches"]);
    const search = searchResult(lookup.fullText, pattern, {
      contextLines: Number.isFinite(contextLines) ? contextLines : undefined,
      maxMatches: Number.isFinite(maxMatches) ? maxMatches : undefined,
      boundary: JSON_ESCAPED_NEWLINE,
    });
    return {
      ok: true,
      toolCallId,
      pattern,
      totalMatches: search.totalMatches,
      truncated: search.truncated,
      matches: search.matches,
    };
  }

  private async _compressHistory(
    compressionProvider: CompressionProvider,
    trigger: CompressionTrigger,
  ): Promise<CompactionOutcome> {
    const keepRecent = this._keepRecentCount();
    if (this.messages.length <= keepRecent + 4) return "skipped";

    // Never split an assistant tool_use from its tool_result, or the recent window opens with
    // an orphaned result and the next provider request 400s. Boundary may shift earlier.
    const recentStart = safeRecentStart(this.messages, keepRecent);
    if (recentStart <= 0) return "skipped";
    const toCompress = this.messages.slice(0, recentStart);
    try {
      // Compression is itself a provider call and can fail transiently (rate limit,
      // network blip). Retry with a short backoff before giving up — a single
      // transient failure used to leave the session at full context, compounding
      // toward a fatal over-length provider 400.
      const summary = await this._compressWithRetry(compressionProvider, toCompress);

      // Index the compressed chunk in the vector store for semantic retrieval.
      // The ref appears in the summary header so the agent can query it later.
      let chunkRef = "";
      if (this.opts.agentMemoryIndex) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chunkRef = await this.opts.agentMemoryIndex.indexTranscriptChunk(this.sessionId, toCompress as any, this._compressionCount, summary);
      }

      const passLabel = chunkRef
        ? `[Compression pass ${this._compressionCount + 1} — search ref:"${chunkRef}" via memory_search to retrieve full detail]`
        : `[Compression pass ${this._compressionCount + 1}]`;

      const newAccumulated = this._compressedSummary
        ? `${this._compressedSummary}\n\n---\n\n${passLabel}\n${summary}`
        : `${passLabel}\n${summary}`;

      // If the accumulated summary has grown past the cap, re-condense it into a
      // single replacement block so the uncached system-prompt content stays bounded
      // across many compression passes (the core "preserve the head" invariant).
      if (newAccumulated.length > MAX_SUMMARY_CHARS) {
        try {
          const recondenseMessages: AgentMessage[] = [{
            role: "user",
            content: `The following is an accumulated multi-pass summary of earlier conversation history that has grown large. Condense it into a single comprehensive summary that preserves all key decisions, facts, tool results, file changes, and context, while eliminating redundancy between passes.\n\n${newAccumulated}`,
          }];
          const recondensed = await this._compressWithRetry(compressionProvider, recondenseMessages, 1);
          this._compressedSummary = `[Recondensed after ${this._compressionCount + 1} passes]\n${recondensed}`;
        } catch {
          // Re-condensation failed — fall back to the naive concatenation so at least
          // the new pass's content is recorded. Next compression attempt will retry.
          this._compressedSummary = newAccumulated;
        }
      } else {
        this._compressedSummary = newAccumulated;
      }
      // Remove exactly the summarised prefix rather than replacing the whole array. When
      // compaction runs in the background, messages may have been appended while the
      // summariser ran; slicing off only the first `toCompress.length` preserves them.
      this.messages = this.messages.slice(toCompress.length);
      this._compressionCount++;
      this._lastCompressedAt = Date.now();
      this._lastCompressedMessageCount = toCompress.length;
      this._lastCompressionError = "";
      this._lastCompressionTrigger = trigger;
      // A single success — even after prior failures — fully re-closes the breaker. Only
      // consecutive, uninterrupted failures should ever trip it.
      this._consecutiveCompressionFailures = 0;
      this._compactionCircuitOpen = false;
      return "compressed";
    } catch (err) {
      this._lastCompressionError = err instanceof Error ? err.message : String(err);
      this._consecutiveCompressionFailures++;
      if (this._consecutiveCompressionFailures >= COMPACTION_CIRCUIT_BREAKER_THRESHOLD) {
        this._compactionCircuitOpen = true;
      }
      return "failed";
    }
  }

  /** Run the compression provider call with a bounded backoff retry. */
  private async _compressWithRetry(
    provider: CompressionProvider,
    toCompress: AgentMessage[],
    attempts = 2,
  ): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await provider.compress(toCompress);
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1 && !this._signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Start a compaction pass in the background (or return the one already running). The
   * summariser round-trip overlaps the rest of the turn instead of blocking it. The pass
   * summarises a stable snapshot of the compressible prefix and, on completion, removes
   * exactly that prefix (see _compressHistory), so messages appended while it ran are
   * preserved. Completion diagnostics are queued for the loop to surface, since a
   * background task cannot yield into the event stream itself.
   */
  private _beginBackgroundCompaction(provider: CompressionProvider, trigger: CompressionTrigger): Promise<CompactionOutcome> {
    if (this._compactionInFlight) return this._compactionInFlight;
    this._isCompacting = true;
    const pass = this._compressHistory(provider, trigger)
      .then((outcome) => {
        if (outcome === "compressed") {
          this._pendingCompactionNotices.push({ level: "info", message: `Compression ×${this._compressionCount} applied in the background — ${this.messages.length} recent messages kept.` });
        } else if (outcome === "failed") {
          // Once the circuit breaker trips, escalate from a routine warn (easy to miss across
          // dozens of turns) to an error-level note fired exactly once at the trip point — the
          // subsequent silence is the point, not a gap: further automatic attempts are skipped
          // (see the circuit-open checks at the trigger sites) rather than repeating this note.
          this._pendingCompactionNotices.push(
            this._compactionCircuitOpen
              ? {
                  level: "error",
                  message: `Background compression has failed ${this._consecutiveCompressionFailures} times in a row (${this._lastCompressionError}) — automatic compaction is disabled for the rest of this session. Context will be managed by shedding old tool output instead. Check the compression provider/model/API key in settings, or trigger a manual compaction to retry.`,
                }
              : { level: "warn", message: `Background compression failed: ${this._lastCompressionError} — session continues at full context.` },
          );
        }
        // "skipped": a legitimate no-op (not enough history yet, or the compressible prefix
        // can't be cut without splitting a tool_use from its result) — nothing to report,
        // and _lastCompressionError is deliberately left untouched (see CompactionOutcome).
        return outcome;
      })
      .catch((err) => {
        // _compressHistory swallows its own errors, but guard anyway so a background
        // rejection can never surface as an unhandled promise. Mirror its own failure-counting
        // so the circuit breaker's accounting can't drift out of sync with this backstop path.
        this._lastCompressionError = err instanceof Error ? err.message : String(err);
        this._consecutiveCompressionFailures++;
        if (this._consecutiveCompressionFailures >= COMPACTION_CIRCUIT_BREAKER_THRESHOLD) {
          this._compactionCircuitOpen = true;
        }
        return "failed" as const;
      })
      .finally(() => {
        this._isCompacting = false;
        this._compactionInFlight = undefined;
      });
    this._compactionInFlight = pass;
    return pass;
  }

  /**
   * Await a compaction pass on the critical path, but never let it stall the turn past
   * {@link BLOCKING_COMPACTION_DEADLINE_MS} regardless of the summariser's internal retries —
   * and never let it stall a cancellation either: if the run's abort signal fires while this
   * is waiting, the wait ends immediately just like a timeout (the background pass itself
   * keeps running; only the foreground wait gives up), so hitting Stop stays responsive even
   * mid-compaction. On early exit for either reason the caller falls through to whatever
   * relief the trigger site applies next (emergency shedding, or simply proceeding).
   */
  private _awaitCompactionBounded(provider: CompressionProvider): Promise<CompactionOutcome | "timed_out"> {
    const pass = this._beginBackgroundCompaction(provider, "auto");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const guard = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), BLOCKING_COMPACTION_DEADLINE_MS);
      if (this._signal) {
        if (this._signal.aborted) { resolve("timed_out"); return; }
        abortListener = () => resolve("timed_out");
        this._signal.addEventListener("abort", abortListener, { once: true });
      }
    });
    return Promise.race([pass, guard]).finally(() => {
      if (timer) clearTimeout(timer);
      if (abortListener) this._signal?.removeEventListener("abort", abortListener);
    });
  }

  /** Drain the queue of background-compaction completion diagnostics for the loop to yield. */
  private _takePendingCompactionNotices(): Array<{ level: "info" | "warn" | "error"; message: string }> {
    return this._pendingCompactionNotices.splice(0);
  }

  /**
   * Shared recovery for "the request is bigger than the model will accept" — used both by the
   * normalized context_window_exceeded stop reason (the provider returned a result, but it's
   * unusable) and by a hard rejection thrown before any response streamed (see
   * isContextOverflowErrorMessage in the outer catch below). Awaits compaction — skipped
   * outright when the circuit breaker is open, since a call already known to be doomed isn't
   * worth the bounded wait — and falls back to shedding the oldest large tool results in
   * place. Yields its own progress diagnostics; returns whether anything was freed.
   */
  private async *_recoverContextOverflow(): AsyncGenerator<AgentEvent, boolean> {
    let freedByCompaction = false;
    if (this.opts.compressionProvider && !this._compactionCircuitOpen) {
      const outcome = await this._awaitCompactionBounded(this.opts.compressionProvider);
      for (const note of this._takePendingCompactionNotices()) {
        yield { type: "execution_diagnostic", level: note.level, message: note.message };
      }
      freedByCompaction = outcome === "compressed";
    }
    if (freedByCompaction) return true;
    // No compression provider, it couldn't cut anything, or the circuit breaker is open —
    // shed the oldest large tool outputs in place. Without this a retry would replay the
    // same oversized prompt verbatim and immediately re-provoke the same overflow.
    const freed = this._emergencyTruncateOldestToolResults(Math.floor(this._effectiveContextLength() * 0.8));
    yield freed > 0
      ? { type: "execution_diagnostic", level: "warn", message: `Compaction could not free enough — shed ~${Math.round(freed / 1000)}k chars of old tool output to fit the context window.` }
      : { type: "execution_diagnostic", level: "error", message: "Context window exceeded and there is nothing left to compact or shed." };
    return freed > 0;
  }

  /**
   * Last-resort context relief when summarisation keeps failing: shrink the
   * oldest large tool-result payloads (file reads, command output) to a stub so
   * the conversation can't grow into a fatal over-length provider 400.
   *
   * Structure-preserving by construction — it keeps every message and every
   * tool_result block (only the `content` string shrinks), so a tool_use can
   * never be orphaned from its result. Replaces messages with fresh objects
   * rather than mutating in place so `_fullHistory` (checkpoints, replay,
   * memory index) keeps the originals.
   *
   * @returns characters freed from the active message window.
   */
  private _emergencyTruncateOldestToolResults(targetChars: number): number {
    if (targetChars <= 0) return 0;
    const boundary = safeRecentStart(this.messages, this._keepRecentCount());
    const MIN_PAYLOAD = 2000; // only worth stubbing sizeable results
    let freed = 0;
    for (let i = 0; i < boundary && freed < targetChars; i++) {
      const msg = this.messages[i];
      if (!msg || msg.role !== "user" || typeof msg.content === "string") continue;
      const blocks = msg.content as ContentBlock[];
      let changed = false;
      const nextBlocks = blocks.map((block) => {
        if (block.type !== "tool_result") return block;
        const len = block.content?.length ?? 0;
        if (len <= MIN_PAYLOAD || block.content.includes('"_elided"')) return block;
        const stub = JSON.stringify({
          _elided: `tool result (${len} chars) dropped to free context after compression failed — re-run the tool if you still need this output`,
        });
        freed += len - stub.length;
        changed = true;
        return { ...block, content: stub };
      });
      if (changed) this.messages[i] = { role: msg.role, content: nextBlocks };
    }
    return freed;
  }

  private async _enrichServicePayload(
    runtimeType: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.opts.serviceKeyProvider) return input;
    const service = runtimeType.split(".")[1] ?? "";
    const raw = await this.opts.serviceKeyProvider(service);
    if (!raw) return { ...input, _serviceError: `No API key configured for ${service}. Add it in Blacksite Settings.` };
    if (service === "jira" || service === "confluence") {
      const sep = raw.indexOf(":");
      if (sep > 0) {
        return { ...input, _email: raw.slice(0, sep), _token: raw.slice(sep + 1) };
      }
    }
    return { ...input, _token: raw };
  }

  private _handleMemory(op: string, payload: Record<string, unknown>): unknown {
    const provider = this.opts.memoryProvider;
    if (!provider) return { ok: false, error: "Memory is not available in this context." };
    if (op === "append") {
      const note = String(payload["note"] ?? "").trim();
      if (!note) return { ok: false, error: "note is required." };
      provider.append(note);
      // Also index the note in the semantic memory index when available
      if (this.opts.agentMemoryIndex) {
        void this.opts.agentMemoryIndex.indexMemory(note);
      }
      return { ok: true, saved: note.length > 80 ? `${note.slice(0, 80)}…` : note };
    }
    if (op === "read") {
      return { ok: true, memory: provider.readMemory(), context: provider.readContext() };
    }
    return { ok: false, error: `Unknown memory operation: ${op}` };
  }

  private async _handleMemorySemanticSearch(payload: Record<string, unknown>): Promise<unknown> {
    const idx = this.opts.agentMemoryIndex;
    if (!idx) return { ok: false, error: "Agent memory index is not enabled. Enable it in Settings → Agent Memory." };

    const query = String(payload["query"] ?? "").trim();
    if (!query) return { ok: false, error: "query is required." };

    const rawCols = Array.isArray(payload["collections"]) ? (payload["collections"] as string[]) : [];
    const collections = (rawCols.length > 0 ? rawCols : ["tool_calls", "transcript", "memories"]) as (
      "tool_calls" | "transcript" | "memories"
    )[];
    const topK = Math.min(20, Math.max(1, Number(payload["topK"] ?? 5)));

    const results = await idx.semanticSearch(query, collections, topK);
    if (!results.length) return { ok: true, results: [], message: "No matching entries found in the memory index." };

    return {
      ok: true,
      results: results.map((r) => ({
        collection: r.collection,
        content: r.content,
        ref: r.ref,
        relevance: Math.round(r.score * 100) / 100,
      })),
    };
  }

  /**
   * Persist a checkpoint. On the hot path (each iteration) we only serialize the
   * active compressed message window — O(keepRecent) rather than O(totalHistory).
   * The full uncompressed _fullHistory is written every FULL_HISTORY_CHECKPOINT_CADENCE
   * iterations and always on terminal states (force=true) so resume fidelity is kept.
   */
  private _saveCheckpoint(force = false): void {
    const now = Date.now();
    if (!this._checkpointCreatedAt) this._checkpointCreatedAt = now;
    this._checkpointCount++;
    const includeFullHistory = force
      || this._checkpointCount === 1
      || this._checkpointCount % FULL_HISTORY_CHECKPOINT_CADENCE === 0;
    const cp: Checkpoint = {
      sessionId: this.sessionId,
      iteration: this._iteration,
      model: this.opts.model,
      workspaceRoot: this.opts.workspaceRoot,
      messages: stripImagesForPersistence(this.messages),
      state: this.exportState(includeFullHistory),
      createdAt: this._checkpointCreatedAt,
      updatedAt: now,
    };
    saveCheckpoint(this.opts.context, cp);
  }

  async *send(userContent: string, sendOpts?: { images?: ImageBlock[] }): AsyncGenerator<AgentEvent> {
    // User-attached images become real vision blocks in the user turn when the model can see
    // them. A non-vision model gets the text only — the caller substitutes a text note and the
    // reference_* tools (with the vision fallback) remain the inspection path.
    const userImages = this.opts.supportsVision ? sendOpts?.images : undefined;
    this._providerTurnSession.appendUserText(userContent, userImages);
    this._lastStopReason = undefined;
    this._pendingGate = undefined;
    this._autoContinueCount = 0;
    yield { type: "runtime_state", state: this.runtimeState };
    if (!this.opts.contextLength && !this._contextLengthWarned) {
      this._contextLengthWarned = true;
      yield {
        type: "execution_diagnostic",
        level: "warn",
        message: `Context window metadata is unavailable for model "${this.opts.model}". The percentage meter may read unknown, but compaction and emergency shedding stay active against a conservative assumed ${ASSUMED_CONTEXT_LENGTH.toLocaleString()}-token window so the session can't grow unbounded into a context-overflow error.`,
      };
    }
    const maxIter = this.opts.maxIterations ?? DEFAULT_MAX_ITER;
    const turnStartIteration = this._iteration;
    let autoContinueCount = 0;
    let awaitingPostToolContinuation = false;
    this._lastToolRoundFingerprint = "";
    this._duplicateToolRoundCount = 0;
    this._duplicateToolRoundNudgeCount = 0;

    while (this._iteration - turnStartIteration < maxIter) {
      if (this._signal?.aborted) {
        this._lastStopReason = "cancelled";
        yield { type: "execution_diagnostic", level: "warn", message: "Run cancelled before the next iteration started." };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason: "cancelled", iterations: this._iteration - turnStartIteration };
        return;
      }

      this._iteration++;
      yield { type: "iteration_start", iteration: this._iteration };

      // A model turn is the decision boundary that needs fresh situational state.
      // Refresh again after every tool round, not only after a new user message, so
      // the agent never plans its next edit against pre-edit diagnostics or topology.
      await this._refreshWorkspaceContext();

      // Surface any diagnostics from a background compaction that finished since the last
      // iteration (a background task can't yield into the stream itself).
      for (const note of this._takePendingCompactionNotices()) {
        yield { type: "execution_diagnostic", level: note.level, message: note.message };
        yield { type: "runtime_state", state: this.runtimeState };
      }

      // Proactive compression before the send. Below the critical line there is slack, so
      // compaction runs in the background and its round-trip overlaps this turn rather than
      // stalling it; at or above the critical line we must free headroom before sending, so
      // we block (bounded) — awaiting a pass already running if there is one.
      if (this.opts.compressionProvider && this._lastInputTokens > 0) {
        const preTurnPct = this._lastInputTokens / this._effectiveContextLength() * 100;
        const threshold = this.opts.compressionTriggerPct ?? 60;
        const compressible = this._compressibleMessageCount();
        if (preTurnPct >= COMPACTION_CRITICAL_PCT && (this._compactionInFlight || compressible > 4)) {
          if (this._compactionCircuitOpen) {
            // Compaction is known-broken this session — don't waste the bounded wait on
            // another doomed call. Shed old tool output directly instead.
            const freed = this._emergencyTruncateOldestToolResults(Math.floor(this._effectiveContextLength() * 0.8));
            yield {
              type: "execution_diagnostic",
              level: "warn",
              message: freed > 0
                ? `Context at ${Math.round(preTurnPct)}% — automatic compaction is disabled after repeated failures; shed ~${Math.round(freed / 1000)}k chars of old tool output instead.`
                : `Context at ${Math.round(preTurnPct)}% and automatic compaction is disabled after repeated failures — nothing left to shed either.`,
            };
          } else {
            yield {
              type: "execution_diagnostic",
              level: "info",
              message: `Context at ${Math.round(preTurnPct)}% before model call — compacting to free headroom before sending…`,
            };
            yield { type: "runtime_state", state: this.runtimeState };
            await this._awaitCompactionBounded(this.opts.compressionProvider);
            for (const note of this._takePendingCompactionNotices()) {
              yield { type: "execution_diagnostic", level: note.level, message: note.message };
            }
          }
          yield { type: "runtime_state", state: this.runtimeState };
        } else if (preTurnPct >= threshold && compressible > 4 && !this._compactionInFlight && !this._compactionCircuitOpen) {
          yield {
            type: "execution_diagnostic",
            level: "info",
            message: `Context at ${Math.round(preTurnPct)}% — compacting ${compressible} older messages in the background…`,
          };
          void this._beginBackgroundCompaction(this.opts.compressionProvider, "auto");
          yield { type: "runtime_state", state: this.runtimeState };
        }
      }

      let turnResult: ProviderTurnResult;

      try {
        const streamEvents = new ProviderTurnEventQueue<ProviderTurnStreamEvent>();
        const turnPromise = this._providerTurnSession.runTurn({
          emit: (event) => streamEvents.push(event),
        }).then((result) => {
          streamEvents.close();
          return result;
        }).catch((err) => {
          streamEvents.fail(err);
          throw err;
        });
        // A provider failure reaches us through the queue: fail() rejects the pending waiter, so
        // the for-await below throws and the catch handles it — which means the error path never
        // reaches `await turnPromise`, leaving that rejection unobserved. Node reports an
        // unobserved rejection as an unhandledRejection, and the extension host has no handler
        // for it, so what should have been a reported turn error crashed the host instead. Mark
        // it handled here; the real error still surfaces via streamEvents.
        void turnPromise.catch(() => { /* surfaced through streamEvents.fail() */ });

        for await (const ev of streamEvents) {
          if (ev.type === "text_delta") {
            yield { type: "text_delta", text: ev.text };
          } else if (ev.type === "thinking_delta") {
            yield { type: "thinking_delta", text: ev.text };
          } else if (ev.type === "turn_reset") {
            // The partial answer the user has been watching belongs to a generation that died.
            // Tell the webview to drop it so the retry's output replaces it rather than being
            // appended to it.
            yield { type: "turn_reset", reason: ev.reason };
          } else if (ev.type === "notice") {
            // Out-of-band operational message from the provider layer (e.g. a retry
            // notice) — surface it as a diagnostic so the run stays observable.
            yield { type: "execution_diagnostic", level: ev.level, message: ev.message };
          } else if (ev.type === "tool_use_block") {
            yield {
              type: "tool_call_start",
              toolCallId: ev.block.id,
              toolName: ev.block.name,
              inputPreview: JSON.stringify(ev.block.input).slice(0, 120),
              input: ev.block.input,
            };
          } else if (ev.type === "usage_update") {
            this._recordUsage(ev);
            yield { type: "usage_update", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens, cacheWriteTokens: ev.cacheWriteTokens };
            yield { type: "runtime_state", state: this.runtimeState };
          }
        }
        turnResult = await turnPromise;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // The provider rejected the request outright — before any response streamed — because
        // it's bigger than it will accept (e.g. OpenRouter's "Prompt tokens limit exceeded: X
        // > Y", which can fire even when the model's *catalog* context length is much larger:
        // the catalog can report the max across several backing upstreams while this request
        // routed to one with a smaller real limit). This is the same failure the normalized
        // context_window_exceeded branch below recovers from — compact/shed, then retry — but
        // reaches here instead because it never got far enough to produce a turnResult at all.
        // Unlike that branch, nothing was appended to this.messages/_fullHistory for this
        // attempt (_appendAssistantTurn only runs after this catch block), so there's nothing
        // to pop before retrying.
        if (!this._signal?.aborted && isContextOverflowErrorMessage(message) && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
          autoContinueCount++;
          this._autoContinueCount = autoContinueCount;
          const observedLimit = extractContextOverflowLimit(message);
          if (observedLimit && (!this.opts.contextLength || observedLimit < this.opts.contextLength)) {
            // The catalog overpromised — correct downward for the rest of the session so the
            // proactive compaction trigger actually fires before this happens again.
            this.opts.contextLength = observedLimit;
          }
          yield {
            type: "execution_diagnostic",
            level: "warn",
            message: `Provider turn failed: ${message} — compacting history and retrying (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})…`,
          };
          const freed = yield* this._recoverContextOverflow();
          if (!freed) {
            this._lastStopReason = "context_window_exceeded";
            yield { type: "error", message: "Prompt exceeds the model's context window and cannot be reduced further. Start a new session, or choose a model with a larger context window." };
            yield { type: "runtime_state", state: this.runtimeState };
            if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
            yield { type: "turn_complete", stopReason: "context_window_exceeded", iterations: this._iteration - turnStartIteration };
            return;
          }
          yield { type: "runtime_state", state: this.runtimeState };
          continue;
        }

        const stopReason: AgentStopReason = this._signal?.aborted ? "cancelled" : "error";
        this._lastStopReason = stopReason;
        yield {
          type: "execution_diagnostic",
          level: stopReason === "cancelled" ? "warn" : "error",
          message: stopReason === "cancelled"
            ? "Cancelled during provider turn."
            : `Provider turn failed: ${message}`,
        };
        if (stopReason === "error") yield { type: "error", message };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }

      // Repair near-miss arguments (numeric strings, stringified JSON arrays, wrong-case
      // enums) before the turn is recorded, so recoverable slop executes instead of
      // bouncing back as a validation error that costs a whole model turn. Deliberately
      // done BEFORE _appendAssistantTurn: history and dispatch then agree by construction
      // (what the transcript replays is what actually ran), instead of relying on the
      // recorded blocks sharing object identity with turnResult.toolCalls.
      for (const tc of turnResult.toolCalls) {
        tc.input = coerceToolInput(tc.name, tc.input);
      }

      this._appendAssistantTurn(turnResult);
      this._lastStopReason = turnResult.stopReason;

      if (turnResult.stopReason === "protocol_violation") {
        yield { type: "execution_diagnostic", level: "error", message: "Provider turn ended without a valid terminal event. Run marked as protocol_violation." };
      } else if (turnResult.stopReason === "max_tokens") {
        yield { type: "execution_diagnostic", level: "warn", message: "Output token limit reached - the model response was cut off. Increase max tokens or enable compression to avoid this." };
      } else if (turnResult.stopReason === "refusal") {
        // Reported as what it is. It is deliberately NOT part of _truncatedTurn below: a refusal
        // is a completed response, so the truncation-recovery path would revert it and re-ask
        // with a doubled output budget, spending turns to be refused again.
        yield { type: "execution_diagnostic", level: "warn", message: "The provider declined to complete this response (content filter or guardrail). Rephrasing the request is more likely to help than retrying it." };
      } else if (turnResult.stopReason !== "end_turn" && turnResult.stopReason !== "tool_use") {
        yield { type: "execution_diagnostic", level: "warn", message: `Agent stopped early: ${turnResult.stopReason.replace(/_/g, " ")}` };
      }

      /* The prompt overflowed the model's context window. This is the mirror image of a max_tokens
         cut-off and needs the opposite response: shrink the *input*. It is deliberately handled
         before the truncation-recovery branch below, which reacts to a cut-off turn by doubling the
         output budget — on a context overflow that grows the very request that just overflowed and
         re-provokes the same error until the auto-continue allowance is spent.

         Revert the (unusable) turn, compact, and shed the oldest large tool results if compaction
         couldn't free enough, then retry the same request against the smaller history. */
      if (turnResult.stopReason === "context_window_exceeded" && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
        this.messages.pop();
        this._fullHistory.pop();
        autoContinueCount++;
        this._autoContinueCount = autoContinueCount;
        yield {
          type: "execution_diagnostic",
          level: "warn",
          message: `The prompt exceeded the model's context window. Compacting history and retrying (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})…`,
        };

        const freed = yield* this._recoverContextOverflow();
        if (!freed) {
          this._lastStopReason = "context_window_exceeded";
          yield { type: "error", message: "Prompt exceeds the model's context window and cannot be reduced further. Start a new session, or choose a model with a larger context window." };
          yield { type: "runtime_state", state: this.runtimeState };
          if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
          yield { type: "turn_complete", stopReason: "context_window_exceeded", iterations: this._iteration - turnStartIteration };
          return;
        }
        yield { type: "runtime_state", state: this.runtimeState };
        continue;
      }

      // Tool calls that stopped cleanly (end_turn/tool_use) but fail schema validation are
      // NOT handled here by discarding the whole turn. That threw away the model's valid
      // tool calls alongside the bad one and, after a few imperfect turns, killed the run.
      // Instead each malformed call is answered per-tool with a precise error result during
      // execution below (see the validateToolInput gate), so the valid calls still run and
      // the model can correct just the offending call on its next turn — the modern,
      // non-fatal contract. Truncated turns (empty args from a max_tokens/protocol_violation
      // cut-off) are a different failure mode and are still recovered by reverting +
      // escalating in the branch just below.

      // Auto-recover from truncated tool calls: when the model hits the output token limit
      // mid tool-call, the arguments arrive empty. A complete-but-empty tool call is normal
      // for no-arg tools (memory_read, plan_list defaults) and arrives with stopReason
      // "tool_use" — NOT a truncation. A truncated partial tool call instead surfaces as a
      // terminal "max_tokens" (no block completed) or, once normalized, "protocol_violation"
      // (a partial block was emitted with non-tool_use stop). Only those two signals, paired
      // with an empty input, indicate truncation — otherwise the empty call would be executed
      // blind. Revert the malformed turn, compress/escalate, and retry with a recovery prompt.
      const _truncatedTurn = turnResult.stopReason === "max_tokens" || turnResult.stopReason === "protocol_violation";
      const _malformedCalls = _truncatedTurn
        ? turnResult.toolCalls.filter(
            (tc) => !tc.input || Object.keys(tc.input as Record<string, unknown>).length === 0,
          )
        : [];
      if (_malformedCalls.length > 0 && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
        this.messages.pop();
        this._fullHistory.pop();
        autoContinueCount++;
        this._autoContinueCount = autoContinueCount;
        const callNames = _malformedCalls.map((tc) => tc.name).join(", ");
        // Escalate the output token budget so the retry has more headroom.
        this._maxTokensOverride = this._clampToOutputCeiling(Math.min(this._effectiveMaxTokens() * 2, this._maxEscalationCeiling()));
        yield {
          type: "execution_diagnostic",
          level: "warn",
          message: `Truncated tool call(s) [${callNames}] — response cut off before arguments were populated. Escalating output budget to ${this._maxTokensOverride} tokens and retrying (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})…`,
        };
        if (this.opts.compressionProvider && (this._compactionInFlight || this._compressibleMessageCount() > 4)) {
          yield { type: "runtime_state", state: this.runtimeState };
          await this._awaitCompactionBounded(this.opts.compressionProvider);
          for (const note of this._takePendingCompactionNotices()) {
            yield { type: "execution_diagnostic", level: note.level, message: note.message };
          }
          yield { type: "runtime_state", state: this.runtimeState };
        }
        this._providerTurnSession.appendUserText(
          `Your last response was cut off by the output token limit before the tool arguments for [${callNames}] were populated. ` +
          `Please retry. If writing large files, split the content into smaller sections across multiple tool calls.`,
        );
        yield { type: "runtime_state", state: this.runtimeState };
        continue;
      }

      // Plain-text truncation (no tool call at all — just prose/reasoning cut off mid-stream):
      // unlike the malformed-tool-call case above, there is nothing invalid to revert, so the
      // truncated text stays in history and the model is asked to pick up where it left off,
      // with more headroom. Previously this fell straight through to the terminal return below
      // and silently ended the turn with a cut-off answer as "the response" — see the
      // execution logs this was diagnosed from.
      if (_truncatedTurn && turnResult.toolCalls.length === 0 && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
        autoContinueCount++;
        this._autoContinueCount = autoContinueCount;
        this._maxTokensOverride = this._clampToOutputCeiling(Math.min(this._effectiveMaxTokens() * 2, this._maxEscalationCeiling()));
        yield {
          type: "execution_diagnostic",
          level: "warn",
          message: `Response cut off by the output token limit. Escalating output budget to ${this._maxTokensOverride} tokens and continuing (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})…`,
        };
        if (this.opts.compressionProvider && (this._compactionInFlight || this._compressibleMessageCount() > 4)) {
          yield { type: "runtime_state", state: this.runtimeState };
          await this._awaitCompactionBounded(this.opts.compressionProvider);
          for (const note of this._takePendingCompactionNotices()) {
            yield { type: "execution_diagnostic", level: note.level, message: note.message };
          }
          yield { type: "runtime_state", state: this.runtimeState };
        }
        this._providerTurnSession.appendUserText(
          "Your last response was cut off by the output token limit. Continue exactly where you left off — do not repeat what you already wrote.",
        );
        yield { type: "runtime_state", state: this.runtimeState };
        continue;
      }

      if (turnResult.toolCalls.length === 0) {
        const shouldAutoContinue = awaitingPostToolContinuation
          && turnResult.stopReason === "end_turn"
          && turnResult.empty
          && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS;

        if (shouldAutoContinue) {
          autoContinueCount += 1;
          this._autoContinueCount = autoContinueCount;
          yield {
            type: "execution_diagnostic",
            level: "info",
            message: `Empty post-tool response detected - issuing internal continuation ${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS}.`,
          };
          this._providerTurnSession.appendUserText(INTERNAL_AUTO_CONTINUE_PROMPT);
          yield { type: "runtime_state", state: this.runtimeState };
          continue;
        }

        /* Harness-level nudge, not a hard gate: a genuine end_turn with files
           edited but no map note gets a bounded number of forced
           continuations (mirrors the empty-response recovery above) before
           failing open — see MAX_NOTE_ENFORCEMENT_CONTINUATIONS. Both branches
           are nested under stopReason === "end_turn" so an error/cancelled/
           protocol_violation termination neither claims reminders it never
           issued nor clears _dirtyMapFiles — that state should survive into a
           resumed session, not be silently forgotten because the turn ended
           abnormally. */
        if (turnResult.stopReason === "end_turn" && this._dirtyMapFiles.size > 0) {
          if (this._noteEnforcementCount < MAX_NOTE_ENFORCEMENT_CONTINUATIONS) {
            this._noteEnforcementCount += 1;
            const paths = [...this._dirtyMapFiles];
            yield {
              type: "execution_diagnostic",
              level: "info",
              message: `Edited without a Codebase Map note: ${paths.join(", ")} — issuing internal continuation ${this._noteEnforcementCount}/${MAX_NOTE_ENFORCEMENT_CONTINUATIONS}.`,
            };
            this._providerTurnSession.appendUserText(noteEnforcementPrompt(paths));
            yield { type: "runtime_state", state: this.runtimeState };
            continue;
          }
          // Cap exhausted — fail open rather than stall the session indefinitely.
          yield {
            type: "execution_diagnostic",
            level: "warn",
            message: `Finishing without a Codebase Map note for: ${[...this._dirtyMapFiles].join(", ")} after ${MAX_NOTE_ENFORCEMENT_CONTINUATIONS} reminder(s).`,
          };
          this._dirtyMapFiles.clear();
          this._noteEnforcementCount = 0;
        }

        awaitingPostToolContinuation = false;
        this._autoContinueCount = autoContinueCount;
        // ProviderTurnResult carries no error-detail field alongside stopReason — this fires
        // when some gateway's raw finish_reason/stop_reason is literally the word "error" with
        // no accompanying error payload (if there were one, the stream-error path earlier in
        // the turn would already have thrown it as a ProviderStreamError instead of reaching
        // here). Name what's known at this call site since there's nothing more specific to say.
        if (turnResult.stopReason === "error") yield { type: "error", message: `Provider reported an error terminal state (${this.provider}/${this.opts.model} returned finish_reason "error" with no further detail).` };
        if (turnResult.stopReason === "protocol_violation") yield { type: "error", message: "Provider turn violated the normalized turn contract." };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) {
          if (turnResult.stopReason === "end_turn") clearCheckpoint(this.opts.context);
          else this._saveCheckpoint();
        }
        yield { type: "turn_complete", stopReason: turnResult.stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }

      autoContinueCount = 0;
      this._autoContinueCount = 0;
      this._maxTokensOverride = undefined; // successful tool use — reset any truncation escalation
      awaitingPostToolContinuation = true;
      // Everything from here to the end of the iteration (tool execution, history push,
      // compression, checkpoint) runs outside the streaming try/catch above. Wrap it
      // so that any uncaught exception produces a visible error event rather than
      // silently killing the generator and leaving the UI stuck in "streaming" state.
      try {

      // Group tool calls based on whether they are parallel subagents
      const groups: { parallel: boolean; toolCalls: ToolUseBlock[] }[] = [];
      for (const tc of turnResult.toolCalls) {
        const isParallel = isParallelSubagent(tc);
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.parallel === isParallel) {
          lastGroup.toolCalls.push(tc);
        } else {
          groups.push({ parallel: isParallel, toolCalls: [tc] });
        }
      }

      // Map tool calls to their original indices for in-order results
      const tcToIndex = new Map<string, number>();
      turnResult.toolCalls.forEach((tc, idx) => tcToIndex.set(tc.id, idx));

      const toolResults: ToolResultBlock[] = new Array(turnResult.toolCalls.length);
      // Populated when reference_zoom_image runs with a vision-capable model — appended
      // as sibling content in the same tool-result turn (never a separate message).
      const pendingImages: ImageBlock[] = [];

      for (const group of groups) {
        if (this._signal?.aborted) {
          yield { type: "execution_diagnostic", level: "warn", message: "Cancelled between tool groups." };
          throw new Error("Cancelled.");
        }

        if (group.parallel) {
          // Parallel execution of subagents — respects maxConcurrent limit
          const maxConcurrent = Math.max(1, this.opts.subagentMaxConcurrent ?? 4);
          const generators: AsyncGenerator<AgentEvent>[] = [];
          
          for (const tc of group.toolCalls) {
            const dispatch = resolveToolDispatch(tc.name, tc.input);
            const payload = dispatch.payload;
            const subagentInput = normalizeSubagentSpawnInput(payload);
            const toolStartedAt = Date.now();
            const idx = tcToIndex.get(tc.id)!;

            const validationError = this._toolValidationError(tc);
            if (validationError) {
              toolResults[idx] = {
                type: "tool_result",
                tool_use_id: tc.id,
                content: this._capToolResult(tc.id, JSON.stringify(validationError)),
              };
              const toolName = tc.name;
              const toolId = tc.id;
              generators.push((async function* (): AsyncGenerator<AgentEvent> {
                yield { type: "tool_call_result", toolCallId: toolId, toolName, ok: false, summary: validationError.error, result: validationError, elapsedMs: 0 };
              })());
              continue;
            }

            const runSubagent = async function* (self: AgentSession): AsyncGenerator<AgentEvent> {
              if (!self.opts.subagentProvider) {
                const res = { ok: false, error: "Subagents are not available in this context." };
                const elapsedMs = Math.max(Date.now() - toolStartedAt, 0);
                toolResults[idx] = {
                  type: "tool_result",
                  tool_use_id: tc.id,
                  content: self._capToolResult(tc.id, JSON.stringify(res)),
                };
                yield {
                  type: "tool_call_result",
                  toolCallId: tc.id,
                  toolName: tc.name,
                  ok: false,
                  summary: "Subagents are not available in this context.",
                  result: res,
                  elapsedMs,
                };
                return;
              }

              let finalResult: { ok: false; error: string } | SubagentSpawnToolResult = {
                ok: false,
                error: "Delegated lane did not return a result.",
              };

              const planStepStart = await self._syncSubagentStepStart(subagentInput);
              if (!planStepStart.canStart) {
                finalResult = { ok: false, error: `Linked plan step is not ready to delegate: ${planStepStart.error ?? "execution is not approved."}` };
              } else {
                try {
                  for await (const subEvent of self.opts.subagentProvider.spawn({
                    parentSessionId: self.sessionId,
                    parentToolCallId: tc.id,
                    input: subagentInput,
                    signal: self._signal,
                  })) {
                    if (subEvent.type === "subagent_tool_result") {
                      finalResult = subEvent.result;
                    } else {
                      /* A subagent's own edits/notes are still this session's
                         responsibility — relay them into the same tracker used
                         for direct tool calls (see _trackToolResultForNotes). */
                      if (subEvent.type === "subagent_lane_event" && subEvent.event.type === "tool_call_result") {
                        self._trackToolResultForNotes(subEvent.event.toolName, subEvent.event.result);
                      }
                      yield subEvent;
                    }
                  }
                } catch (err) {
                  finalResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
                } finally {
                  await self._syncSubagentStepEnd(subagentInput, finalResult);
                }
              }
              const elapsedMs = Math.max(Date.now() - toolStartedAt, 0);
              const ok = isOk(finalResult);
              const summary = ok ? summarizeResult(finalResult) : String((finalResult as Record<string, unknown> | undefined)?.["error"] ?? "Failed");

              toolResults[idx] = {
                type: "tool_result",
                tool_use_id: tc.id,
                content: self._capToolResult(tc.id, JSON.stringify(finalResult)),
              };

              yield {
                type: "tool_call_result",
                toolCallId: tc.id,
                toolName: tc.name,
                ok,
                summary,
                result: finalResult,
                elapsedMs,
              };
            };

            generators.push(runSubagent(this));
          }

          // Interleave events from parallel subagents, respecting maxConcurrent
          for (let i = 0; i < generators.length; i += maxConcurrent) {
            const batch = generators.slice(i, i + maxConcurrent);
            for await (const event of mergeAsyncGenerators(batch)) {
              yield event;
            }
          }

        } else {
          // Sequential execution
          for (const tc of group.toolCalls) {
            if (this._signal?.aborted) {
              yield { type: "execution_diagnostic", level: "warn", message: "Cancelled before tool execution." };
              throw new Error("Cancelled.");
            }
            const dispatch = resolveToolDispatch(tc.name, tc.input);
            const runtimeType = dispatch.runtimeType;
            const payload = dispatch.payload;
            let result: unknown;
            const toolStartedAt = Date.now();
            const idx = tcToIndex.get(tc.id)!;

            const validationError = this._toolValidationError(tc);
            if (validationError) {
              toolResults[idx] = {
                type: "tool_result",
                tool_use_id: tc.id,
                content: this._capToolResult(tc.id, JSON.stringify(validationError)),
              };
              yield {
                type: "tool_call_result",
                toolCallId: tc.id,
                toolName: tc.name,
                ok: false,
                summary: validationError.error,
                result: validationError,
                elapsedMs: Math.max(Date.now() - toolStartedAt, 0),
              };
              continue;
            }

            try {
              if (runtimeType === "ui.question_card") {
                if (!this.opts.questionCardProvider) {
                  result = { ok: false, error: "No question card handler is available in this context." };
                } else {
                  const raw = payload as { questions?: unknown };
                  const questions: QCardQuestion[] = Array.isArray(raw.questions)
                    ? (raw.questions as Array<Record<string, unknown>>).map((item) => ({
                        question: String(item?.question ?? ""),
                        options: Array.isArray(item?.options) ? (item.options as QCardOption[]) : [],
                        context: item?.context != null ? String(item.context) : undefined,
                        multiSelect: item?.multiSelect === true,
                      }))
                    : [];
                  const questionError = validateQuestionCardQuestions(questions);
                  if (questionError) {
                    result = { ok: false, error: questionError };
                  } else {
                    this._pendingGate = { kind: "question", toolCallId: tc.id, questions };
                    yield { type: "runtime_state", state: this.runtimeState };
                    if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                    yield { type: "question_card_pending", toolCallId: tc.id, questions };
                    try {
                      const answers = await this.opts.questionCardProvider(tc.id, questions);
                      yield { type: "question_card_result", toolCallId: tc.id, answers };
                      result = {
                        ok: true,
                        answers: questions.map((q, i) => ({
                          question: q.question,
                          selectedKeys: answers[i] ?? [],
                          selectedLabels: (answers[i] ?? []).map((key) => q.options.find((o) => o.key === key)?.label ?? key),
                        })),
                      };
                    } catch {
                      result = { ok: false, error: this._signal?.aborted ? "Cancelled." : "Question was cancelled." };
                    } finally {
                      this._pendingGate = undefined;
                      yield { type: "runtime_state", state: this.runtimeState };
                      if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                    }
                  }
                }
              } else if (runtimeType === "editor.apply_edit") {
                if (!this.opts.editProvider) {
                  result = { ok: false, error: "File editing is not available in this context." };
                } else {
                  const r = await this.opts.editProvider.applyEdit(
                    {
                      path: String(payload["path"] ?? ""),
                      oldString: String(payload["oldString"] ?? ""),
                      newString: String(payload["newString"] ?? ""),
                      replaceAll: payload["replaceAll"] === true,
                      expectedReplacements: typeof payload["expectedReplacements"] === "number" ? payload["expectedReplacements"] : undefined,
                    },
                    { autoApprove: this._autoApprove },
                  );
                  if (r.ok && r.autoApproveAll) this._autoApprove = true;
                  if ("autoApproveAll" in r) delete (r as { autoApproveAll?: boolean }).autoApproveAll;
                  result = r;
                }
              } else if (runtimeType === "editor.apply_edit_batch") {
                if (!this.opts.editProvider) {
                  result = { ok: false, error: "File editing is not available in this context." };
                } else {
                  const edits = Array.isArray(payload["edits"])
                    ? (payload["edits"] as Array<Record<string, unknown>>).map((edit) => ({
                      path: String(edit.path ?? ""),
                      oldString: String(edit.oldString ?? ""),
                      newString: String(edit.newString ?? ""),
                      replaceAll: edit.replaceAll === true,
                      expectedReplacements: typeof edit.expectedReplacements === "number" ? edit.expectedReplacements : undefined,
                    }))
                    : [];
                  const r = await this.opts.editProvider.applyBatchEdits(
                    { edits },
                    { autoApprove: this._autoApprove },
                  );
                  if (r.ok && r.autoApproveAll) this._autoApprove = true;
                  if ("autoApproveAll" in r) delete (r as { autoApproveAll?: boolean }).autoApproveAll;
                  result = r;
                }
              } else if (runtimeType === "editor.rename_path") {
                if (!this.opts.editProvider?.movePath) {
                  result = { ok: false, error: "File moving is not available in this context." };
                } else {
                  result = await this.opts.editProvider.movePath(
                    {
                      source: String(payload["source"] ?? ""),
                      destination: String(payload["destination"] ?? ""),
                      overwrite: payload["overwrite"] === true,
                    },
                    { autoApprove: this._autoApprove },
                  );
                }
              } else if (runtimeType === "editor.json_edit") {
                if (!this.opts.editProvider) {
                  result = { ok: false, error: "File editing is not available in this context." };
                } else {
                  // `value` is intentionally passed through as-is (any JSON type) rather than
                  // coerced like the string fields above — applyJsonEdit validates op/pointer/value shape itself.
                  const operations = Array.isArray(payload["operations"])
                    ? (payload["operations"] as Array<Record<string, unknown>>).map((operation) => ({
                      op: operation["op"],
                      pointer: operation["pointer"],
                      value: operation["value"],
                    }))
                    : [];
                  const r = await this.opts.editProvider.applyJsonEdit(
                    { path: String(payload["path"] ?? ""), operations: operations as JsonOperation[] },
                    { autoApprove: this._autoApprove },
                  );
                  if (r.ok && r.autoApproveAll) this._autoApprove = true;
                  if ("autoApproveAll" in r) delete (r as { autoApproveAll?: boolean }).autoApproveAll;
                  result = r;
                }
              } else if (runtimeType === "editor.report_problems") {
                if (!this.opts.diagnosticsProvider) {
                  result = { ok: false, error: "The Problems panel is not available in this context." };
                } else {
                  const problems = Array.isArray(payload["problems"]) ? (payload["problems"] as ProblemInput[]) : [];
                  result = this.opts.diagnosticsProvider.report(problems, payload["clear"] === true);
                }
              } else if (runtimeType.startsWith("lsp.")) {
                if (!this.opts.lspProvider) {
                  result = { ok: false, error: "Code intelligence is not available in this context." };
                } else {
                  const r = await this.opts.lspProvider.dispatch(
                    runtimeType.slice("lsp.".length),
                    payload,
                    { autoApprove: this._autoApprove, signal: this._signal },
                  );
                  if (r.ok && (r as { autoApproveAll?: boolean }).autoApproveAll) this._autoApprove = true;
                  if ("autoApproveAll" in r) delete (r as { autoApproveAll?: boolean }).autoApproveAll;
                  result = r;
                }
              } else if (runtimeType === "memory.semantic_search") {
                result = await this._handleMemorySemanticSearch(payload);
              } else if (runtimeType.startsWith("memory.")) {
                result = this._handleMemory(runtimeType.slice("memory.".length), payload);
              } else if (runtimeType === "transcript.read") {
                result = this._handleTranscriptRead(payload);
              } else if (runtimeType.startsWith("transcript.document")) {
                if (!this.opts.transcriptDocumentProvider) {
                  result = { ok: false, error: "Transcript documents are not available in this workspace." };
                } else {
                  result = await this.opts.transcriptDocumentProvider.dispatch(
                    runtimeType.slice("transcript.".length),
                    payload,
                    { sessionId: this.sessionId },
                  );
                }
              } else if (runtimeType === "session.tool_output_page") {
                result = this._handleToolResultPage(payload);
              } else if (runtimeType === "session.tool_output_search") {
                result = this._handleToolResultSearch(payload);
              } else if (runtimeType.startsWith("planning.")) {
                if (!this.opts.planningProvider) {
                  result = { ok: false, error: "Planning is not available in this context." };
                } else {
                  result = await this.opts.planningProvider.dispatch(
                    runtimeType.slice("planning.".length),
                    payload,
                    { sessionId: this.sessionId, requestId: undefined },
                  );
                }
              } else if (runtimeType.startsWith("graph.")) {
                if (!this.opts.graphProvider) {
                  result = { ok: false, error: "The Codebase Map is not available in this context." };
                } else {
                  result = await this.opts.graphProvider.dispatch(
                    runtimeType.slice("graph.".length),
                    payload,
                    { sessionId: this.sessionId },
                  );
                }
              } else if (runtimeType.startsWith("data.")) {
                if (!this.opts.dataProvider) {
                  result = { ok: false, error: "The local database is not available in this context." };
                } else {
                  result = await this.opts.dataProvider.dispatch(runtimeType.slice("data.".length), payload);
                }
              } else if (runtimeType.startsWith("reference.")) {
                if (!this.opts.referenceProvider) {
                  result = { ok: false, error: "Reference files are not available in this context." };
                } else {
                  result = await this.opts.referenceProvider.dispatch(
                    runtimeType.slice("reference.".length),
                    payload,
                    { sessionId: this.sessionId },
                  );
                }
              } else if (runtimeType === "subagent.spawn") {
                if (!this.opts.subagentProvider) {
                  result = { ok: false, error: "Subagents are not available in this context." };
                } else {
                  const subagentInput = normalizeSubagentSpawnInput(payload);
                  let finalResult: { ok: false; error: string } | SubagentSpawnToolResult = {
                    ok: false,
                    error: "Delegated lane did not return a result.",
                  };
                  const planStepStart = await this._syncSubagentStepStart(subagentInput);
                  if (!planStepStart.canStart) {
                    finalResult = { ok: false, error: `Linked plan step is not ready to delegate: ${planStepStart.error ?? "execution is not approved."}` };
                  } else {
                    try {
                      for await (const subEvent of this.opts.subagentProvider.spawn({
                        parentSessionId: this.sessionId,
                        parentToolCallId: tc.id,
                        input: subagentInput,
                        signal: this._signal,
                      })) {
                        if (subEvent.type === "subagent_tool_result") {
                          finalResult = subEvent.result;
                        } else {
                          if (subEvent.type === "subagent_lane_event" && subEvent.event.type === "tool_call_result") {
                            this._trackToolResultForNotes(subEvent.event.toolName, subEvent.event.result);
                          }
                          yield subEvent;
                        }
                      }
                    } catch (err) {
                      finalResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
                    } finally {
                      await this._syncSubagentStepEnd(subagentInput, finalResult);
                    }
                  }
                  result = finalResult;
                }
              } else if (runtimeType.startsWith("browser.") && this.opts.browserRunner) {
                // Route browser tool calls to the local Chromium instance
                result = await this.opts.browserRunner.dispatch(
                  runtimeType.slice("browser.".length),  // "navigate", "click", etc.
                  payload,
                );
                // If the browser runtime is missing, disable browser tools for the rest of the
                // session so the agent stops retrying a guaranteed failure and pivots (e.g. start a
                // local server and hand the user the URL, per the system prompt guidance).
                if (this._isBrowserUnavailableResult(result)) this._browserUnavailable = true;
              } else if (runtimeType.startsWith("service.")) {
                // Inject service credentials from SecretStorage before dispatching
                const enriched = await this._enrichServicePayload(runtimeType, payload);
                if (enriched["_serviceError"]) {
                  result = { ok: false, error: enriched["_serviceError"] };
                } else {
                  const resp = await this.opts.runtime.handleMessage({ type: runtimeType, payload: enriched });
                  result = runtimeResultOrError(resp, tc.name, () => this._getTools().map((t) => t.name));
                }
              } else {
                const firstResponse = await this.opts.runtime.handleMessage({ type: runtimeType, payload });
                const firstResult = runtimeResultOrError(firstResponse, tc.name, () => this._getTools().map((t) => t.name));
                if (isConfirmationRequired(firstResult)) {
                  const { tier, description, unrecognizedCommand } = firstResult as { tier: string; description: string; unrecognizedCommand?: boolean };
                  let granted = this._autoApprove;
                  let decision: ApprovalDecision = this._autoApprove ? "allow_all" : "deny";
                  let deniedByPolicy = false;
                  if (!granted) {
                    // An interactive approver is available when the host wired an approvalProvider
                    // or the run left the policy at "interactive" (the host modal). Autonomous /
                    // delegated runs that set "deny"/"allow" resolve by policy WITHOUT a pending
                    // gate — a gate would leave the run blocked forever with no one to answer it.
                    const autoPolicy = this.opts.autonomousApprovalPolicy ?? "interactive";
                    const canPromptInteractively = !!this.opts.approvalProvider || autoPolicy === "interactive";
                    if (!canPromptInteractively) {
                      decision = autoPolicy === "allow" ? "allow_all" : "deny";
                      deniedByPolicy = decision === "deny";
                      if (decision === "allow_all") this._autoApprove = true;
                      granted = decision !== "deny";
                    } else {
                      this._pendingGate = { kind: "approval", toolCallId: tc.id, toolName: tc.name, description, tier, unrecognizedCommand };
                      yield { type: "runtime_state", state: this.runtimeState };
                      if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                      yield { type: "approval_pending", toolCallId: tc.id, description, tier, unrecognizedCommand };
                      try {
                        decision = this.opts.approvalProvider
                          ? await this.opts.approvalProvider(tc.id, tc.name, description, tier)
                          : await requestApprovalWithDetails(tc.name, description, tier);
                      } finally {
                        this._pendingGate = undefined;
                        yield { type: "runtime_state", state: this.runtimeState };
                        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                      }
                      if (decision === "allow_all") this._autoApprove = true;
                      granted = decision !== "deny";
                    }
                  }
                  yield { type: "approval_result", toolCallId: tc.id, granted, decision };
                  if (!granted) {
                    result = deniedByPolicy
                      ? { ok: false, error: `This ${tier} operation requires approval, but this run has no interactive approver to grant it — it was automatically denied. Continue without it, or take a read-only / non-${tier} approach.` }
                      : { ok: false, error: "User denied the operation." };
                  } else {
                    const confirmed = await this.opts.runtime.handleMessage({ type: runtimeType, payload: { ...payload, confirmed: true } });
                    result = runtimeResultOrError(confirmed, tc.name, () => this._getTools().map((t) => t.name));
                  }
                } else {
                  result = firstResult;
                }
              }
            } catch (err) {
              result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            // Defence-in-depth: no dispatch branch should leave `result` undefined, but if one
            // ever does, JSON.stringify(undefined) → undefined would crash _capToolResult and
            // take down the whole turn. Normalize to a clean error instead.
            if (result === undefined) result = { ok: false, error: "Tool returned no result." };

            // Augment successful tool results with semantically similar past calls.
            // The lookup is time-bounded (1.8 s) and fully non-blocking if the index
            // is not configured or the embedding service is unavailable.
            const memIdx = this.opts.agentMemoryIndex;
            if (memIdx && isOk(result)) {
              // Index this call asynchronously — don't await, don't block
              void memIdx.indexToolCall(this.sessionId, tc.name, tc.input, result, this._iteration);
              const similar = await Promise.race([
                memIdx.similarToolCalls(tc.name, tc.input, this.sessionId),
                new Promise<never[]>((res) => setTimeout(() => res([]), 1_800)),
              ]).catch(() => []);
              if (similar.length > 0 && typeof result === "object" && result !== null && !Array.isArray(result)) {
                result = {
                  ...(result as object),
                  _related: similar.map((s) =>
                    `${s.toolName} ${s.inputSummary} → "${s.resultSummary}" [ref:${s.sessionId.slice(-6)}:t${s.turnIndex}]`,
                  ),
                };
              }
            }

            const ok = isOk(result);
            this._trackToolResultForNotes(tc.name, result);
            // Attach post-write diagnostics so file_write reports its fallout in the
            // same turn, matching the `diagnostics` field file_edit and the mutating
            // code_* tools already carry. Best-effort: a provider failure must never
            // fail the write that already succeeded.
            if (ok && tc.name === "file_write" && this.opts.mutationDiagnosticsProvider) {
              const writtenPath = (result as Record<string, unknown>)["path"];
              if (typeof writtenPath === "string" && writtenPath) {
                try {
                  const diagnostics = await this.opts.mutationDiagnosticsProvider([writtenPath]);
                  if (diagnostics !== undefined) result = { ...(result as object), diagnostics };
                } catch { /* the write succeeded; diagnostics are an enrichment */ }
              }
            }
            // The model-facing copy: image fields get pulled out into real vision
            // blocks (or described via the fallback model) instead of being
            // JSON.stringify'd as unreadable, cap-eating base64 text. `result` itself
            // stays untouched below for the UI event, which needs the raw data URL
            // to render a thumbnail.
            let modelResult: unknown = result;
            if (ok && tc.name === "reference_zoom_image") {
              modelResult = await this._extractImageForModel(
                result as Record<string, unknown>, "mediaDataUrl", pendingImages,
                "Describe this cropped/zoomed image region in detail — visible text, UI elements, colors, and anything relevant to why it was zoomed in on.",
              );
            } else if (ok && tc.name === "file_read" && typeof (result as Record<string, unknown>)["mediaDataUrl"] === "string") {
              // file_read on an image file returns a data URL rather than text — hand the model
              // the real picture, exactly as reference_zoom_image/browser_screenshot already do.
              modelResult = await this._extractImageForModel(
                result as Record<string, unknown>, "mediaDataUrl", pendingImages,
                "Describe this image file in detail — visible text, layout, UI elements, colors, and anything relevant to why it was opened.",
              );
            } else if (ok && tc.name === "browser_screenshot") {
              modelResult = await this._extractImageForModel(
                result as Record<string, unknown>, "dataUrl", pendingImages,
                "Describe this browser screenshot in detail — visible text, layout, UI elements, colors, and anything relevant to verifying the page rendered correctly.",
              );
            } else if (ok && tc.name === "browser_run_script") {
              modelResult = await this._extractRunScriptImages(result as Record<string, unknown>, pendingImages);
            }
            const summary = ok ? summarizeResult(result) : String((result as Record<string, unknown> | undefined)?.["error"] ?? "Failed");

            toolResults[idx] = {
              type: "tool_result",
              tool_use_id: tc.id,
              content: this._capToolResult(tc.id, JSON.stringify(modelResult)),
            };

            yield {
              type: "tool_call_result",
              toolCallId: tc.id,
              toolName: tc.name,
              ok,
              summary,
              result,
              elapsedMs: Math.max(Date.now() - toolStartedAt, 0),
            };
          }
        }
      }

      this._providerTurnSession.appendToolResults(toolResults, pendingImages.length ? pendingImages : undefined);
      yield { type: "runtime_state", state: this.runtimeState };

      // Trigger compression when the context window is getting full. Below the critical
      // line, compact in the background so the summariser round-trip overlaps the next turn
      // instead of blocking here; at or above it, block (bounded) and shed as a last resort.
      if (this.opts.compressionProvider && this._lastInputTokens > 0) {
        const usedPct = this._lastInputTokens / this._effectiveContextLength() * 100;
        const threshold = this.opts.compressionTriggerPct ?? 60;
        const compressible = this._compressibleMessageCount();
        if (usedPct >= threshold && compressible > 4) {
          if (usedPct >= COMPACTION_CRITICAL_PCT && this._compactionCircuitOpen) {
            // Compaction is known-broken this session — skip the wait and shed directly.
            const freed = this._emergencyTruncateOldestToolResults(Math.floor(this._effectiveContextLength() * 0.8));
            yield freed > 0
              ? { type: "execution_diagnostic", level: "warn", message: `Context at ${Math.round(usedPct)}% — automatic compaction is disabled after repeated failures; shed ~${Math.round(freed / 1000)}k chars of old tool output instead.` }
              : { type: "execution_diagnostic", level: "warn", message: `Context at ${Math.round(usedPct)}% and automatic compaction is disabled after repeated failures — nothing left to shed either.` };
            yield { type: "runtime_state", state: this.runtimeState };
          } else if (usedPct >= COMPACTION_CRITICAL_PCT) {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — compacting ${compressible} older messages before continuing…` };
            yield { type: "runtime_state", state: this.runtimeState };
            const outcome = await this._awaitCompactionBounded(this.opts.compressionProvider);
            for (const note of this._takePendingCompactionNotices()) {
              yield { type: "execution_diagnostic", level: note.level, message: note.message };
            }
            if (outcome !== "compressed" && this._signal?.aborted) {
              // The wait ended because the user hit Stop, not because compaction failed.
              // Do NOT shed history: emergency truncation is irreversible, the run is
              // ending anyway, and the still-running background pass will summarise the
              // same prefix cleanly for a resumed session.
              yield { type: "execution_diagnostic", level: "warn", message: "Cancelled while waiting for compaction — leaving history untouched." };
            } else if (outcome !== "compressed") {
              // Compaction didn't free headroom in time (skipped, failed, or still running past
              // the deadline): shed the oldest large tool-result payloads in place so context
              // can't grow into a 400.
              const detail = outcome === "failed" && this._lastCompressionError
                ? `: ${this._lastCompressionError}`
                : outcome === "timed_out"
                ? " (still running in the background)"
                : "";
              const freed = this._emergencyTruncateOldestToolResults(Math.floor(this._effectiveContextLength() * 0.8));
              yield freed > 0
                ? { type: "execution_diagnostic", level: "warn", message: `Compaction did not free enough${detail}. Shed ~${Math.round(freed / 1000)}k chars of old tool output to stay under the context limit.` }
                : { type: "execution_diagnostic", level: "warn", message: `Compaction did not complete in time${detail} — session continues at full context.` };
            }
            yield { type: "runtime_state", state: this.runtimeState };
          } else if (!this._compactionInFlight && !this._compactionCircuitOpen) {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — compacting ${compressible} older messages in the background…` };
            void this._beginBackgroundCompaction(this.opts.compressionProvider, "auto");
            yield { type: "runtime_state", state: this.runtimeState };
          }
          // else: a background pass is already running, or the circuit is open and below the
          // critical line — nothing to do until either the pass lands or the line is crossed.
        } else if (usedPct >= threshold) {
          yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — not enough history to compress yet (${this.messages.length} messages).` };
        }
      }

      const duplicateRound = this._observeToolRound(turnResult.toolCalls, toolResults);
      if (duplicateRound) {
        yield {
          type: "execution_diagnostic",
          level: "info",
          message: `${duplicateRound.rounds} identical tool rounds (${duplicateRound.tools}) returned no new evidence — asking the agent to choose a different next step (${this._duplicateToolRoundNudgeCount}/${MAX_DUPLICATE_TOOL_ROUND_NUDGES}).`,
        };
        this._providerTurnSession.appendUserText(duplicateToolRoundPrompt(duplicateRound.rounds, duplicateRound.tools));
      }

      if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();

      } catch (toolErr) {
        // A tool or post-tool step threw unexpectedly. Emit a visible error event so
        // the webview can recover (setRunning(false)) instead of staying frozen.
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        const stopReason: AgentStopReason = this._signal?.aborted ? "cancelled" : "error";
        this._lastStopReason = stopReason;
        yield {
          type: "execution_diagnostic",
          level: stopReason === "cancelled" ? "warn" : "error",
          message: stopReason === "cancelled"
            ? "Cancelled during tool execution."
            : `Unexpected error during tool execution: ${msg}`,
        };
        if (stopReason === "error") yield { type: "error", message: msg };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }
    }

    this._lastStopReason = "max_iterations";
    yield { type: "runtime_state", state: this.runtimeState };
    yield { type: "turn_complete", stopReason: "max_iterations", iterations: this._iteration - turnStartIteration };
  }

  // ── Anthropic native streaming ─────────────────────────────────────────────

  /**
   * POST to a provider with transient-failure retries, yielding a live "retrying…" notice
   * between attempts and returning the successful Response. Only the pre-stream phase
   * (connection + response status) is retried — that is where 429/529/5xx/throttle and
   * connect failures surface, before any body has been read — so a retry can never
   * duplicate already-streamed output. A non-retryable or exhausted non-OK response is
   * returned as-is for the caller to turn into its provider-specific error. Honours a
   * server `Retry-After` header.
   */
  private async *_fetchWithRetry(
    label: string,
    doFetch: (signal: AbortSignal | undefined) => Promise<Response>,
  ): AsyncGenerator<ProviderTurnStreamEvent, Response> {
    const policy = this.opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    let lastErr: unknown;
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      if (this._signal?.aborted) throw makeAbortError();
      const isLast = attempt >= policy.maxAttempts - 1;
      try {
        const response = await doFetch(this._signal);
        if (response.ok) return response;
        if (isLast || !isRetryableStatus(response.status)) return response;
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const delayMs = computeBackoffMs(attempt, policy, retryAfter);
        await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
        yield {
          type: "notice",
          level: "warn",
          message: `${label} ${response.status} — retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
        };
        await interruptibleSleep(delayMs, this._signal);
      } catch (err) {
        lastErr = err;
        if (this._signal?.aborted || isLast || !isRetryableError(err)) throw err;
        const delayMs = computeBackoffMs(attempt, policy, null);
        yield {
          type: "notice",
          level: "warn",
          message: `${label} connection error (${err instanceof Error ? err.message : String(err)}) — retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
        };
        await interruptibleSleep(delayMs, this._signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${label}: request failed after ${policy.maxAttempts} attempts`);
  }

  /** Build the Anthropic wire tool list — strict-marked where the schema qualifies, unless the
   *  session already learned strict isn't accepted — with the trailing cache breakpoint. */
  private _buildAnthropicWireTools(): Array<Record<string, unknown>> {
    const tools = this._strictToolsUnsupported
      ? this._getTools().map(({ name, description, input_schema }) =>
          ({ name, description, input_schema }) as Record<string, unknown>)
      : withAnthropicStrictTools(this._getTools());
    // Cache the (large, stable) tool-schema block by marking the last tool. The breakpoint
    // caches everything before it too (system + summary), so between compressions the entire
    // system+tools prefix is a cache hit.
    if (tools.length > 0) tools[tools.length - 1]!["cache_control"] = cacheControlFor(this.opts.cacheTtl);
    return tools;
  }

  /** True for a 400 plausibly caused by `strict`/schema validation — the trigger for the
   *  one-shot retry without strict marking. A false positive costs one harmless extra
   *  round-trip whose real error still surfaces. */
  private static _looksLikeStrictRejection(status: number, text: string): boolean {
    return status === 400 && /\bstrict\b|input_schema/i.test(text);
  }

  private async *_streamTurnAnthropic(): AsyncGenerator<ProviderTurnStreamEvent> {
    const url = this.opts.baseUrl ?? PROVIDER_DEFAULTS.anthropic.baseUrl;

    const plan = this._planThinking();
    const extras = resolveAnthropicBetaExtras(this.opts.model, this.opts, false);

    const makeBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: this.opts.model,
        max_tokens: plan.maxTokens,
        system: buildAnthropicSystemBlocks(this.opts.systemPrompt, this._compressedSummary, this.opts.cacheTtl),
        messages: appendWorkspaceContextTail(withRollingCacheBreakpoint(stripUnsignedThinking(normalizeForProvider(this.messages)), this.opts.cacheTtl), this._workspaceContext),
        tools: this._buildAnthropicWireTools(),
        stream: true,
      };
      if (plan.temperature !== undefined) body["temperature"] = plan.temperature;
      applyAnthropicThinking(body, plan);
      Object.assign(body, extras.bodyExtras);
      if (extras.taskBudgetTokens) {
        const existingOutputConfig = body["output_config"] as Record<string, unknown> | undefined;
        body["output_config"] = { ...existingOutputConfig, task_budget: { type: "tokens", total: extras.taskBudgetTokens } };
      }
      return body;
    };
    let body = makeBody();

    const anthropicHeaders: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.opts.apiKey,
      "content-type": "application/json",
    };
    // claude-3-7 is the one model that still needs the interleaved-thinking beta header. Claude 4+
    // has it built in, and adaptive thinking enables interleaving on its own — so this only ever
    // applies to the budget dialect.
    const betas = extras.betas.slice();
    if (plan.thinking.kind === "budget" && /claude-3[-.]7/i.test(this.opts.model)) {
      betas.push("interleaved-thinking-2025-05-14");
    }
    if (betas.length > 0) anthropicHeaders["anthropic-beta"] = betas.join(",");
    const doFetch = (signal: AbortSignal | undefined): Promise<Response> => fetch(url, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body),
      signal,
    });
    let response = yield* this._fetchWithRetry("Anthropic", doFetch);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Strict tool marking is an optimization, never worth failing a run over: an endpoint
      // (or gateway) that rejects it gets one retry with the plain schemas, remembered for
      // the rest of the session — the same live-probe pattern as the Bedrock cachePoint check.
      if (!this._strictToolsUnsupported && AgentSession._looksLikeStrictRejection(response.status, text)) {
        this._strictToolsUnsupported = true;
        yield { type: "notice", level: "warn", message: "Strict tool schemas were rejected by the endpoint — retrying this turn without them." };
        body = makeBody();
        response = yield* this._fetchWithRetry("Anthropic", doFetch);
        if (!response.ok) {
          const retryText = await response.text().catch(() => "");
          throw new Error(`Anthropic ${response.status}: ${retryText.slice(0, 400)}`);
        }
      } else {
        throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`);
      }
    }
    if (!response.body) throw new Error("No response body from Anthropic");

    yield* this._parseAnthropicSSE(response.body);
  }

  /**
   * When server-side compaction fires, `usage.iterations` carries a per-iteration breakdown
   * (a `"compaction"` entry plus the normal `"message"` entry) and the plain top-level
   * `input_tokens`/`output_tokens` reflect only the message iteration — silently undercounting
   * real spend by whatever the compaction pass itself billed. Sum the array when present;
   * return null when absent so the caller falls back to the plain fields unchanged (the
   * exact placement of `iterations` in the streaming variant isn't documented, so this must
   * degrade to today's behavior rather than assume a location that turns out to be wrong).
   */
  private static _sumUsageIterations(usage: Record<string, unknown>): { input: number; output: number } | null {
    const iterations = usage["iterations"];
    if (!Array.isArray(iterations) || iterations.length === 0) return null;
    let input = 0;
    let output = 0;
    for (const entry of iterations) {
      if (!entry || typeof entry !== "object") continue;
      input += Number((entry as Record<string, unknown>)["input_tokens"] ?? 0);
      output += Number((entry as Record<string, unknown>)["output_tokens"] ?? 0);
    }
    return { input, output };
  }

  private async *_parseAnthropicSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderTurnStreamEvent> {
    const reader = response_body_reader(body, { idleMs: STREAM_IDLE_TIMEOUT_MS });
    const textAcc     = new Map<number, string>();
    const thinkingAcc = new Map<number, string>();
    const signatureAcc = new Map<number, string>();
    const redactedAcc = new Map<number, string>();
    const jsonAcc     = new Map<number, string>();
    const blockMeta   = new Map<number, { type: string; id: string; name: string }>();
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;

    for await (const line of reader) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(json) as Record<string, unknown>; } catch { continue; }

      const evType = String(ev["type"] ?? "");

      if (evType === "message_start") {
        const msg = ev["message"] as Record<string, unknown> | undefined;
        const usage = msg?.["usage"] as Record<string, unknown> | undefined;
        if (usage) {
          const iterations = AgentSession._sumUsageIterations(usage);
          inputTokens = iterations?.input ?? Number(usage["input_tokens"] ?? 0);
          cacheReadTokens = Number(usage["cache_read_input_tokens"] ?? 0);
          cacheWriteTokens = Number(usage["cache_creation_input_tokens"] ?? 0);
        }
      } else if (evType === "content_block_start") {
        const idx = Number(ev["index"]);
        const cb = ev["content_block"] as Record<string, unknown>;
        const cbType = String(cb["type"] ?? "");
        blockMeta.set(idx, { type: cbType, id: String(cb["id"] ?? ""), name: String(cb["name"] ?? "") });
        if (cbType === "text") textAcc.set(idx, "");
        if (cbType === "thinking") thinkingAcc.set(idx, "");
        if (cbType === "tool_use") jsonAcc.set(idx, "");
        // A redacted thinking block arrives complete in content_block_start — its encrypted payload
        // is in `data`, and no deltas follow. The parser previously had no case for this block type
        // at all, so it was dropped, and the assistant turn it belonged to replayed leading with
        // tool_use instead of its reasoning — a 400 on the next request.
        if (cbType === "redacted_thinking") redactedAcc.set(idx, String(cb["data"] ?? ""));
        // A refusal-fallback switch point (only appears when the session opted into
        // server-side fallbacks — see resolveAnthropicBetaExtras). Purely informational: the
        // block itself is an "ignored audit marker" per Anthropic's docs, so it needs no
        // accumulator entry — just surface which model took over.
        if (cbType === "fallback") {
          const from = (cb["from"] as Record<string, unknown> | undefined)?.["model"];
          const to = (cb["to"] as Record<string, unknown> | undefined)?.["model"];
          if (from || to) {
            yield { type: "notice", level: "warn", message: `${from ?? "The primary model"} declined this turn — continuing on ${to ?? "the fallback model"}.` };
          }
        }
      } else if (evType === "content_block_delta") {
        const idx = Number(ev["index"]);
        const delta = ev["delta"] as Record<string, unknown>;
        const dType = String(delta["type"] ?? "");
        if (dType === "text_delta") {
          const text = String(delta["text"] ?? "");
          textAcc.set(idx, (textAcc.get(idx) ?? "") + text);
          yield { type: "text_delta", text };
        } else if (dType === "thinking_delta") {
          const text = String(delta["thinking"] ?? "");
          thinkingAcc.set(idx, (thinkingAcc.get(idx) ?? "") + text);
          if (text) yield { type: "thinking_delta", text };
        } else if (dType === "signature_delta") {
          // The cryptographic signature for a thinking block arrives in its own delta.
          // Capture it so the block can be replayed to Anthropic verbatim — an unsigned
          // thinking block is rejected with a 400 once extended thinking is enabled.
          signatureAcc.set(idx, (signatureAcc.get(idx) ?? "") + String(delta["signature"] ?? ""));
        } else if (dType === "input_json_delta") {
          jsonAcc.set(idx, (jsonAcc.get(idx) ?? "") + String(delta["partial_json"] ?? ""));
        } else if (dType === "compaction_delta") {
          // Server-side compaction (beta compact-2026-01-12) is documented as non-incremental —
          // the full summary arrives in exactly one delta event, unlike text/thinking which
          // stream char-by-char. Yielding directly here (rather than accumulating into a map
          // and reading it at content_block_stop, as every other block type does) is safe only
          // because of that one-shot guarantee; if that ever changes, a second delta for the
          // same index would silently overwrite rather than append.
          const content = String(delta["content"] ?? "");
          if (content) yield { type: "compaction_block", content };
        }
      } else if (evType === "content_block_stop") {
        const idx = Number(ev["index"]);
        const meta = blockMeta.get(idx);
        if (meta?.type === "tool_use") {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(jsonAcc.get(idx) ?? "{}") as Record<string, unknown>; } catch { /* ignore */ }
          yield { type: "tool_use_block", block: { type: "tool_use", id: meta.id, name: meta.name, input } };
        } else if (meta?.type === "thinking") {
          const thinkingText = thinkingAcc.get(idx) ?? "";
          const signature = signatureAcc.get(idx) || undefined;
          // Emit on a signature even with no text. `display: "omitted"` (the default on Claude 4.7+)
          // streams thinking blocks whose text is empty — but the block is still a structural part
          // of the turn, and an assistant turn that made tool calls must lead with its reasoning on
          // replay. Requiring text here silently dropped it and earned a 400 on the next request.
          if (thinkingText || signature) yield { type: "thinking_block", text: thinkingText, signature };
        } else if (meta?.type === "redacted_thinking") {
          const data = redactedAcc.get(idx) ?? "";
          if (data) yield { type: "redacted_thinking_block", data };
        }
      } else if (evType === "message_delta") {
        const delta = ev["delta"] as Record<string, unknown>;
        const rawStopReason = String(delta["stop_reason"] ?? "end_turn");
        // stop_details is populated only on a refusal, and rides the same delta object as
        // stop_reason/stop_sequence. Surface it as a preceding notice so the generic "declined
        // to complete this response" diagnostic gets a specific category/explanation in front
        // of it, instead of leaving the operator to guess why.
        if (rawStopReason === "refusal") {
          const details = delta["stop_details"] as Record<string, unknown> | undefined;
          const category = details?.["category"];
          const explanation = details?.["explanation"];
          const parts = [
            typeof category === "string" && category ? `category: ${category}` : null,
            typeof explanation === "string" && explanation ? explanation : null,
          ].filter((p): p is string => p !== null);
          if (parts.length > 0) {
            yield { type: "notice", level: "warn", message: `Refusal details — ${parts.join("; ")}` };
          }
        }
        yield { type: "stop_reason", reason: normalizeAnthropicStopReason(rawStopReason) };
        const usage = ev["usage"] as Record<string, unknown> | undefined;
        if (usage) {
          const iterations = AgentSession._sumUsageIterations(usage);
          outputTokens = iterations?.output ?? Number(usage["output_tokens"] ?? 0);
          // The compaction pass's own input tokens are real spend that message_start's
          // pre-compaction snapshot couldn't have known about yet — only override upward
          // (never let a message_delta lacking iterations erase what message_start already
          // established from its own, possibly-present iterations breakdown).
          if (iterations) inputTokens = Math.max(inputTokens, iterations.input);
        }
      } else if (evType === "error") {
        // Anthropic (and Bedrock Mantle, which shares this parser) can send a mid-stream
        // `{"type":"error","error":{...}}` event — e.g. overloaded_error, api_error — after
        // already streaming partial content. Previously this matched none of the branches
        // above, so it was silently dropped: the connection closes right after with no
        // message_delta/stop_reason, and the turn completed as if it had ended cleanly with
        // whatever partial text/thinking had streamed so far (sometimes nothing at all).
        // Throwing a classified ProviderStreamError surfaces it through the turn-level retry
        // (overloaded_error → retried with backoff) or, if fatal, the turn error handling.
        throw anthropicStreamError(ev);
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage_update", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    }
  }

  // ── Bedrock (Converse) streaming ───────────────────────────────────────────

  private async *_streamTurnBedrock(): AsyncGenerator<ProviderTurnStreamEvent> {
    const credentials = this.opts.bedrock;
    if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");

    const plan = this._planThinking();
    const thinking = toBedrockThinking(plan.thinking);

    // Inject the live workspace block at the message tail, kept out of the systemPrompt field
    // so the Bedrock system/tools cache breakpoints stay stable. Critically, the block is
    // appended AFTER the rolling cache breakpoint (see appendBedrockWorkspaceContextTail).
    const baseBedrockMessages = toBedrockMessages(normalizeForProvider(this.messages));
    const buildConverseOpts = (useCache: boolean): ConverseOptions => ({
      credentials,
      modelId: this.opts.model,
      messages: appendBedrockWorkspaceContextTail(
        useCache ? withBedrockRollingCacheBreakpoint(baseBedrockMessages) : baseBedrockMessages,
        this._workspaceContext,
      ),
      systemPrompt: this.opts.systemPrompt,
      compressedSummary: this._compressedSummary || undefined,
      maxTokens: plan.maxTokens,
      temperature: plan.temperature,
      tools: useCache
        ? withBedrockToolsCacheBreakpoint(toBedrockTools(this._getTools()))
        : toBedrockTools(this._getTools()),
      thinking,
      effort: plan.effort,
    });

    // Transient failures — including the in-band throttle/overload frames that are unique to
    // Converse — are now retried uniformly by _runProviderTurnWithRetry, which re-runs this whole
    // generator from scratch. So the only thing left to handle here is the one case that layer
    // cannot: the cache-breakpoint capability probe.
    //
    // Some model/region/quota combinations reject requests containing cachePoint blocks, and
    // unlike the ARN context-length gap that can't be determined from the model id — so detect
    // the rejection live. Issuing the first frame forces the request, and because nothing has
    // been yielded to the caller yet, retrying without breakpoints is invisible. The result is
    // remembered for the rest of the session so we don't pay a failed round-trip every turn.
    if (this._signal?.aborted) throw makeAbortError();
    let iterator: AsyncIterator<BedrockConverseStreamEvent>;
    let firstResult: IteratorResult<BedrockConverseStreamEvent>;
    try {
      iterator = streamBedrockConverse(buildConverseOpts(!this._bedrockCacheUnsupported), this._signal)[Symbol.asyncIterator]();
      firstResult = await iterator.next();
    } catch (err) {
      if (this._bedrockCacheUnsupported || !isBedrockCacheValidationError(err)) throw err;
      this._bedrockCacheUnsupported = true;
      iterator = streamBedrockConverse(buildConverseOpts(false), this._signal)[Symbol.asyncIterator]();
      firstResult = await iterator.next();
    }

    async function* replay(): AsyncGenerator<BedrockConverseStreamEvent> {
      if (!firstResult.done) yield firstResult.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
    const stream = replay();

    // State keyed by Bedrock's contentBlockIndex. A reasoning block has no
    // contentBlockStart event (AWS documents starts as tool-use-only), so inferring it from
    // the start event loses its text/signature when the matching stop arrives. Keep the
    // per-index accumulators just like the Anthropic SSE parser above.
    const thinkingAcc = new Map<number, { text: string; signature?: string; redacted?: string }>();
    const toolUseAcc = new Map<number, { id: string; name: string; input: string }>();
    let stopReason: AgentStopReason = "end_turn";
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null = null;

    for await (const { eventType, data } of stream) {
      switch (eventType) {
        case "contentBlockStart": {
          const event = data["contentBlockStart"] as { start?: Record<string, unknown>; contentBlockIndex?: unknown } | undefined;
          const start = event?.start
            ?? (data["start"] as Record<string, unknown> | undefined);
          const index = Number(event?.contentBlockIndex ?? data["contentBlockIndex"] ?? 0);
          if (start?.["toolUse"]) {
            const tu = start["toolUse"] as { toolUseId?: string; name?: string };
            toolUseAcc.set(index, { id: tu.toolUseId ?? "", name: tu.name ?? "", input: "" });
          }
          break;
        }
        case "contentBlockDelta": {
          const event = data["contentBlockDelta"] as { delta?: Record<string, unknown>; contentBlockIndex?: unknown } | undefined;
          const delta = event?.delta
            ?? (data["delta"] as Record<string, unknown> | undefined);
          const index = Number(event?.contentBlockIndex ?? data["contentBlockIndex"] ?? 0);
          if (delta?.["reasoningContent"]) {
            // Converse splits reasoning across three delta shapes on the same index: `text`,
            // `signature`, and `redactedContent` (the safety-encrypted variant). All three must be
            // accumulated — a block whose payload arrives only as redactedContent still has to be
            // replayed, or the next turn leads with toolUse and Bedrock rejects it.
            const rc = delta["reasoningContent"] as Record<string, unknown>;
            const text = String(rc["text"] ?? "");
            const previous = thinkingAcc.get(index) ?? { text: "" };
            const redactedDelta = typeof rc["redactedContent"] === "string" ? rc["redactedContent"] : undefined;
            thinkingAcc.set(index, {
              text: previous.text + text,
              signature: typeof rc["signature"] === "string" ? rc["signature"] : previous.signature,
              redacted: redactedDelta !== undefined ? (previous.redacted ?? "") + redactedDelta : previous.redacted,
            });
            if (text) yield { type: "thinking_delta", text };
          } else if (delta?.["toolUse"]) {
            const toolUse = toolUseAcc.get(index);
            if (toolUse) toolUse.input += String((delta["toolUse"] as { input?: string }).input ?? "");
          } else if (typeof delta?.["text"] === "string") {
            yield { type: "text_delta", text: delta["text"] as string };
          }
          break;
        }
        case "contentBlockStop": {
          const event = data["contentBlockStop"] as { contentBlockIndex?: unknown } | undefined;
          const index = Number(event?.contentBlockIndex ?? data["contentBlockIndex"] ?? 0);
          const thinking = thinkingAcc.get(index);
          if (thinking) {
            if (thinking.redacted) {
              yield { type: "redacted_thinking_block", data: thinking.redacted };
            } else if (thinking.text || thinking.signature) {
              // Signature-without-text is emitted too: on Claude 4.7+ the default display is
              // "omitted", so reasoning arrives with an empty text field but still occupies a
              // structural slot the next request has to replay.
              yield { type: "thinking_block", text: thinking.text, signature: thinking.signature };
            }
            thinkingAcc.delete(index);
          } else {
            const toolUse = toolUseAcc.get(index);
            if (!toolUse) break;
            let input: Record<string, unknown> = {};
            try { if (toolUse.input) input = JSON.parse(toolUse.input) as Record<string, unknown>; } catch { /* ignore */ }
            yield { type: "tool_use_block", block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input } };
            toolUseAcc.delete(index);
          }
          break;
        }
        case "messageStop": {
          const raw = (data["messageStop"] as { stopReason?: string } | undefined)?.stopReason
            ?? (data["stopReason"] as string | undefined);
          stopReason = normalizeBedrockStopReason(String(raw ?? "end_turn"));
          break;
        }
        case "metadata": {
          type BedrockStreamUsage = {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
            cacheWriteInputTokens?: number;
          };
          const u = (data["metadata"] as { usage?: BedrockStreamUsage } | undefined)?.usage
            ?? (data["usage"] as BedrockStreamUsage | undefined);
          if (u) {
            usage = {
              inputTokens: Number(u.inputTokens ?? 0),
              outputTokens: Number(u.outputTokens ?? 0),
              cacheReadTokens: Number(u.cacheReadInputTokens ?? 0),
              cacheWriteTokens: Number(u.cacheWriteInputTokens ?? 0),
            };
          }
          break;
        }
        default:
          // Bedrock surfaces a mid-stream failure as a regular protocol frame tagged via the
          // `:exception-type` header (readEventFrame folds it into `eventType` — see
          // bedrock-client.ts), not as an HTTP error. Previously this had no case: the frame
          // was silently dropped, the stream ended right after with no messageStop, and the
          // turn completed as an apparently-successful but silently EMPTY end_turn — the
          // agent looked like it just said nothing, with no error surfaced anywhere. Throwing
          // here routes it through the turn-level retry (throttling/overload → backoff and
          // replay) or, if fatal, the turn error handling — instead of presenting a failure
          // as a normal empty response.
          {
            const frameError = bedrockStreamFrameError(eventType, data);
            if (frameError) throw frameError;
          }
          break;
      }
    }

    yield { type: "stop_reason", reason: stopReason };
    if (usage) {
      yield { type: "usage_update", ...usage };
    }
  }

  // ── Bedrock Mantle (Messages API) streaming ────────────────────────────────

  private async *_streamTurnBedrockMantle(): AsyncGenerator<ProviderTurnStreamEvent> {
    const credentials = this.opts.bedrock;
    if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");

    // Mantle is the Anthropic Messages API behind a SigV4-signed Bedrock endpoint, so it takes the
    // Messages thinking shape verbatim — including `output_config.effort`. It previously hardcoded
    // `{type: "adaptive"}` for every model, which 400s on the budget-era models (3.7 – 4.5) that
    // only accept `budget_tokens`; the plan below picks the dialect the selected model speaks.
    const plan = this._planThinking();
    const extras = resolveAnthropicBetaExtras(this.opts.model, this.opts, true);

    const url = `${mantleEndpoint(credentials.region)}/anthropic/v1/messages`;
    // Body + SigV4 signature are built together: a retry with different tools (the strict
    // fallback below) must re-sign, since the signature covers the payload hash.
    const makeRequest = (): { body: string; signedHeaders: Record<string, string> } => {
      const reqBody: Record<string, unknown> = {
        model: this.opts.model,
        max_tokens: plan.maxTokens,
        // Mantle uses the Anthropic Messages wire format — reuse the same cached-blocks
        // builder so the stable system-prompt head is cache-eligible here too.
        system: buildAnthropicSystemBlocks(this.opts.systemPrompt, this._compressedSummary, this.opts.cacheTtl),
        messages: appendWorkspaceContextTail(withRollingCacheBreakpoint(stripUnsignedThinking(normalizeForProvider(this.messages)), this.opts.cacheTtl), this._workspaceContext),
        tools: this._buildAnthropicWireTools(),
        stream: true,
      };
      if (plan.temperature !== undefined) reqBody["temperature"] = plan.temperature;
      applyAnthropicThinking(reqBody, plan);
      Object.assign(reqBody, extras.bodyExtras);
      const body = JSON.stringify(reqBody);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(extras.betas.length > 0 ? { "anthropic-beta": extras.betas.join(",") } : {}),
      };
      return { body, signedHeaders: signBedrockRequest(credentials, "POST", url, headers, body, "bedrock-mantle") };
    };
    let request = makeRequest();

    const doFetch = (signal: AbortSignal | undefined): Promise<Response> =>
      fetch(url, { method: "POST", headers: request.signedHeaders, body: request.body, signal });
    let response = yield* this._fetchWithRetry("Bedrock Mantle", doFetch);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Same strict-rejection fallback as the Anthropic-direct path — see _buildAnthropicWireTools.
      if (!this._strictToolsUnsupported && AgentSession._looksLikeStrictRejection(response.status, text)) {
        this._strictToolsUnsupported = true;
        yield { type: "notice", level: "warn", message: "Strict tool schemas were rejected by the endpoint — retrying this turn without them." };
        request = makeRequest();
        response = yield* this._fetchWithRetry("Bedrock Mantle", doFetch);
        if (!response.ok) {
          const retryText = await response.text().catch(() => "");
          throw new Error(`Bedrock Mantle ${response.status}: ${retryText.slice(0, 400)}`);
        }
      } else {
        throw new Error(`Bedrock Mantle ${response.status}: ${text.slice(0, 400)}`);
      }
    }
    if (!response.body) throw new Error("No response body from Bedrock Mantle");

    yield* this._parseAnthropicSSE(response.body);
  }

  // ── OpenAI / OpenRouter streaming ──────────────────────────────────────────

  private async *_streamTurnOpenAI(): AsyncGenerator<ProviderTurnStreamEvent> {
    const pd   = PROVIDER_DEFAULTS[this.provider as "openrouter" | "openai"];
    const url  = this.opts.baseUrl ?? pd.baseUrl;
    const effectiveSystem = this._compressedSummary
      ? `${this.opts.systemPrompt}\n\n---\n[COMPRESSED CONVERSATION HISTORY]\n${this._compressedSummary}\n---`
      : this.opts.systemPrompt;
    // Cache breakpoints must be placed BEFORE the volatile workspace-context tail is
    // appended, exactly like the direct Anthropic path (withRollingCacheBreakpoint before
    // appendWorkspaceContextTail): a breakpoint on per-turn content re-writes the whole
    // conversation at the cache-write premium every request and never gets a read hit.
    // So: convert history → mark stable breakpoints → append the volatile tail last.
    let msgs = toOpenAIMessages(normalizeForProvider(this.messages), effectiveSystem);
    // Claude/Gemini models behind OpenRouter honour explicit cache breakpoints (OpenAI
    // models cache automatically) — mark the static system prefix and the rolling tail so
    // those runs get the same prompt-cache economics as the direct Anthropic path.
    if (this.provider === "openrouter" && openRouterSupportsCacheControl(this.opts.model)) {
      msgs = withOpenRouterCacheControl(msgs, this.opts.cacheTtl);
    }
    msgs = appendOpenAIWorkspaceContextTail(msgs, this._workspaceContext);
    const tools = this._getTools().map(t => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const extraHeaders: Record<string, string> = {};
    if (this.provider === "openrouter") {
      extraHeaders["HTTP-Referer"] = this.opts.httpReferer ?? "https://blacksite.dev";
      extraHeaders["X-Title"] = this.opts.xTitle ?? "Blacksite";
    }

    // OpenAI reasoning models (o1/o3/o4, gpt-5 family) reject `max_tokens` and any
    // `temperature` other than the default — they require `max_completion_tokens`
    // and accept `reasoning_effort`. OpenRouter normalizes these, so only special-case
    // the direct OpenAI provider.
    const reasoning = this.provider === "openai" && isOpenAIReasoningModel(this.opts.model);
    // OpenRouter forwards its unified `reasoning` parameter to whatever the routed model natively
    // supports. For a Claude model that means Anthropic's own thinking config — so the same
    // per-model dialect rules apply here as on the direct path, and the plan below is what decides
    // between a token budget and an effort rung.
    const plan = this._planThinking();
    const maxTok = plan.maxTokens;

    const oaiBody: Record<string, unknown> = {
      model: this.opts.model,
      messages: msgs,
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    };
    // OpenAI's automatic prompt caching routes by prefix hash; a stable per-session key
    // steers every request of this conversation to the same cache shard, materially
    // raising hit rates for long agent runs (without it, load-balanced requests miss).
    if (this.provider === "openai") oaiBody["prompt_cache_key"] = this.sessionId;
    // Explicit processing tier (direct OpenAI only). "auto"/unset sends nothing, leaving
    // the account default in charge; "flex" buys reduced rates on flagship models at the
    // cost of queued latency — the fallback below handles the capacity-miss case.
    const serviceTier = this.provider === "openai" && this.opts.serviceTier && this.opts.serviceTier !== "auto"
      ? this.opts.serviceTier
      : undefined;
    if (serviceTier) oaiBody["service_tier"] = serviceTier;
    if (reasoning) {
      oaiBody["max_completion_tokens"] = maxTok;
      // Clamp to the model family's supported rungs so a persisted deep setting (e.g.
      // "xhigh") survives a switch to a model without it instead of 400ing every turn.
      const effort = resolveReasoningEffort(this.opts.model, this.opts.reasoningEffort);
      if (effort) oaiBody["reasoning_effort"] = effort;
    } else {
      oaiBody["max_tokens"] = maxTok;
      // plan.temperature, not opts.temperature: OpenRouter forwards this to the routed model, so a
      // Claude 4.7+/Sonnet 5 behind OpenRouter rejects it exactly as it would on the direct path.
      // (The plan leaves non-Claude models' temperature untouched, including OpenAI's 0–2 range.)
      if (plan.temperature !== undefined) oaiBody["temperature"] = plan.temperature;
    }
    // OpenRouter's unified `reasoning` parameter maps the user's thinking setting onto whatever the
    // routed model natively supports, and is ignored by models without reasoning — so the same
    // toggle that drives Anthropic/Bedrock extended thinking works here too. Which sub-field to
    // send is decided by the routed model, not by us: a token budget on an adaptive-era Claude
    // becomes `thinking.budget_tokens` downstream and 400s, so those models get an effort rung
    // instead. OpenRouter's effort vocabulary is low/medium/high, so the deeper Anthropic rungs
    // (xhigh, max) collapse to "high".
    if (this.provider === "openrouter") {
      if (plan.thinking.kind === "budget") {
        oaiBody["reasoning"] = { max_tokens: plan.thinking.budgetTokens };
      } else if (plan.thinking.kind === "adaptive") {
        const effort = plan.effort ?? DEFAULT_CLAUDE_EFFORT;
        oaiBody["reasoning"] = { effort: effort === "low" || effort === "medium" ? effort : "high" };
      } else if (resolveThinkingMode(this.opts.model) === "none" && this.opts.reasoningEffort) {
        // Non-Claude routed models (Gemini thinking, DeepSeek R1, GPT-5 via OR, …): the Claude
        // thinking plan above can never produce a reasoning param for these, so the user's
        // reasoning-effort setting drives the unified param directly. (This used to be sent as
        // a top-level `reasoning_effort` no UI could set for this provider — dead code — while
        // these models silently ran with reasoning at the routed model's default.) "none" maps
        // to sending nothing at all, since the unified param *enables* reasoning when present.
        const effort = toOpenRouterReasoningEffort(this.opts.reasoningEffort);
        if (effort) oaiBody["reasoning"] = { effort };
      }
      // Thinking off on a Claude model: send no `reasoning` at all. OpenRouter's unified param
      // *enables* reasoning on the routed model, so emitting an effort here would switch back on
      // what the user turned off. (Effort-without-thinking is expressible on the Anthropic-native
      // paths, not through this one.)

      // Model fallback list — OpenRouter tries these in order if the primary model is
      // rate-limited or unavailable, without the caller having to detect and retry itself.
      if (this.opts.openrouterFallbackModels?.length) {
        oaiBody["models"] = this.opts.openrouterFallbackModels;
      }
      // Provider-routing preferences — forwarded verbatim as OpenRouter's `provider` object.
      // Only include fields actually set, so an all-default preferences object sends nothing
      // rather than an empty `{}` that could be read as "restrict to zero providers".
      const routing = this.opts.openrouterProvider;
      if (routing) {
        const providerField: Record<string, unknown> = {};
        if (routing.order?.length) providerField["order"] = routing.order;
        if (routing.allowFallbacks !== undefined) providerField["allow_fallbacks"] = routing.allowFallbacks;
        if (routing.dataCollection) providerField["data_collection"] = routing.dataCollection;
        if (routing.sort) providerField["sort"] = routing.sort;
        if (Object.keys(providerField).length > 0) oaiBody["provider"] = providerField;
      }
    }

    // Serialized at call time so the flex fallback below can mutate oaiBody and re-fetch.
    const doFetch = (signal: AbortSignal | undefined): Promise<Response> => fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(oaiBody),
      signal,
    });

    let response = yield* this._fetchWithRetry(this.provider, doFetch);
    if (!response.ok && serviceTier) {
      if (response.status === 429) {
        // The requested tier was unavailable even after the standard retry/backoff cycle
        // (flex: no spare capacity; priority: a transient limit). Fall back to the account
        // default for THIS turn only — capacity misses are transient, so the next turn
        // tries the requested tier again — rather than failing the run over a cost/latency
        // preference.
        await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
        yield { type: "notice", level: "warn", message: `The "${serviceTier}" tier is unavailable right now — running this turn at the standard tier instead.` };
        delete oaiBody["service_tier"];
        response = yield* this._fetchWithRetry(this.provider, doFetch);
      } else if (response.status === 400) {
        // Flex/Priority availability is model-limited and changes over time (OpenAI's own
        // guidance calls it "limited model availability"), so rather than hard-failing the
        // run over a stale assumption about which models support it, detect the specific
        // "this model doesn't support that tier" rejection and retry once at the account
        // default. OpenAI names the rejected param in the error body, so this narrowly
        // targets that case — an unrelated 400 (bad tool schema, oversized request, …)
        // still surfaces as a real error instead of being silently retried.
        const text = await response.text().catch(() => "");
        if (/\bservice[_ ]tier\b/i.test(text)) {
          yield { type: "notice", level: "warn", message: `This model doesn't support the "${serviceTier}" processing tier — running this turn at the standard tier instead.` };
          delete oaiBody["service_tier"];
          response = yield* this._fetchWithRetry(this.provider, doFetch);
        } else {
          throw new Error(`${this.provider} ${response.status}: ${text.slice(0, 400)}`);
        }
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${this.provider} ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error(`No response body from ${this.provider}`);

    // Reassemble streamed tool-call fragments. Robust to providers that omit `index`
    // (which the old index-keyed map collapsed into one corrupt call) — see the accumulator.
    const toolCalls = new OpenAIToolCallAccumulator();
    let stopReason = "stop";
    let oaiInputTokens = 0;
    let oaiOutputTokens = 0;
    let oaiCachedTokens = 0;

    // Checked against the body, not the serviceTier const — the flex fallback above may
    // have dropped this request back to the standard tier (and its standard idle bound).
    const idleMs = oaiBody["service_tier"] === "flex" ? FLEX_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
    for await (const line of response_body_reader(response.body, { idleMs })) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") break;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(json) as Record<string, unknown>; } catch { continue; }

      // OpenRouter (and some OpenAI-compatible backends) can send a mid-stream error chunk
      // — `{"error":{"message":...,"code":...}}`, with no `choices` — after the HTTP response
      // already came back 200 and started streaming (the failure happens routing to the
      // underlying model). Previously this chunk had no `choices`, so `if (!choices?.length)
      // continue` silently skipped it, the stream then ended, and the turn completed as if
      // finished cleanly with whatever partial text had streamed (sometimes nothing). Throw
      // so it surfaces through the turn-level retry (429/5xx from the routed model) or, if
      // fatal, the turn error handling — instead of vanishing.
      const streamError = openAIStreamError(ev);
      if (streamError) throw streamError;

      // OpenAI sends usage in a final chunk (with stream_options.include_usage)
      const topUsage = ev["usage"] as Record<string, unknown> | undefined;
      if (topUsage) {
        oaiInputTokens  = Number(topUsage["prompt_tokens"] ?? 0);
        oaiOutputTokens = Number(topUsage["completion_tokens"] ?? 0);
        // OpenAI/OpenRouter auto-cache the prompt prefix server-side and report the hit under
        // prompt_tokens_details.cached_tokens — surface it so cache rate is visible in metrics.
        const details = topUsage["prompt_tokens_details"] as Record<string, unknown> | undefined;
        oaiCachedTokens = Number(details?.["cached_tokens"] ?? topUsage["cached_tokens"] ?? 0);
      }

      const choices = ev["choices"] as Array<Record<string, unknown>> | undefined;
      if (!choices?.length) continue;
      const choice = choices[0] as Record<string, unknown> | undefined;
      if (!choice) continue;
      const delta = choice["delta"] as Record<string, unknown> | undefined;
      const finishReason = choice["finish_reason"];
      if (finishReason) stopReason = String(finishReason);

      if (!delta) continue;

      // OpenRouter streams reasoning tokens under delta.reasoning when the unified
      // `reasoning` param is active. Display-only (thinking_delta): unlike Anthropic
      // thinking blocks, these are never replayed into the message history, so they
      // must not become thinking_block entries.
      const reasoningDelta = delta["reasoning"];
      if (typeof reasoningDelta === "string" && reasoningDelta) yield { type: "thinking_delta", text: reasoningDelta };

      const content = delta["content"];
      if (typeof content === "string" && content) yield { type: "text_delta", text: content };

      const toolCallDeltas = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
      if (toolCallDeltas) {
        for (const tcd of toolCallDeltas) toolCalls.push(tcd);
      }
    }

    // Emit reassembled tool calls
    for (const block of toolCalls.finish()) {
      yield { type: "tool_use_block", block };
    }

    yield { type: "stop_reason", reason: normalizeOpenAIStopReason(stopReason) };
    if (oaiInputTokens > 0 || oaiOutputTokens > 0) {
      // prompt_tokens already includes cached tokens; split them out so the total stays
      // consistent with the Anthropic accounting (input + cacheRead + cacheWrite = total).
      const cacheRead = Math.min(oaiCachedTokens, oaiInputTokens);
      yield { type: "usage_update", inputTokens: oaiInputTokens - cacheRead, outputTokens: oaiOutputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: 0 };
    }
  }

  // ── OpenAI Responses API (reasoning continuity across tool-call turns) ─────

  /**
   * Opt-in alternative to `_streamTurnOpenAI` for OpenAI reasoning models. The Chat Completions
   * API (used by `_streamTurnOpenAI`) has no way to replay a reasoning model's internal
   * reasoning state across a tool-call round trip — each call starts the model reasoning from
   * scratch about work it already reasoned through last turn. The Responses API's `reasoning`
   * output items carry an opaque `encrypted_content` payload that, replayed verbatim in the
   * next request's `input` array, preserves that continuity. Everything else about this method
   * mirrors `_streamTurnOpenAI` as closely as the two APIs' shapes allow (retry, flex-tier
   * fallback, idle timeout, prompt caching, service tier) — see that method's comments for the
   * reasoning behind each of those pieces; only what genuinely differs is re-explained here.
   *
   * Scope: first-party OpenAI only (the Responses API is not an OpenRouter/Bedrock/Anthropic
   * surface), custom function tools only (no built-in web_search/computer_use/file_search —
   * this harness doesn't use OpenAI's hosted tools), text + image input (no PDF/file input).
   */
  private async *_streamTurnOpenAIResponses(): AsyncGenerator<ProviderTurnStreamEvent> {
    // `opts.baseUrl` is documented and UI-labeled as the Chat Completions endpoint override
    // (used verbatim by `_streamTurnOpenAI`) — the Responses API lives at a sibling path, not
    // the same URL. Swap the well-known suffix so a proxy/Azure/local-server override still
    // resolves to the right endpoint; a baseUrl that doesn't end in it is respected as-is.
    const url = this.opts.baseUrl
      ? this.opts.baseUrl.replace(/\/chat\/completions\/?$/, "/responses")
      : "https://api.openai.com/v1/responses";
    const effectiveInstructions = this._compressedSummary
      ? `${this.opts.systemPrompt}\n\n---\n[COMPRESSED CONVERSATION HISTORY]\n${this._compressedSummary}\n---`
      : this.opts.systemPrompt;

    const plan = this._planThinking();
    const maxTok = plan.maxTokens;
    const reasoningEffort = resolveReasoningEffort(this.opts.model, this.opts.reasoningEffort);
    const tools = toResponsesTools(this._getTools());
    const serviceTier = this.opts.serviceTier && this.opts.serviceTier !== "auto" ? this.opts.serviceTier : undefined;

    const makeBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: this.opts.model,
        input: appendResponsesWorkspaceContextTail(
          toResponsesInputItems(normalizeForProvider(this.messages)),
          this._workspaceContext,
        ),
        instructions: effectiveInstructions,
        tools,
        tool_choice: "auto",
        stream: true,
        // We manage history client-side and replay reasoning items ourselves — server-side
        // storage/previous_response_id chaining is a different (stateful) integration model
        // this harness doesn't use. `include` is required to get encrypted_content back at
        // all when store is false.
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: maxTok,
        // Same rationale as the Chat Completions path: steers every request of this
        // conversation to the same cache shard for a materially higher hit rate.
        prompt_cache_key: this.sessionId,
      };
      if (reasoningEffort) body["reasoning"] = { effort: reasoningEffort, summary: "auto" };
      if (serviceTier) body["service_tier"] = serviceTier;
      return body;
    };
    const body = makeBody();

    const doFetch = (signal: AbortSignal | undefined): Promise<Response> => fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    let response = yield* this._fetchWithRetry("OpenAI Responses", doFetch);
    if (!response.ok && serviceTier) {
      // Mirrors _streamTurnOpenAI's flex/priority fallback exactly — see that method for why.
      if (response.status === 429) {
        await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
        yield { type: "notice", level: "warn", message: `The "${serviceTier}" tier is unavailable right now — running this turn at the standard tier instead.` };
        delete (body as Record<string, unknown>)["service_tier"];
        response = yield* this._fetchWithRetry("OpenAI Responses", doFetch);
      } else if (response.status === 400) {
        const text = await response.text().catch(() => "");
        if (/\bservice[_ ]tier\b/i.test(text)) {
          yield { type: "notice", level: "warn", message: `This model doesn't support the "${serviceTier}" processing tier — running this turn at the standard tier instead.` };
          delete (body as Record<string, unknown>)["service_tier"];
          response = yield* this._fetchWithRetry("OpenAI Responses", doFetch);
        } else {
          throw new Error(`OpenAI Responses ${response.status}: ${text.slice(0, 400)}`);
        }
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI Responses ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from OpenAI Responses");

    const idleMs = body["service_tier"] === "flex" ? FLEX_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
    yield* AgentSession._parseResponsesSSE(response_body_reader(response.body, { idleMs }));
  }

  /**
   * Parse the Responses API's SSE event stream. Unlike Anthropic's protocol (which requires
   * accumulating every block from incremental deltas), the Responses API hands back each
   * output item complete and final in its own `response.output_item.done` event — deltas here
   * are consumed only for live UI streaming (`text_delta`/`thinking_delta`), never as the
   * source of truth for the block a caller will persist. This is a deliberately more robust
   * design than manual accumulation: a delta shape this parser doesn't recognize can only cost
   * a moment of missing incremental UI feedback, never a corrupted final block.
   *
   * Terminal detection is driven by the `status` field inside whichever `response.*` event
   * carries a `response` object, rather than by matching an exact set of event-type strings —
   * `response.created`/`response.in_progress` naturally fall through (status "in_progress" or
   * "queued"), and `response.completed`/`response.incomplete`/`response.cancelled` all resolve
   * the same way once a real terminal status arrives. This degrades gracefully if a specific
   * discriminant string this comment doesn't name turns out to differ from what's implemented.
   */
  private static async *_parseResponsesSSE(lines: AsyncIterable<string>): AsyncGenerator<ProviderTurnStreamEvent> {
    let finished = false;
    for await (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(json) as Record<string, unknown>; } catch { continue; }

      const evType = String(ev["type"] ?? "");

      if (evType === "response.output_text.delta") {
        const text = String(ev["delta"] ?? "");
        if (text) yield { type: "text_delta", text };
      } else if (evType === "response.reasoning_summary_text.delta") {
        const text = String(ev["delta"] ?? "");
        if (text) yield { type: "thinking_delta", text };
      } else if (evType === "response.output_item.done") {
        const item = ev["item"] as Record<string, unknown> | undefined;
        if (!item) continue;
        const itemType = String(item["type"] ?? "");
        if (itemType === "reasoning") {
          const summaryParts = item["summary"] as Array<Record<string, unknown>> | undefined;
          const summaryText = (summaryParts ?? [])
            .map((p) => String(p["text"] ?? ""))
            .join("\n")
            .trim();
          const encryptedContent = typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
          const reasoningItemId = typeof item["id"] === "string" ? item["id"] : undefined;
          // Emitted even with an empty summary as long as there's an id/encrypted payload to
          // replay — an assistant turn that made tool calls must lead with its reasoning on
          // replay, the same rule the Anthropic-family thinking_block handling follows.
          if ((summaryText || encryptedContent) && reasoningItemId) {
            yield { type: "thinking_block", text: summaryText, encryptedContent, reasoningItemId };
          }
        } else if (itemType === "function_call") {
          const callId = String(item["call_id"] ?? item["id"] ?? "");
          const name = String(item["name"] ?? "");
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(String(item["arguments"] ?? "{}")) as Record<string, unknown>; } catch { /* partial/invalid JSON → empty; handled by truncation recovery */ }
          if (callId && name) yield { type: "tool_use_block", block: { type: "tool_use", id: callId, name, input } };
        }
        // "message" items: text already streamed via response.output_text.delta and is
        // accumulated by the caller from those events — nothing further needed here.
      } else if (evType === "error") {
        // A top-level stream error (not scoped to a specific response) — OpenAI's own
        // equivalent of Anthropic's mid-stream `{"type":"error",...}` event.
        const code = Number(ev["code"] ?? NaN);
        throw new ProviderStreamError(String(ev["message"] ?? "OpenAI Responses stream error"), Number.isFinite(code) && isRetryableStatus(code));
      } else if (evType.startsWith("response.")) {
        const resp = ev["response"];
        if (!resp || typeof resp !== "object") continue;
        const respObj = resp as Record<string, unknown>;
        const status = String(respObj["status"] ?? "");
        if (!status || status === "in_progress" || status === "queued") continue; // response.created etc. — not terminal
        if (status === "failed") {
          const error = respObj["error"] as Record<string, unknown> | undefined;
          throw new Error(`OpenAI Responses error: ${typeof error?.["message"] === "string" ? error["message"] : "response.failed"}`);
        }
        finished = true;
        yield { type: "stop_reason", reason: normalizeResponsesStopReason(respObj) };
        const usage = respObj["usage"] as Record<string, unknown> | undefined;
        if (usage) {
          const inputDetails = usage["input_tokens_details"] as Record<string, unknown> | undefined;
          const cacheRead = Number(inputDetails?.["cached_tokens"] ?? 0);
          const inputTotal = Number(usage["input_tokens"] ?? 0);
          yield {
            type: "usage_update",
            inputTokens: Math.max(0, inputTotal - cacheRead),
            outputTokens: Number(usage["output_tokens"] ?? 0),
            cacheReadTokens: cacheRead,
            cacheWriteTokens: Number(inputDetails?.["cache_write_tokens"] ?? 0),
          };
        }
      }
    }
    // A stream that closes without ever reaching a terminal response.* event (connection
    // dropped, [DONE] arrived early) must not present as a normal end_turn — the retry layer
    // needs to see this as a real failure to re-attempt, not silently succeed with an empty turn.
    if (!finished) throw new Error("OpenAI Responses stream ended without a terminal response event");
  }
}

// ── SSE line reader ────────────────────────────────────────────────────────────

class ProviderTurnEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

async function* response_body_reader(
  body: ReadableStream<Uint8Array>,
  opts: { idleMs?: number } = {},
): AsyncGenerator<string> {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  const idleMs  = opts.idleMs;
  let buffer    = "";
  let sawFirstChunk = false;
  try {
    while (true) {
      const read = reader.read();
      // A stalled provider (socket held open, no bytes) would otherwise hang the turn until
      // undici's coarse 300s body timeout. Race each read against a tighter idle timer so a
      // mid-stream stall becomes a prompt, surfaceable error. The timer resets on every chunk,
      // so an actively-streaming turn never trips it. Crucially it is NOT applied to the FIRST
      // chunk: a reasoning model (o1/o3, extended thinking) can legitimately be silent for a
      // while before its first token, and undici's header/body timeout already backstops a
      // connection that never produces anything at all.
      let result: Awaited<ReturnType<typeof reader.read>>;
      if (idleMs && idleMs > 0 && sawFirstChunk) {
        void read.catch(() => { /* settled via race/cancel below; avoid unhandledRejection */ });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new StreamIdleTimeoutError(`No stream data for ${Math.round(idleMs / 1000)}s`)),
            idleMs,
          );
        });
        try {
          result = await Promise.race([read, idle]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        result = await read;
      }
      const { done, value } = result;
      if (done) break;
      sawFirstChunk = true;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

// ── Anthropic → OpenAI message conversion ─────────────────────────────────────

/**
 * Guarantee referential integrity between tool_use and tool_result blocks before the
 * history is handed to any provider. A pair can lose one side when a compression
 * boundary falls between an assistant tool_use and its result (the result is kept while
 * its call is summarised away), or when a run is cancelled after the assistant tool_use
 * is recorded but before its results are appended. Every provider — OpenAI/OpenRouter,
 * Bedrock, and Anthropic — rejects such orphans with a 400 (e.g. OpenRouter's
 * "No tool call found for function call output with call_id …").
 *
 * - Drops tool_result blocks whose tool_use_id has no preceding tool_use.
 * - Synthesises a placeholder result for any tool_use that never received one, so an
 *   interrupted/trailing tool_use cannot strand an unanswered assistant tool_calls
 *   message.
 *
 * Applied at each send site rather than inside the converters so the converters stay
 * pure 1:1 mappers.
 */
type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

/**
 * Build a cache_control object honoring the session's chosen TTL. The default (5-minute) case
 * emits the bare `{type:"ephemeral"}` shape — byte-identical to the behavior before the TTL
 * option existed, so every existing cache-marking call site is a no-op change unless the
 * session opted into "1h".
 */
function cacheControlFor(ttl: CacheTtl | undefined): AnthropicCacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * Build the Anthropic `system` field as cache-eligible content blocks. The system prompt is
 * captured once per session (the workspace snapshot is frozen at session creation), so it is
 * byte-identical across every iteration of a run — marking it with a cache breakpoint lets the
 * whole prompt be re-read from cache instead of re-billed each turn. A growing compressed-history
 * summary rides in a separate, *uncached* block so that when it changes it invalidates only
 * itself, never the cached prompt — the core of keeping a clean, stable prompt head.
 */
export function buildAnthropicSystemBlocks(
  systemPrompt: string,
  compressedSummary: string,
  cacheTtl?: CacheTtl,
): Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }> {
  const blocks: Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }> = [
    { type: "text", text: systemPrompt, cache_control: cacheControlFor(cacheTtl) },
  ];
  if (compressedSummary) {
    blocks.push({
      type: "text",
      text: `---\n[COMPRESSED CONVERSATION HISTORY — earlier messages summarised for context efficiency]\n${compressedSummary}\n---`,
    });
  }
  return blocks;
}

/**
 * Add a rolling cache breakpoint to the final message so the entire conversation prefix is
 * re-read from cache on the next request. During a turn the agent makes many provider calls
 * seconds apart (one per tool round), each appending results to the tail — well inside the cache
 * TTL — so this is where a long-horizon (e.g. 1000-iteration) run recovers most of its input-token
 * cost. Only the last message is cloned/mutated; everything earlier is untouched.
 */
export function withRollingCacheBreakpoint(messages: AgentMessage[], cacheTtl?: CacheTtl): AgentMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  const blocks: ContentBlock[] = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : (last.content as ContentBlock[]).slice();
  if (blocks.length === 0) return messages;
  blocks[blocks.length - 1] = Object.assign(
    {},
    blocks[blocks.length - 1],
    { cache_control: cacheControlFor(cacheTtl) },
  ) as ContentBlock;
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

/**
 * Filters SERVICE_TOOLS to the provider families whose credentials are configured
 * (github/gitlab/jira/confluence/salesforce), so the advertised catalog reflects real
 * capability. An undefined set means "no credential info supplied" ⇒ advertise all
 * (back-compat for callers that don't resolve credentials up front).
 */
export function filterConfiguredServiceTools(configured: ReadonlySet<string> | undefined): ToolDefinition[] {
  if (!configured) return SERVICE_TOOLS;
  return SERVICE_TOOLS.filter((t) => configured.has(t.name.split("_")[0] ?? ""));
}

/**
 * Appends the live workspace-context block as a trailing text block on the last (user)
 * message, without persisting it into session history. Apply this AFTER
 * withRollingCacheBreakpoint so the block lands *past* the cache breakpoint: the static
 * system + tools + conversation prefix stays a cache hit, and only this small block —
 * which changes every turn — is re-read uncached. The input array is never mutated.
 */
export function appendWorkspaceContextTail(messages: AgentMessage[], workspaceContext: string): AgentMessage[] {
  if (!workspaceContext.trim() || messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  const ctxBlock: ContentBlock = { type: "text", text: workspaceContext };
  if (last.role === "user") {
    const blocks: ContentBlock[] = typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : (last.content as ContentBlock[]).slice();
    blocks.push(ctxBlock);
    out[out.length - 1] = { ...last, content: blocks };
  } else {
    // Defensive: the pre-call message is always a user turn in the send() loop, but if it
    // ever isn't, keep roles alternating rather than corrupting the assistant turn.
    out.push({ role: "user", content: [ctxBlock] });
  }
  return out;
}

/** True when a message is a user turn whose content carries a tool_result block. */
function messageCarriesToolResult(msg: AgentMessage | undefined): boolean {
  if (!msg || msg.role !== "user" || typeof msg.content === "string") return false;
  return (msg.content as ContentBlock[]).some((b) => b.type === "tool_result");
}

/**
 * Choose the index at which the "recent" (uncompressed) window begins so the compression
 * boundary never falls between an assistant tool_use and the user tool_result that answers it.
 * If `recent` began on a tool_result-bearing user message, that result's tool_use would be
 * swept into the compressed summary, orphaning it — which serialises to a fatal provider 400.
 * Walk the boundary earlier (keep slightly more recent history) until it starts cleanly.
 */
export function safeRecentStart(messages: AgentMessage[], keepRecent: number): number {
  let start = Math.max(0, messages.length - keepRecent);
  while (start > 0 && messageCarriesToolResult(messages[start])) start--;
  return start;
}

export function sanitizeToolMessages(messages: AgentMessage[]): AgentMessage[] {
  // tool_use ids that already have a result anywhere in the transcript.
  const satisfied = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_result") satisfied.add(block.tool_use_id);
      }
    }
  }

  const seenToolUse = new Set<string>();
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push(msg);
      continue;
    }
    const blocks = msg.content as ContentBlock[];

    if (msg.role === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") seenToolUse.add(block.id);
      }
      out.push(msg);

      // Answer any tool_use in this message that never got a result, so the assistant's
      // tool_calls are always satisfied on the next request.
      const unanswered = blocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use" && !satisfied.has(b.id),
      );
      if (unanswered.length > 0) {
        out.push({
          role: "user",
          content: unanswered.map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: JSON.stringify({ ok: false, error: "Tool result unavailable (run interrupted before completion)." }),
          })),
        });
        for (const b of unanswered) satisfied.add(b.id);
      }
      continue;
    }

    // user message: drop tool_result blocks that reference an unknown tool_use.
    const kept = blocks.filter(
      (b) => b.type !== "tool_result" || seenToolUse.has(b.tool_use_id),
    );
    if (kept.length === 0 && blocks.length > 0) continue; // was only orphan results
    out.push(kept.length === blocks.length ? msg : { ...msg, content: kept });
  }

  return out;
}

/**
 * Bedrock and Anthropic require the conversation to begin with a user message.
 * Compression can leave the recent window opening on an assistant tool_use turn,
 * which the provider rejects with a fatal 400 ("Expected toolResult blocks at
 * messages.0.content …" in the execution logs) that then recurs on every retry and
 * bricks the session. Prepend a minimal user turn so any boundary is valid. Applied
 * at the provider-send boundary, on top of {@link sanitizeToolMessages}.
 */
/**
 * Persisted copies of the transcript replace inline image data with a small text stub.
 * A single screenshot-heavy turn can otherwise re-serialize tens of MB of base64 into the
 * workspaceState memento on EVERY checkpoint save (the hot path runs once per iteration).
 * The pixels are dead weight once persisted anyway: compression and the memory index both
 * drop image blocks, so a restored session would never show them to the model again.
 */
export function stripImagesForPersistence(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    if (!msg.content.some((b) => b.type === "image")) return msg;
    return {
      ...msg,
      content: msg.content.map((b): ContentBlock =>
        b.type === "image"
          ? { type: "text", text: "[image omitted from persisted transcript]" }
          : b,
      ),
    };
  });
}

export function ensureLeadingUserMessage(messages: AgentMessage[]): AgentMessage[] {
  if (messages[0]?.role === "assistant") {
    return [{ role: "user", content: "[Conversation continues from summarized history above.]" }, ...messages];
  }
  return messages;
}

/** Stand-in for a message that carries no wire-valid content. Anthropic and Bedrock both reject
 *  an empty content array *and* a blank text block, so the placeholder must be non-empty. */
const EMPTY_TURN_PLACEHOLDER = "(no response)";

/** True for a block that survives serialization to every provider — i.e. anything except a
 *  text block that is empty/whitespace and an unsigned thinking block (which the Anthropic and
 *  Bedrock adapters both drop, since replaying one earns a 400). */
function isWireMeaningfulBlock(block: ContentBlock): boolean {
  if (block.type === "text") return block.text.trim().length > 0;
  // A thinking block only counts as meaningful once it carries something that must be
  // replayed verbatim — Anthropic's signature or the Responses API's encrypted reasoning
  // payload. A bare summary with neither is display-only and safe to drop.
  if (block.type === "thinking") {
    const t = block as ThinkingBlock;
    return !!t.signature || !!t.encryptedContent;
  }
  return true;
}

/** The assistant-turn twin of {@link fillEmptyMessageContent}, applied at record time so the
 *  transcript never contains a contentless turn in the first place. */
export function nonEmptyAssistantContent(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.some(isWireMeaningfulBlock)
    ? blocks
    : [{ type: "text", text: EMPTY_TURN_PLACEHOLDER }];
}

/** Substitute a placeholder for any message whose content would serialize to nothing.
 *
 *  A turn where the model returned no text, no thinking and no tool calls is recorded with an
 *  empty content array — and the empty-response recovery then *continues the run*, so that
 *  message is replayed on every subsequent request for the rest of the session. Anthropic
 *  rejects `content: []`; Bedrock's own guard turned it into a blank text block, which Converse
 *  rejects too. Either way one empty response permanently bricked the session, and neither error
 *  is retryable. (toOpenAIMessages already sidesteps this by skipping the message — it can,
 *  because OpenAI does not require strict role alternation. Bedrock does, so here we substitute
 *  rather than drop.) `_appendAssistantTurn` now prevents this at the source; this pass repairs
 *  transcripts that were persisted before that fix, or arrive from a checkpoint. */
export function fillEmptyMessageContent(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0 ? msg : { ...msg, content: EMPTY_TURN_PLACEHOLDER };
    }
    const blocks = msg.content as ContentBlock[];
    if (blocks.some(isWireMeaningfulBlock)) return msg;
    return { ...msg, content: [{ type: "text", text: EMPTY_TURN_PLACEHOLDER }] as ContentBlock[] };
  });
}

/** Sanitize tool pairing, repair contentless turns, and guarantee a user-first array — the full
 *  pre-send normalization. Shared by all four provider paths so a fix here lands everywhere. */
export function normalizeForProvider(messages: AgentMessage[]): AgentMessage[] {
  return ensureLeadingUserMessage(fillEmptyMessageContent(sanitizeToolMessages(messages)));
}

/**
 * Drop thinking blocks that carry no signature before sending to Anthropic (direct or
 * Mantle). A signed thinking block is replayed verbatim — required for interleaved
 * thinking across tool-use turns — while an unsigned one (e.g. a session persisted before
 * signatures were captured, or any block that lost its signature) would be rejected by
 * Anthropic's signature validation with a 400. Blocks other than thinking are untouched;
 * if stripping would leave an assistant turn with no content at all, a minimal text block
 * is substituted so the turn stays wire-valid.
 */
export function stripUnsignedThinking(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    const blocks = msg.content as ContentBlock[];
    const hasUnsigned = blocks.some((b) => b.type === "thinking" && !(b as ThinkingBlock).signature);
    if (!hasUnsigned) return msg;
    const kept = blocks.filter((b) => b.type !== "thinking" || !!(b as ThinkingBlock).signature);
    if (kept.length === 0) return { ...msg, content: [{ type: "text", text: "(reasoning omitted)" }] as ContentBlock[] };
    return { ...msg, content: kept };
  });
}

/**
 * Reassembles streamed OpenAI/OpenRouter tool-call fragments into complete tool_use blocks.
 *
 * The wire protocol keys each fragment by `index` (its slot in the `tool_calls` array): the
 * first fragment for an index carries `id` + `function.name`, later fragments append
 * `function.arguments`. But several OpenAI-compatible backends routed via OpenRouter omit
 * `index` (or send it inconsistently). The previous accumulator did `Number(index ?? 0)`,
 * collapsing every index-less fragment onto slot 0 — which merged two distinct parallel tool
 * calls into one corrupt call and dropped any call that never carried an id. This accumulator:
 *   - keys by `index` when present,
 *   - starts a new call whenever an `id` arrives (an id always marks a call boundary),
 *   - otherwise appends to the call currently in progress (the index-less streaming case),
 * and synthesizes an id at the end when a provider never supplied one, so downstream
 * tool_result pairing still works.
 */
export class OpenAIToolCallAccumulator {
  private readonly calls: Array<{ id: string; name: string; args: string }> = [];
  private readonly indexToPos = new Map<number, number>();
  private activePos = -1;

  push(delta: Record<string, unknown>): void {
    const idx = normalizeToolCallIndex(delta["index"]);
    const id = delta["id"] != null && delta["id"] !== "" ? String(delta["id"]) : undefined;
    const fn = delta["function"] as Record<string, unknown> | undefined;
    const name = fn?.["name"] != null ? String(fn["name"]) : undefined;
    const argFragment = fn?.["arguments"] != null ? String(fn["arguments"]) : "";

    let pos: number;
    if (idx !== undefined && this.indexToPos.has(idx)) {
      pos = this.indexToPos.get(idx)!;
    } else if (id !== undefined) {
      pos = this.calls.length;
      this.calls.push({ id, name: name ?? "", args: "" });
      if (idx !== undefined) this.indexToPos.set(idx, pos);
      this.activePos = pos;
    } else if (idx !== undefined) {
      pos = this.calls.length;
      this.calls.push({ id: "", name: name ?? "", args: "" });
      this.indexToPos.set(idx, pos);
      this.activePos = pos;
    } else if (this.activePos >= 0) {
      pos = this.activePos;
    } else {
      return; // fragment arrived before any call was established and carries no id — nothing to attach to
    }

    const call = this.calls[pos]!;
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    call.args += argFragment;
  }

  finish(): ToolUseBlock[] {
    const blocks: ToolUseBlock[] = [];
    this.calls.forEach((call, i) => {
      if (!call.name) return; // no function name ever arrived — unusable, drop it
      let input: Record<string, unknown> = {};
      try { if (call.args) input = JSON.parse(call.args) as Record<string, unknown>; } catch { /* partial/invalid JSON → empty; handled by the loop's truncation recovery */ }
      blocks.push({ type: "tool_use", id: call.id || `oai_call_${Date.now().toString(36)}_${i}`, name: call.name, input });
    });
    return blocks;
  }
}

function normalizeToolCallIndex(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/**
 * True when an OpenRouter model id routes to a provider that honours explicit
 * `cache_control` breakpoints (Anthropic and Gemini). Deliberately a conservative
 * allowlist: OpenRouter simply strips the field for providers that don't support it, so a
 * false positive is harmless, and a false negative just means today's status quo (no
 * explicit caching). OpenAI models cache automatically server-side either way.
 */
export function openRouterSupportsCacheControl(model: string): boolean {
  return /\b(anthropic|claude|gemini)\b/i.test(model);
}

// ── Strict tool use (Anthropic Messages API + Bedrock Mantle) ─────────────────

/**
 * Keywords the strict-tool-use validator is documented to accept. A whitelist rather than a
 * blocklist on purpose: a schema using anything outside it (numeric/string constraints,
 * $ref, if/then, patternProperties, …) is simply sent without `strict` — the status quo —
 * whereas a blocklist that missed one rejected keyword would 400 every turn of the session.
 */
const STRICT_ALLOWED_KEYWORDS = new Set([
  "type", "description", "title", "properties", "required", "additionalProperties",
  "items", "enum", "const", "anyOf", "allOf", "format",
]);

/** String formats the strict validator supports; anything else disqualifies the schema. */
const STRICT_ALLOWED_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid",
]);

/** Recursive worker for {@link toStrictToolSchema}: returns the strict-ready copy, or null. */
function toStrictSchemaNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const src = node as Record<string, unknown>;
  // A bare `{}` subschema means "anything" — free-form intent that strict cannot express.
  if (Object.keys(src).length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!STRICT_ALLOWED_KEYWORDS.has(key)) return null;
    out[key] = value;
  }
  if ("type" in out && typeof out["type"] !== "string") return null; // type arrays (["string","null"]) unsupported
  if (typeof out["format"] === "string" && !STRICT_ALLOWED_FORMATS.has(out["format"])) return null;

  if (out["items"] !== undefined) {
    const items = toStrictSchemaNode(out["items"]);
    if (!items) return null;
    out["items"] = items;
  }
  for (const combiner of ["anyOf", "allOf"] as const) {
    const list = out[combiner];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) return null;
    const mapped: Array<Record<string, unknown>> = [];
    for (const member of list) {
      const m = toStrictSchemaNode(member);
      if (!m) return null;
      mapped.push(m);
    }
    out[combiner] = mapped;
  }

  if (out["type"] === "object" || out["properties"] !== undefined) {
    const props = out["properties"];
    // An object with no declared properties is a free-form payload — forcing
    // additionalProperties:false onto it would forbid every key, silently breaking the tool.
    if (!props || typeof props !== "object" || Array.isArray(props) || Object.keys(props).length === 0) return null;
    const mappedProps: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      const m = toStrictSchemaNode(sub);
      if (!m) return null;
      mappedProps[name] = m;
    }
    out["properties"] = mappedProps;
    const ap = out["additionalProperties"];
    if (ap !== undefined && ap !== false) return null; // `true`/schema = free-form intent
    out["additionalProperties"] = false;
    if (out["required"] === undefined) out["required"] = [];
    else if (!Array.isArray(out["required"])) return null;
  }
  return out;
}

/**
 * Convert a tool input schema to the strict-tool-use dialect (deep copy — the session's tool
 * definitions are shared across providers and must not be mutated), or null when the schema
 * uses anything outside the documented strict subset. Strict guarantees the model's
 * `tool_use.input` validates against the schema exactly — malformed arguments stop being a
 * runtime coercion/repair problem and become impossible at the API level.
 */
export function toStrictToolSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  const out = toStrictSchemaNode(schema);
  return out && out["type"] === "object" ? out : null;
}

/**
 * Map the session tool list to Anthropic wire definitions, marking every tool whose schema
 * qualifies with `strict: true`. Non-qualifying tools are sent byte-identical to before —
 * mixed strict/non-strict lists are valid.
 */
export function withAnthropicStrictTools(
  tools: ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return tools.map(({ name, description, input_schema }) => {
    const strictSchema = toStrictToolSchema(input_schema);
    return strictSchema
      ? { name, description, input_schema: strictSchema, strict: true }
      : { name, description, input_schema };
  });
}

/**
 * OpenAI-format twin of appendWorkspaceContextTail: append the live workspace block as a
 * trailing user message AFTER any cache breakpoints were placed, so the stable
 * conversation prefix stays cache-eligible and only this per-turn block rides uncached.
 * A separate trailing user message (rather than fusing into the previous user text) keeps
 * the marked blocks byte-stable across tool rounds; OpenAI accepts consecutive same-role
 * messages and OpenRouter/Anthropic merge them into one turn. Never mutates the input.
 */
export function appendOpenAIWorkspaceContextTail(messages: OAIMessage[], workspaceContext: string): OAIMessage[] {
  if (!workspaceContext.trim() || messages.length === 0) return messages;
  return [...messages, { role: "user", content: workspaceContext }];
}

/**
 * Add Anthropic-style prompt-cache breakpoints to an OpenAI-format message array for
 * OpenRouter, which forwards `cache_control` on multipart text content to providers that
 * support it. Without this, a Claude/Gemini model driven through OpenRouter re-bills the
 * entire prompt every turn — the direct Anthropic/Bedrock paths have had these breakpoints
 * all along, and OpenRouter runs were paying full freight for the same tokens.
 *
 * Two breakpoints, mirroring the direct path's economics:
 *  - the system message (Anthropic orders tools before system, so this one breakpoint
 *    caches the entire static tools+system prefix), and
 *  - the last user message (rolling; everything before it — most of a long conversation —
 *    is re-read from cache on the next turn).
 * Tool-role messages are left untouched: OpenRouter only documents breakpoints on
 * system/user multipart text content. Never mutates the input array or its messages.
 */
export function withOpenRouterCacheControl(messages: OAIMessage[], cacheTtl?: CacheTtl): OAIMessage[] {
  const markLastTextPart = (msg: OAIMessage): OAIMessage => {
    if (typeof msg.content === "string") {
      return { ...msg, content: [{ type: "text", text: msg.content, cache_control: cacheControlFor(cacheTtl) }] };
    }
    if (!Array.isArray(msg.content)) return msg;
    const parts = msg.content.slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]!;
      if (part.type === "text") {
        parts[i] = { ...part, cache_control: cacheControlFor(cacheTtl) };
        return { ...msg, content: parts };
      }
    }
    return msg;
  };

  const out = messages.slice();
  const systemIdx = out.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) out[systemIdx] = markLastTextPart(out[systemIdx]!);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === "user") {
      out[i] = markLastTextPart(out[i]!);
      break;
    }
  }
  return out;
}

export function toOpenAIMessages(messages: AgentMessage[], systemPrompt: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: systemPrompt }];
  // OpenAI/OpenRouter reject a tool message ("function call output") whose tool_call_id has
  // no matching assistant tool_call — a fatal 400 that ends the whole run (observed in the
  // execution log as a protocol_violation). Track which call ids the assistant has actually
  // emitted, and which we've already answered, so a stray or duplicated tool_result can never
  // reach the provider. sanitizeToolMessages runs before this; these guards are defense-in-depth.
  const emittedCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        // May be a mix of tool_result + text + image blocks
        const toolResults = (msg.content as ContentBlock[]).filter((b): b is ToolResultBlock => b.type === "tool_result");
        const textBlocks  = (msg.content as ContentBlock[]).filter((b): b is TextBlock => b.type === "text");
        const imageBlocks = (msg.content as ContentBlock[]).filter((b): b is ImageBlock => b.type === "image");
        for (const tr of toolResults) {
          if (!emittedCallIds.has(tr.tool_use_id) || answeredCallIds.has(tr.tool_use_id)) continue;
          answeredCallIds.add(tr.tool_use_id);
          result.push({ role: "tool", content: tr.content, tool_call_id: tr.tool_use_id });
        }
        // Images can never live inside a tool-role message (OpenAI requires tool content
        // to be a plain string) — send them as a sibling user-role message instead.
        if (imageBlocks.length) {
          const parts: OAIContentPart[] = imageBlocks.map((ib) => ({
            type: "image_url",
            image_url: { url: `data:${ib.source.media_type};base64,${ib.source.data}` },
          }));
          if (textBlocks.length) parts.push({ type: "text", text: textBlocks.map((t) => t.text).join("\n") });
          result.push({ role: "user", content: parts });
        } else if (textBlocks.length) {
          result.push({ role: "user", content: textBlocks.map((t) => t.text).join("\n") });
        }
      }
    } else {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else {
        const textBlocks = (msg.content as ContentBlock[]).filter((b): b is TextBlock => b.type === "text");
        const toolBlocks = (msg.content as ContentBlock[]).filter((b): b is ToolUseBlock => b.type === "tool_use");
        const content = textBlocks.map((t) => t.text).join("\n") || null;
        const tool_calls = toolBlocks.length > 0 ? toolBlocks.map((tb) => {
          emittedCallIds.add(tb.id);
          return {
            id:       tb.id,
            type:     "function" as const,
            function: { name: tb.name, arguments: JSON.stringify(tb.input) },
          };
        }) : undefined;
        // A bare {role:assistant, content:null} with no tool calls contributes nothing and can
        // desync tool pairing on some providers — skip it entirely.
        if (content === null && !tool_calls) continue;
        result.push({ role: "assistant", content, tool_calls });
      }
    }
  }

  return result;
}

// ── OpenAI Responses API conversion ─────────────────────────────────────────
//
// The Responses API's `input`/`output` are flat arrays of heterogeneous items (message |
// function_call | function_call_output | reasoning | ...) rather than Chat Completions' nested
// per-turn message objects — a tool call and its result are each their own top-level item,
// matched by `call_id` (this harness's `tool_use.id` / `tool_result.tool_use_id`).

/** Flat function-tool shape: `{type, name, description, parameters}`, not Chat Completions'
 *  `{type:"function", function:{name,...}}` nesting. No `strict` — OpenAI's strict-mode schema
 *  rules differ from Anthropic's (see toStrictToolSchema) and are out of scope here. */
export function toResponsesTools(
  tools: ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return tools.map(({ name, description, input_schema }) => ({
    type: "function",
    name,
    description,
    parameters: input_schema,
  }));
}

/**
 * Convert session history into the Responses API's flat `input` item array.
 *
 * Reasoning items only round-trip when they carry a `reasoningItemId` — the discriminator for
 * "this came from the Responses API itself" versus an Anthropic-origin thinking block (which
 * carries `signature` instead and means nothing to this API). Compaction blocks are similarly
 * Anthropic-only and are silently skipped. This mirrors toOpenAIMessages' existing "OpenAI-
 * compatible paths do not round-trip foreign thinking" behavior, narrowed to recognize this
 * path's own reasoning items as the one exception worth replaying.
 */
export function toResponsesInputItems(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  // Same defense-in-depth as toOpenAIMessages: never emit a function_call_output whose call_id
  // wasn't actually emitted by a function_call item in this same converted array, and never
  // answer the same call_id twice.
  const emittedCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content) items.push({ type: "message", role: "user", content: msg.content });
        continue;
      }
      const blocks = msg.content as ContentBlock[];
      const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
      const textBlocks  = blocks.filter((b): b is TextBlock => b.type === "text");
      const imageBlocks = blocks.filter((b): b is ImageBlock => b.type === "image");
      for (const tr of toolResults) {
        if (!emittedCallIds.has(tr.tool_use_id) || answeredCallIds.has(tr.tool_use_id)) continue;
        answeredCallIds.add(tr.tool_use_id);
        items.push({ type: "function_call_output", call_id: tr.tool_use_id, output: tr.content });
      }
      if (imageBlocks.length) {
        const content: Array<Record<string, unknown>> = imageBlocks.map((ib) => ({
          type: "input_image",
          image_url: `data:${ib.source.media_type};base64,${ib.source.data}`,
          detail: "auto",
        }));
        if (textBlocks.length) content.push({ type: "input_text", text: textBlocks.map((t) => t.text).join("\n") });
        items.push({ type: "message", role: "user", content });
      } else if (textBlocks.length) {
        items.push({ type: "message", role: "user", content: textBlocks.map((t) => t.text).join("\n") });
      }
    } else {
      if (typeof msg.content === "string") {
        if (msg.content) items.push({ type: "message", role: "assistant", content: msg.content });
        continue;
      }
      const blocks = msg.content as ContentBlock[];
      // Reasoning leads the turn it belongs to, matching how _appendAssistantTurn already
      // orders history (reasoning, then text, then tool calls) — so iterating in the blocks'
      // stored order already replays reasoning ahead of the tool calls it informed.
      for (const block of blocks) {
        if (block.type !== "thinking" || !block.reasoningItemId) continue;
        const summary = block.thinking ? [{ type: "summary_text", text: block.thinking }] : [];
        items.push({
          type: "reasoning",
          id: block.reasoningItemId,
          summary,
          ...(block.encryptedContent ? { encrypted_content: block.encryptedContent } : {}),
        });
      }
      const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");
      if (textBlocks.length) items.push({ type: "message", role: "assistant", content: textBlocks.map((t) => t.text).join("\n") });
      const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      for (const tb of toolBlocks) {
        emittedCallIds.add(tb.id);
        items.push({ type: "function_call", call_id: tb.id, name: tb.name, arguments: JSON.stringify(tb.input) });
      }
    }
  }

  return items;
}

/** Responses-API twin of appendOpenAIWorkspaceContextTail: append the live workspace block as
 *  a trailing user input item, after history conversion. */
export function appendResponsesWorkspaceContextTail(items: Array<Record<string, unknown>>, workspaceContext: string): Array<Record<string, unknown>> {
  if (!workspaceContext.trim() || items.length === 0) return items;
  return [...items, { type: "message", role: "user", content: workspaceContext }];
}

/**
 * Map a terminal Responses API `response` object to a harness stop reason. Priority mirrors
 * the Chat Completions/Anthropic paths: any function_call output means "tool_use" regardless
 * of what else is present, a refusal (either a `content_filter` incomplete reason or a
 * `refusal`-typed message content part) is terminal-but-declined, `max_output_tokens` maps to
 * the truncation-recovery path, and anything else unrecognized fails open into
 * protocol_violation rather than silently reporting success.
 */
export function normalizeResponsesStopReason(resp: Record<string, unknown>): AgentStopReason {
  const status = String(resp["status"] ?? "");
  const output = Array.isArray(resp["output"]) ? (resp["output"] as Array<Record<string, unknown>>) : [];
  const hasFunctionCall = output.some((item) => item["type"] === "function_call");
  const hasRefusal = output.some((item) =>
    item["type"] === "message"
    && Array.isArray(item["content"])
    && (item["content"] as Array<Record<string, unknown>>).some((part) => part["type"] === "refusal"));

  if (hasFunctionCall) return "tool_use";
  if (hasRefusal) return "refusal";
  if (status === "incomplete") {
    const reason = (resp["incomplete_details"] as Record<string, unknown> | undefined)?.["reason"];
    if (reason === "max_output_tokens") return "max_tokens";
    if (reason === "content_filter") return "refusal";
    return "protocol_violation";
  }
  if (status === "completed") return "end_turn";
  if (status === "cancelled") return "cancelled";
  return "protocol_violation";
}

// ── Anthropic → Bedrock (Converse) conversion ─────────────────────────────────

/** Bedrock rejects empty text blocks AND empty content arrays; guarantee ≥1 *non-blank* block.
 *
 *  The fallback used to be `{ text: "" }` — which is itself a blank text block, i.e. precisely
 *  the thing this function exists to prevent. Converse answers it with
 *  `ValidationException: The text field in the ContentBlock object at messages.N.content.0 is
 *  blank`, a non-retryable 400. normalizeForProvider now substitutes a placeholder upstream, so
 *  this should be unreachable; it stays correct as defense-in-depth rather than trading one
 *  fatal shape for another. */
function nonEmptyBedrockContent(blocks: BedrockContentBlock[]): BedrockContentBlock[] {
  const filtered = blocks.filter((b) => !("text" in b) || b.text.trim().length > 0);
  return filtered.length > 0 ? filtered : [{ text: EMPTY_TURN_PLACEHOLDER }];
}

function bedrockImageFormat(mediaType: string): BedrockImageFormat {
  const sub = mediaType.split("/")[1]?.toLowerCase();
  return sub === "jpeg" || sub === "jpg" ? "jpeg" : sub === "gif" ? "gif" : sub === "webp" ? "webp" : "png";
}

export function toBedrockMessages(messages: AgentMessage[]): BedrockMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: nonEmptyBedrockContent([{ text: msg.content }]) };
    }

    const blocks: BedrockContentBlock[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "text") {
        blocks.push({ text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.input } });
      } else if (block.type === "tool_result") {
        blocks.push({ toolResult: { toolUseId: block.tool_use_id, content: [{ text: block.content }] } });
      } else if (block.type === "image") {
        blocks.push({ image: { format: bedrockImageFormat(block.source.media_type), source: { bytes: block.source.data } } });
      } else if (block.type === "thinking") {
        // Converse requires the generated reasoning text *and* its signature to be replayed
        // verbatim on subsequent turns. Omitting it discards the model's interleaved-thought
        // context; replaying an old unsigned block earns a 400, so legacy blocks are skipped.
        if (block.signature) {
          blocks.push({ reasoningContent: { reasoningText: { text: block.thinking, signature: block.signature } } });
        }
      } else if (block.type === "redacted_thinking") {
        blocks.push({ reasoningContent: { redactedContent: block.data } });
      }
    }
    return { role: msg.role, content: nonEmptyBedrockContent(blocks) };
  });
}

/**
 * Add a rolling cache breakpoint to the final Bedrock message, mirroring
 * withRollingCacheBreakpoint for the Anthropic-direct/Mantle paths. Without this the
 * native Converse path only ever cached the static system-prompt block (buildRequestBody's
 * one hardcoded cachePoint) — the message history, which holds most of a long agent
 * conversation's tokens, was resent uncached on every turn.
 */
export function withBedrockRollingCacheBreakpoint(messages: BedrockMessage[]): BedrockMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  if (last.content.length === 0) return messages;
  out[out.length - 1] = { ...last, content: [...last.content, { cachePoint: { type: "default" } }] };
  return out;
}

/**
 * Bedrock/Converse twin of appendWorkspaceContextTail: appends the live workspace block as a
 * trailing text block on the final (user) message. Apply this AFTER withBedrockRollingCacheBreakpoint
 * so the block lands *past* the cachePoint — the stable message-history prefix stays a cache hit and
 * only this per-turn block is re-read uncached, exactly like the compressed-summary-after-cachePoint
 * pattern in bedrock-client. Converse requires strict user/assistant alternation, so the block can
 * only ride on the trailing message's content, never a fresh user turn — if the last message somehow
 * isn't a user turn, it is left untouched rather than corrupting an assistant turn. Never mutates input.
 */
export function appendBedrockWorkspaceContextTail(messages: BedrockMessage[], workspaceContext: string): BedrockMessage[] {
  if (!workspaceContext.trim() || messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  if (last.role !== "user") return messages;
  out[out.length - 1] = { ...last, content: [...last.content, { text: workspaceContext }] };
  return out;
}

export function toBedrockTools(tools: ToolDefinition[]): BedrockToolDef[] {
  return tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } },
  }));
}

/** Append a cachePoint entry after the tool list so the (large, stable) tool schema
 *  block is cache-eligible too, mirroring the Anthropic/Mantle paths' last-tool marker. */
export function withBedrockToolsCacheBreakpoint(
  tools: BedrockToolDef[],
): Array<BedrockToolDef | BedrockCachePoint> {
  if (tools.length === 0) return tools;
  return [...tools, { cachePoint: { type: "default" } }];
}

/**
 * True when a Bedrock error looks like it was caused by the request's cache
 * breakpoints being rejected (a 4xx validation error mentioning "cache"), as opposed
 * to an unrelated failure (auth, throttling, network) that a cache-less retry
 * wouldn't fix. Deliberately narrow so unrelated errors surface immediately instead
 * of being masked by a pointless retry.
 */
export function isBedrockCacheValidationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Bedrock 4\d\d/.test(message) && /cache/i.test(message);
}

/**
 * Bedrock ConverseStream failure frame types (AWS's documented Smithy exception shapes for
 * this operation). Each arrives via the `:exception-type` header rather than an HTTP error,
 * so a mid-stream throttle/overload/validation failure looks exactly like a normal frame
 * unless the eventType is checked against this set — see the `default` case in
 * `_streamTurnBedrock`'s switch.
 */
const BEDROCK_STREAM_EXCEPTION_TYPES = new Set([
  "internalServerException",
  "modelStreamErrorException",
  "validationException",
  "throttlingException",
  "serviceUnavailableException",
  "modelTimeoutException",
  "modelNotReadyException",
  "resourceNotFoundException",
  "accessDeniedException",
]);

/**
 * The subset of the above that is transient. This is the crux of why Bedrock ran so much less
 * reliably than the other providers: AWS delivers throttles and capacity failures *in-band*, as
 * frames inside an already-200 stream, where the other providers deliver them as a pre-stream
 * 429/5xx that `_fetchWithRetry` absorbs. Classified as retryable, they now re-enter the same
 * backoff cycle as every other transient provider failure instead of ending the run.
 *
 * Deliberately excludes validation/resourceNotFound/accessDenied: those mean the *request* is
 * wrong, and replaying it unchanged can only reproduce the failure.
 */
const BEDROCK_RETRYABLE_STREAM_EXCEPTIONS = new Set([
  "internalServerException",
  "modelStreamErrorException",
  "throttlingException",
  "serviceUnavailableException",
  "modelTimeoutException",
  "modelNotReadyException",
]);

/**
 * Classify a decoded Bedrock ConverseStream frame: returns a {@link ProviderStreamError} when
 * `eventType` is one of `BEDROCK_STREAM_EXCEPTION_TYPES`, `null` for a normal content frame.
 * Exported pure function, same pattern as `isBedrockCacheValidationError` — testable directly
 * without driving the private `_streamTurnBedrock` streaming method.
 */
export function bedrockStreamFrameError(eventType: string, data: Record<string, unknown>): ProviderStreamError | null {
  if (!BEDROCK_STREAM_EXCEPTION_TYPES.has(eventType)) return null;
  const message = typeof data["message"] === "string" ? data["message"] : eventType;
  return new ProviderStreamError(
    `Bedrock stream error (${eventType}): ${message}`,
    BEDROCK_RETRYABLE_STREAM_EXCEPTIONS.has(eventType),
  );
}

export function normalizeBedrockStopReason(reason: string): AgentStopReason {
  switch (reason) {
    case "tool_use":      return "tool_use";
    case "max_tokens":    return "max_tokens";
    case "end_turn":
    case "stop_sequence": return "end_turn";
    // Documented Converse stop reasons for a response the service declined to complete on
    // content grounds. Previously these fell into `default` → protocol_violation, which the
    // truncation-recovery path reads as a cut-off response and retries with a doubled output
    // budget — re-provoking the same guardrail every time. See AgentStopReason."refusal".
    case "guardrail_intervened":
    case "content_filtered": return "refusal";
    default:                 return "protocol_violation";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function isConfirmationRequired(result: unknown): boolean {
  return result !== null && typeof result === "object" && "requiresConfirmation" in result
    && (result as Record<string, unknown>)["requiresConfirmation"] === true;
}

/**
 * Extract the tool result from a runtime JSON-RPC response, converting the *error* shape
 * (which carries no `result`) into a clean `{ ok: false, error }` the model can act on —
 * rather than letting `undefined` propagate into JSON.stringify and crash the turn. A
 * JSON-RPC "method not found" (-32601) means the model called a tool this session doesn't
 * expose (typically a hallucinated name), so it gets a targeted, self-correcting message.
 */
function runtimeResultOrError(resp: unknown, toolName: string, advertisedNames?: () => string[]): unknown {
  const r = resp as { result?: unknown; error?: { code?: number; message?: string } } | null;
  if (r && r.result !== undefined) return r.result;
  if (r && r.error) {
    if (r.error.code === -32601) {
      // Suggest only from the tools this session actually advertises — recommending a
      // disabled/unavailable tool would send the model straight into a second rejection.
      const suggestion = suggestToolName(toolName, advertisedNames?.());
      return {
        ok: false,
        error: `Unknown tool "${toolName}" — it is not available in this session.`
          + (suggestion ? ` Did you mean "${suggestion}"?` : "")
          + " Re-check the tool list and call one of the advertised tools by its exact name.",
      };
    }
    return { ok: false, error: r.error.message ?? "Tool runtime error." };
  }
  return { ok: false, error: "Tool returned no result." };
}

function isOk(result: unknown): boolean {
  return typeof result === "object" && result !== null
    && (result as Record<string, unknown>)["ok"] === true;
}

/** An AbortError, thrown when a retry loop notices the run was cancelled between attempts. */
function makeAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Human-readable backoff delay for a retry notice ("800ms", "3s"). */
function formatDelay(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Parses a "data:<mediaType>;base64,<data>" URL, as produced by reference_zoom_image. */
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  return match ? { mediaType: match[1]!, data: match[2]! } : null;
}

export function summarizeResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return "Done";
  const r = result as Record<string, unknown>;
  if (typeof r["progress"] === "string") return r["progress"] as string;
  if (typeof r["planId"] === "string") return `plan ${r["planId"] as string}`;
  if (typeof r["todoId"] === "string") return `task items ${r["todoId"] as string}`;
  if (typeof r["content"]  === "string") return `${(r["content"] as string).slice(0, 80)}…`;
  if (typeof r["path"]     === "string") return r["path"] as string;
  if (typeof r["exitCode"] === "number") return `exit ${r["exitCode"] as number}`;
  // A shell_run/process spawn failure (ENOENT, EACCES, …) resolves exitCode to null rather
  // than a number — see runShellCommand's "error" listener in packages/local-runtime/src/shell.ts.
  // Without this branch that falls through to the generic "OK" below, indistinguishable from a
  // command that actually ran and succeeded. A timeout kill also yields exitCode: null, but is
  // already self-describing via timedOut, so it's excluded here rather than double-reported.
  if (r["exitCode"] === null && r["timedOut"] !== true && typeof r["stderr"] === "string") {
    const stderr = (r["stderr"] as string).trim();
    return stderr ? `spawn failed: ${stderr.slice(0, 80)}` : "spawn failed";
  }
  if (typeof r["planCount"] === "number") return `${r["planCount"] as number} plan(s)`;
  if (typeof r["runCount"] === "number") return `${r["runCount"] as number} task run(s)`;
  if (Array.isArray(r["results"])) return `${(r["results"] as unknown[]).length} result(s)`;
  if (Array.isArray(r["entries"])) return `${(r["entries"] as unknown[]).length} entries`;
  if (Array.isArray(r["commits"])) return `${(r["commits"] as unknown[]).length} commit(s)`;
  return "OK";
}

/** Deterministic JSON for loop detection: model tool arguments are objects, whose insertion
 * order must not turn the same request into a fake "new" step. Values that JSON itself omits
 * (undefined/functions) are normalized the same way as a normal JSON request payload. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeSubagentSpawnInput(payload: Record<string, unknown>): SubagentSpawnInput {
  const complexity = String(payload["complexity"] ?? "").trim().toLowerCase();
  const profileId = payload["profileId"] != null ? String(payload["profileId"]).trim() : undefined;
  const planId = payload["planId"] != null ? String(payload["planId"]).trim() : "";
  const phaseId = payload["phaseId"] != null ? String(payload["phaseId"]).trim() : "";
  const stepId = payload["stepId"] != null ? String(payload["stepId"]).trim() : "";
  return {
    task: String(payload["task"] ?? ""),
    context: payload["context"] != null ? String(payload["context"]) : undefined,
    complexity: complexity === "standard" || complexity === "complex" || complexity === "deep"
      ? complexity
      : "auto",
    label: payload["label"] != null ? String(payload["label"]) : undefined,
    parallel: payload["parallel"] === true || payload["parallel"] === "true",
    profileId: profileId || undefined,
    // Only meaningful as a complete triple — a partial link (e.g. planId with no stepId)
    // can't identify a step, so it's dropped rather than silently syncing the wrong thing.
    planId: planId && phaseId && stepId ? planId : undefined,
    phaseId: planId && phaseId && stepId ? phaseId : undefined,
    stepId: planId && phaseId && stepId ? stepId : undefined,
  };
}

function isParallelSubagent(tc: ToolUseBlock): boolean {
  const dispatch = resolveToolDispatch(tc.name, tc.input);
  if (dispatch.runtimeType !== "subagent.spawn") return false;
  const input = normalizeSubagentSpawnInput(dispatch.payload);
  return input.parallel === true;
}


async function* mergeAsyncGenerators<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
  const queue: T[] = [];
  let resolveNext: (() => void) | null = null;
  let activeCount = generators.length;
  let errorOccurred: unknown = null;

  const startGenerator = async (gen: AsyncGenerator<T>) => {
    try {
      for await (const val of gen) {
        queue.push(val);
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      }
    } catch (err) {
      errorOccurred = err;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    } finally {
      activeCount--;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    }
  };

  // Deliberately not awaited: each generator's own try/catch/finally funnels
  // completion and errors into activeCount/errorOccurred/queue for the loop below.
  generators.forEach((gen) => void startGenerator(gen));

  while (activeCount > 0 || queue.length > 0) {
    if (errorOccurred) {
      throw errorOccurred;
    }
    if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }
  if (errorOccurred) {
    throw errorOccurred;
  }
}
