import type * as vscode from "vscode";
import type { LocalRuntime } from "@blacksite/local-runtime";
import {
  WORKSPACE_TOOLS, MEMORY_TOOLS, DIAGNOSTICS_TOOLS, CODE_INTEL_TOOLS, GIT_TOOLS, TEST_TOOLS, WORKTREE_TOOLS, SUBAGENT_TOOLS, SERVICE_TOOLS, BROWSER_TOOLS, UI_TOOLS, PLANNING_TOOLS, GRAPH_TOOLS, DATA_TOOLS, TRANSCRIPT_TOOLS, TRANSCRIPT_DOCUMENT_TOOLS, AGENT_MEMORY_TOOLS, RESULT_PAGING_TOOLS, REFERENCE_TOOLS,
  resolveToolDispatch,
  validateToolInput,
  coerceToolInput,
  suggestToolName,
} from "./tools/definitions.js";
import type { ToolDefinition, QCardOption } from "./tools/definitions.js";
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
import type { ConverseOptions } from "./bedrock-client.js";
import {
  DEFAULT_RETRY_POLICY,
  FLEX_STREAM_IDLE_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  computeBackoffMs,
  interruptibleSleep,
  isRetryableError,
  isRetryableStatus,
  parseRetryAfter,
} from "./provider-retry.js";
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
  ContentBlock,
  ImageBlock,
  ProviderTurnResult,
  ProviderTurnSession,
  ProviderTurnSink,
  ProviderTurnStreamEvent,
  TextBlock,
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
/** Oldest-truncated-result eviction cap for _resultOverflow — bounds memory on a long
 *  session that keeps triggering large-output tools; only overflowed results are kept. */
const RESULT_OVERFLOW_MAX_ENTRIES = 30;
/** Hard ceiling when auto-escalating the output budget after truncation recovery. */
const MAX_ESCALATED_OUTPUT_TOKENS = 65536;
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
/**
 * Bedrock rejects a Claude `max_tokens` larger than 64000 with a fatal 400
 * ("maximum tokens you requested exceeds the model limit of 64000"). The
 * output-escalation path above could request up to 65536, which 400s and ends
 * the turn. {@link resolveOutputCeiling} caps requests at the provider limit.
 */
const BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS = 64_000;

/**
 * The provider's hard output-token ceiling for a model, or null when unknown
 * (request passes through unclamped). Kept narrow and provider-aware so we
 * never truncate a model that legitimately supports more — only the proven
 * Bedrock-Claude 400 is guarded.
 */
export function resolveOutputCeiling(
  model: string | null | undefined,
  provider: string | null | undefined,
): number | null {
  const id = (model ?? "").toLowerCase();
  if (provider === "bedrock" && /claude/.test(id)) return BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS;
  return null;
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
  | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "runtime_state"; state: SessionRuntimeState }
  | { type: "execution_diagnostic"; level: "info" | "warn" | "error"; message: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string; inputPreview: string; input: Record<string, unknown> }
  | { type: "tool_call_result"; toolCallId: string; toolName: string; ok: boolean; summary: string; result: unknown; elapsedMs: number }
  | { type: "approval_pending"; toolCallId: string; description: string; tier: string; unrecognizedCommand?: boolean }
  | { type: "approval_result"; toolCallId: string; granted: boolean; decision: ApprovalDecision }
  | { type: "question_card_pending"; toolCallId: string; question: string; options: QCardOption[]; context?: string }
  | { type: "question_card_result"; toolCallId: string; selectedKey: string }
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

export type { QCardOption };

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

function normalizeOpenAIStopReason(reason: string): AgentStopReason {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "end_turn" || reason === "max_iterations" || reason === "approval_pending" || reason === "question_pending" || reason === "cancelled" || reason === "error" || reason === "protocol_violation") {
    return reason;
  }
  return "protocol_violation";
}

function normalizeAnthropicStopReason(reason: string): AgentStopReason {
  if (!reason || reason === "end_turn") return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "max_iterations" || reason === "approval_pending" || reason === "question_pending" || reason === "cancelled" || reason === "error" || reason === "protocol_violation") {
    return reason;
  }
  return "protocol_violation";
}

// ── Options ────────────────────────────────────────────────────────────────────

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
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
   * Supplies the live "Current workspace state" block, refreshed once per user send().
   * Injected at the message tail so it stays current without invalidating the cached
   * static system prompt. Omit to send no live workspace block.
   */
  workspaceContextProvider?: () => Promise<string>;
  /** Provides service-layer credentials for github/gitlab/jira/confluence/salesforce calls. */
  serviceKeyProvider?: (service: string) => Promise<string | undefined>;
  /** Chromium runner — enables browser_* tools via local Playwright instance. */
  browserRunner?: BrowserRunner;
  /** Resolves question_card tool calls by presenting the question to the user and returning the selected key. */
  questionCardProvider?: (toolCallId: string, question: string, options: QCardOption[], context?: string) => Promise<string>;
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
  private _pendingCompactionNotices: Array<{ level: "info" | "warn"; message: string }> = [];
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
  /** Live "Current workspace state" block, refreshed once per user send() and injected at the message tail. */
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
    if (includeFullHistory) state.fullHistory = this.fullHistory;
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

  /** Feeds the note-enforcement tracker from any tool result — a direct call
      in the sequential dispatch loop, or a subagent lane's relayed
      tool_call_result (a subagent's edits are still this session's
      responsibility to leave a note for). Keyed on the public tool name
      (tc.name), not the internal runtime type, since that's the shape both
      call sites already have on hand. Best-effort path matching (see
      normalizeStoredPath — shared with GraphAnnotationStore so a path
      recorded here and a path recorded in a note always agree) — this only
      ever nudges via forced continuations, capped and fail-open, so an
      occasional missed match degrades to "no reminder" rather than a stuck
      session. */
  private _trackToolResultForNotes(toolName: string, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const r = result as Record<string, unknown>;
    if (r.ok !== true) return;

    if (toolName === "file_edit") {
      if (typeof r.path === "string") this._dirtyMapFiles.add(normalizeStoredPath(r.path));
      return;
    }
    if (toolName === "file_edit_batch") {
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

  private _appendUserText(text: string): void {
    this.messages.push({ role: "user", content: text });
    this._fullHistory.push({ role: "user", content: text });
  }

  private _appendAssistantTurn(result: ProviderTurnResult): void {
    const assistantBlocks: ContentBlock[] = [];
    for (const thinking of result.thinkingBlocks) assistantBlocks.push(thinking);
    if (result.text) assistantBlocks.push({ type: "text", text: result.text });
    for (const toolCall of result.toolCalls) assistantBlocks.push(toolCall);
    this.messages.push({ role: "assistant", content: assistantBlocks });
    this._fullHistory.push({ role: "assistant", content: assistantBlocks });
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
      appendUserText: (text) => this._appendUserText(text),
      appendToolResults: (results, images) => this._appendToolResults(results, images),
      runTurn: async (sink: ProviderTurnSink): Promise<ProviderTurnResult> => {
        const thinkingBlocks: ThinkingBlock[] = [];
        const toolCalls: ToolUseBlock[] = [];
        let text = "";
        let stopReason: AgentStopReason | undefined;
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
          : this._streamTurnOpenAI();

        for await (const event of stream) {
          sink.emit(event);
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "thinking_block") {
            thinkingBlocks.push({ type: "thinking", thinking: event.text, ...(event.signature ? { signature: event.signature } : {}) });
          } else if (event.type === "tool_use_block") {
            toolCalls.push(event.block);
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
          empty: text.trim().length === 0 && thinkingBlocks.length === 0 && toolCalls.length === 0,
        };
      },
    };
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

  /** Returns the output token budget for the current call, respecting any active escalation override. */
  private _effectiveMaxTokens(): number {
    return this._clampToOutputCeiling(this._maxTokensOverride ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  }

  /** Clamp an output-token budget to what the provider/model will accept (or pass through if unknown). */
  private _clampToOutputCeiling(requested: number): number {
    const ceiling = resolveOutputCeiling(this.opts.model, this.provider);
    return ceiling != null ? Math.min(requested, ceiling) : requested;
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
      return "compressed";
    } catch (err) {
      this._lastCompressionError = err instanceof Error ? err.message : String(err);
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
          this._pendingCompactionNotices.push({ level: "warn", message: `Background compression failed: ${this._lastCompressionError} — session continues at full context.` });
        }
        // "skipped": a legitimate no-op (not enough history yet, or the compressible prefix
        // can't be cut without splitting a tool_use from its result) — nothing to report,
        // and _lastCompressionError is deliberately left untouched (see CompactionOutcome).
        return outcome;
      })
      .catch((err) => {
        // _compressHistory swallows its own errors, but guard anyway so a background
        // rejection can never surface as an unhandled promise.
        this._lastCompressionError = err instanceof Error ? err.message : String(err);
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
  private _takePendingCompactionNotices(): Array<{ level: "info" | "warn"; message: string }> {
    return this._pendingCompactionNotices.splice(0);
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
      messages: this.messages,
      state: this.exportState(includeFullHistory),
      createdAt: this._checkpointCreatedAt,
      updatedAt: now,
    };
    saveCheckpoint(this.opts.context, cp);
  }

  async *send(userContent: string): AsyncGenerator<AgentEvent> {
    this._providerTurnSession.appendUserText(userContent);
    this._lastStopReason = undefined;
    this._pendingGate = undefined;
    this._autoContinueCount = 0;
    // Refresh the live workspace block once per user turn (not per internal iteration —
    // gathering it does a git call + file reads). Best-effort: a failure leaves the
    // previous block in place rather than blocking the turn.
    if (this.opts.workspaceContextProvider) {
      try {
        this._workspaceContext = await this.opts.workspaceContextProvider();
      } catch { /* keep the last-known workspace block */ }
    }
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
          yield { type: "runtime_state", state: this.runtimeState };
        } else if (preTurnPct >= threshold && compressible > 4 && !this._compactionInFlight) {
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

        for await (const ev of streamEvents) {
          if (ev.type === "text_delta") {
            yield { type: "text_delta", text: ev.text };
          } else if (ev.type === "thinking_delta") {
            yield { type: "thinking_delta", text: ev.text };
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
      } else if (turnResult.stopReason !== "end_turn" && turnResult.stopReason !== "tool_use") {
        yield { type: "execution_diagnostic", level: "warn", message: `Agent stopped early: ${turnResult.stopReason.replace(/_/g, " ")}` };
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
        this._maxTokensOverride = this._clampToOutputCeiling(Math.min(this._effectiveMaxTokens() * 2, MAX_ESCALATED_OUTPUT_TOKENS));
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
        if (turnResult.stopReason === "error") yield { type: "error", message: "Provider reported an error terminal state." };
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
              }
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
                  const q = payload as { question?: unknown; options?: unknown; context?: unknown };
                  const question = String(q.question ?? "");
                  const options = Array.isArray(q.options) ? (q.options as QCardOption[]) : [];
                  const context = q.context != null ? String(q.context) : undefined;
                  this._pendingGate = { kind: "question", toolCallId: tc.id, question, options, context };
                  yield { type: "runtime_state", state: this.runtimeState };
                  if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                  yield { type: "question_card_pending", toolCallId: tc.id, question, options, context };
                  try {
                    const selectedKey = await this.opts.questionCardProvider(tc.id, question, options, context);
                    const selectedLabel = options.find((o) => o.key === selectedKey)?.label ?? selectedKey;
                    yield { type: "question_card_result", toolCallId: tc.id, selectedKey };
                    result = { ok: true, selectedKey, selectedLabel };
                  } catch {
                    result = { ok: false, error: this._signal?.aborted ? "Cancelled." : "Question was cancelled." };
                  } finally {
                    this._pendingGate = undefined;
                    yield { type: "runtime_state", state: this.runtimeState };
                    if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
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
                  let finalResult: { ok: false; error: string } | SubagentSpawnToolResult = {
                    ok: false,
                    error: "Delegated lane did not return a result.",
                  };
                  for await (const subEvent of this.opts.subagentProvider.spawn({
                    parentSessionId: this.sessionId,
                    parentToolCallId: tc.id,
                    input: normalizeSubagentSpawnInput(payload),
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
          if (usedPct >= COMPACTION_CRITICAL_PCT) {
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
          } else if (!this._compactionInFlight) {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — compacting ${compressible} older messages in the background…` };
            void this._beginBackgroundCompaction(this.opts.compressionProvider, "auto");
            yield { type: "runtime_state", state: this.runtimeState };
          }
          // else: a background pass is already running; let it land.
        } else if (usedPct >= threshold) {
          yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — not enough history to compress yet (${this.messages.length} messages).` };
        }
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

  private async *_streamTurnAnthropic(): AsyncGenerator<ProviderTurnStreamEvent> {
    const tools = this._getTools().map(({ name, description, input_schema }) =>
      ({ name, description, input_schema }) as Record<string, unknown>);
    // Cache the (large, stable) tool-schema block by marking the last tool. The breakpoint
    // caches everything before it too (system + summary), so between compressions the entire
    // system+tools prefix is a cache hit.
    if (tools.length > 0) tools[tools.length - 1]!["cache_control"] = { type: "ephemeral" };
    const url = this.opts.baseUrl ?? PROVIDER_DEFAULTS.anthropic.baseUrl;

    // Anthropic requires a thinking budget of at least 1024 tokens and strictly less
    // than max_tokens. Bump max_tokens up if the configured value can't satisfy both.
    let maxTok = this._effectiveMaxTokens();
    let thinking: { type: "enabled"; budget_tokens: number } | undefined;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { type: "enabled", budget_tokens: budget };
    }

    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: maxTok,
      system: buildAnthropicSystemBlocks(this.opts.systemPrompt, this._compressedSummary),
      messages: appendWorkspaceContextTail(withRollingCacheBreakpoint(stripUnsignedThinking(normalizeForProvider(this.messages))), this._workspaceContext),
      tools,
      stream: true,
    };
    // temperature must be omitted (or exactly 1) when thinking is enabled
    if (!thinking && this.opts.temperature !== undefined) body["temperature"] = clampAnthropicTemperature(this.opts.temperature);
    if (thinking) body["thinking"] = thinking;

    const anthropicHeaders: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.opts.apiKey,
      "content-type": "application/json",
    };
    // claude-3-7 requires the interleaved-thinking beta header; claude-4+ has it built in.
    if (thinking && /claude-3[-.]7/i.test(this.opts.model)) {
      anthropicHeaders["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }
    const response = yield* this._fetchWithRetry("Anthropic", (signal) => fetch(url, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body),
      signal,
    }));

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from Anthropic");

    yield* this._parseAnthropicSSE(response.body);
  }

  private async *_parseAnthropicSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderTurnStreamEvent> {
    const reader = response_body_reader(body, { idleMs: STREAM_IDLE_TIMEOUT_MS });
    const textAcc     = new Map<number, string>();
    const thinkingAcc = new Map<number, string>();
    const signatureAcc = new Map<number, string>();
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
          inputTokens = Number(usage["input_tokens"] ?? 0);
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
          if (thinkingText) yield { type: "thinking_block", text: thinkingText, signature };
        }
      } else if (evType === "message_delta") {
        const delta = ev["delta"] as Record<string, unknown>;
        yield { type: "stop_reason", reason: normalizeAnthropicStopReason(String(delta["stop_reason"] ?? "end_turn")) };
        const usage = ev["usage"] as Record<string, unknown> | undefined;
        if (usage) outputTokens = Number(usage["output_tokens"] ?? 0);
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

    let maxTok = this._effectiveMaxTokens();
    let thinking: { enabled: boolean; budgetTokens: number } | undefined;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { enabled: true, budgetTokens: budget };
    }

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
      maxTokens: maxTok,
      temperature: clampAnthropicTemperature(this.opts.temperature),
      tools: useCache
        ? withBedrockToolsCacheBreakpoint(toBedrockTools(this._getTools()))
        : toBedrockTools(this._getTools()),
      thinking,
    });

    // Some Bedrock models/regions/quota configurations reject requests that include
    // cache breakpoints — unlike the ARN context-length gap this can't be capability-
    // checked from the model id alone, so instead of guessing we detect the rejection
    // live: on the very first frame (before anything has been yielded to the caller,
    // so retrying is safe) retry once without cache breakpoints, and remember the
    // result for the rest of the session so we don't pay a failed-request retry every turn.
    // Acquire the first Converse frame with transient-failure retries. The first frame
    // arrives before anything is yielded to the caller, so retrying is safe (no duplicate
    // output). The one-shot cache-validation fallback (retry immediately without cache
    // breakpoints) is nested inside so it composes with, rather than bypasses, the backoff.
    const policy = this.opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    let iterator!: AsyncIterator<BedrockConverseStreamEvent>;
    let firstResult!: IteratorResult<BedrockConverseStreamEvent>;
    let lastErr: unknown;
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      if (this._signal?.aborted) throw makeAbortError();
      const isLast = attempt >= policy.maxAttempts - 1;
      const useCache = !this._bedrockCacheUnsupported;
      try {
        iterator = streamBedrockConverse(buildConverseOpts(useCache), this._signal)[Symbol.asyncIterator]();
        firstResult = await iterator.next();
        break;
      } catch (err) {
        lastErr = err;
        if (useCache && isBedrockCacheValidationError(err)) {
          // Not a transient failure: this model/region rejects cache breakpoints. Drop
          // them for the rest of the session and retry once right away.
          this._bedrockCacheUnsupported = true;
          try {
            iterator = streamBedrockConverse(buildConverseOpts(false), this._signal)[Symbol.asyncIterator]();
            firstResult = await iterator.next();
            break;
          } catch (err2) {
            lastErr = err2;
            if (this._signal?.aborted || isLast || !isRetryableError(err2)) throw err2;
          }
        } else if (this._signal?.aborted || isLast || !isRetryableError(err)) {
          throw err;
        }
        const delayMs = computeBackoffMs(attempt, policy, null);
        yield {
          type: "notice",
          level: "warn",
          message: `Bedrock connection error (${lastErr instanceof Error ? lastErr.message : String(lastErr)}) — retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
        };
        await interruptibleSleep(delayMs, this._signal);
      }
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

    // State machine over the decoded Converse frames (mirrors the chrome ext).
    let isThinking = false;
    let thinkingText = "";
    let isToolUse = false;
    let toolUseId = "";
    let toolUseName = "";
    let toolUseInput = "";
    let stopReason: AgentStopReason = "end_turn";
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null = null;

    for await (const { eventType, data } of stream) {
      switch (eventType) {
        case "contentBlockStart": {
          const start = (data["contentBlockStart"] as { start?: Record<string, unknown> } | undefined)?.start
            ?? (data["start"] as Record<string, unknown> | undefined);
          if (start?.["reasoningContent"]) {
            isThinking = true;
            thinkingText = "";
          } else if (start?.["toolUse"]) {
            const tu = start["toolUse"] as { toolUseId?: string; name?: string };
            isToolUse = true;
            toolUseId = tu.toolUseId ?? "";
            toolUseName = tu.name ?? "";
            toolUseInput = "";
          }
          break;
        }
        case "contentBlockDelta": {
          const delta = (data["contentBlockDelta"] as { delta?: Record<string, unknown> } | undefined)?.delta
            ?? (data["delta"] as Record<string, unknown> | undefined);
          if (delta?.["reasoningContent"]) {
            const rc = delta["reasoningContent"] as Record<string, unknown>;
            const text = String(rc["text"] ?? "");
            if (text) { thinkingText += text; yield { type: "thinking_delta", text }; }
          } else if (isToolUse && delta?.["toolUse"]) {
            toolUseInput += String((delta["toolUse"] as { input?: string }).input ?? "");
          } else if (typeof delta?.["text"] === "string") {
            yield { type: "text_delta", text: delta["text"] as string };
          }
          break;
        }
        case "contentBlockStop": {
          if (isThinking) {
            if (thinkingText) yield { type: "thinking_block", text: thinkingText };
            isThinking = false;
            thinkingText = "";
          } else if (isToolUse) {
            let input: Record<string, unknown> = {};
            try { if (toolUseInput) input = JSON.parse(toolUseInput) as Record<string, unknown>; } catch { /* ignore */ }
            yield { type: "tool_use_block", block: { type: "tool_use", id: toolUseId, name: toolUseName, input } };
            isToolUse = false;
            toolUseId = "";
            toolUseName = "";
            toolUseInput = "";
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

    const tools = this._getTools().map(({ name, description, input_schema }) => ({ name, description, input_schema }) as Record<string, unknown>);
    // Cache the stable tool-schema block so the full system+tools prefix is a
    // cache hit between compressions — mirrors the Anthropic-direct path.
    if (tools.length > 0) tools[tools.length - 1]!["cache_control"] = { type: "ephemeral" };

    let maxTok = this._effectiveMaxTokens();
    // Opus 4.7/4.8 require adaptive thinking — budget_tokens is rejected with a 400.
    let thinking: { type: "adaptive" } | undefined;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { type: "adaptive" };
    }

    const url = `${mantleEndpoint(credentials.region)}/anthropic/v1/messages`;
    const reqBody: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: maxTok,
      // Mantle uses the Anthropic Messages wire format — reuse the same cached-blocks
      // builder so the stable system-prompt head is cache-eligible here too.
      system: buildAnthropicSystemBlocks(this.opts.systemPrompt, this._compressedSummary),
      messages: appendWorkspaceContextTail(withRollingCacheBreakpoint(stripUnsignedThinking(normalizeForProvider(this.messages))), this._workspaceContext),
      tools,
      stream: true,
    };
    if (!thinking && this.opts.temperature !== undefined) reqBody["temperature"] = clampAnthropicTemperature(this.opts.temperature);
    if (thinking) reqBody["thinking"] = thinking;

    const body = JSON.stringify(reqBody);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    const signedHeaders = signBedrockRequest(credentials, "POST", url, headers, body, "bedrock-mantle");

    const response = yield* this._fetchWithRetry("Bedrock Mantle", (signal) =>
      fetch(url, { method: "POST", headers: signedHeaders, body, signal }));
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Bedrock Mantle ${response.status}: ${text.slice(0, 400)}`);
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
      msgs = withOpenRouterCacheControl(msgs);
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
    const maxTok = this._effectiveMaxTokens();

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
      if (this.opts.temperature !== undefined) oaiBody["temperature"] = this.opts.temperature;
      // reasoning_effort is rejected by non-reasoning OpenAI chat models (e.g. gpt-4o).
      // OpenRouter tolerates it and routes it to whichever model supports it.
      if (this.opts.reasoningEffort && this.provider === "openrouter") oaiBody["reasoning_effort"] = this.opts.reasoningEffort;
    }
    // OpenRouter's unified `reasoning` parameter maps the user's thinking budget onto
    // whatever the routed model natively supports (Anthropic thinking budgets, Gemini
    // thinking, OpenAI effort) and is ignored by models without reasoning — the same
    // toggle that drives Anthropic/Bedrock extended thinking works here too.
    if (this.provider === "openrouter" && this.opts.thinking?.enabled) {
      oaiBody["reasoning"] = { max_tokens: Math.max(1024, this.opts.thinking.budgetTokens) };
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
    if (!response.ok && response.status === 429 && serviceTier === "flex") {
      // Flex capacity was unavailable even after the standard retry/backoff cycle. Fall
      // back to the account-default tier for THIS turn only (capacity misses are
      // transient — the next turn tries flex again) rather than failing the run over a
      // discount.
      await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
      yield { type: "notice", level: "warn", message: "Flex-tier capacity unavailable — running this turn at the standard tier." };
      delete oaiBody["service_tier"];
      response = yield* this._fetchWithRetry(this.provider, doFetch);
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
type AnthropicCacheControl = { type: "ephemeral" };

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
): Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }> {
  const blocks: Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }> = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
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
export function withRollingCacheBreakpoint(messages: AgentMessage[]): AgentMessage[] {
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
    { cache_control: { type: "ephemeral" as const } },
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
export function ensureLeadingUserMessage(messages: AgentMessage[]): AgentMessage[] {
  if (messages[0]?.role === "assistant") {
    return [{ role: "user", content: "[Conversation continues from summarized history above.]" }, ...messages];
  }
  return messages;
}

/** Sanitize tool pairing and guarantee a user-first array — the full pre-send normalization. */
export function normalizeForProvider(messages: AgentMessage[]): AgentMessage[] {
  return ensureLeadingUserMessage(sanitizeToolMessages(messages));
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
export function withOpenRouterCacheControl(messages: OAIMessage[]): OAIMessage[] {
  const markLastTextPart = (msg: OAIMessage): OAIMessage => {
    if (typeof msg.content === "string") {
      return { ...msg, content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }] };
    }
    if (!Array.isArray(msg.content)) return msg;
    const parts = msg.content.slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]!;
      if (part.type === "text") {
        parts[i] = { ...part, cache_control: { type: "ephemeral" } };
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

// ── Anthropic → Bedrock (Converse) conversion ─────────────────────────────────

/** Bedrock rejects empty text blocks and empty content arrays; guarantee ≥1 block. */
function nonEmptyBedrockContent(blocks: BedrockContentBlock[]): BedrockContentBlock[] {
  const filtered = blocks.filter((b) => !("text" in b) || b.text.trim().length > 0);
  return filtered.length > 0 ? filtered : [{ text: "" }];
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
      }
      // Drop thinking blocks — Converse does not round-trip them back into history.
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

function normalizeBedrockStopReason(reason: string): AgentStopReason {
  switch (reason) {
    case "tool_use":      return "tool_use";
    case "max_tokens":    return "max_tokens";
    case "end_turn":
    case "stop_sequence": return "end_turn";
    default:              return "protocol_violation";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** OpenAI reasoning families that use max_completion_tokens and reject custom temperature.
 *  gpt-5 and everything after it (gpt-5.x, gpt-6…) is reasoning-native, so match any
 *  gpt-N with N ≥ 5 rather than pinning to the ids known today. */
function isOpenAIReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  if (/^o[134](-|$)/.test(id) || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return true;
  const m = /^gpt-(\d+)/.exec(id);
  return m !== null && Number(m[1]) >= 5;
}

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

function summarizeResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return "Done";
  const r = result as Record<string, unknown>;
  if (typeof r["progress"] === "string") return r["progress"] as string;
  if (typeof r["planId"] === "string") return `plan ${r["planId"] as string}`;
  if (typeof r["todoId"] === "string") return `task items ${r["todoId"] as string}`;
  if (typeof r["content"]  === "string") return `${(r["content"] as string).slice(0, 80)}…`;
  if (typeof r["path"]     === "string") return r["path"] as string;
  if (typeof r["exitCode"] === "number") return `exit ${r["exitCode"] as number}`;
  if (typeof r["planCount"] === "number") return `${r["planCount"] as number} plan(s)`;
  if (typeof r["runCount"] === "number") return `${r["runCount"] as number} task run(s)`;
  if (Array.isArray(r["results"])) return `${(r["results"] as unknown[]).length} result(s)`;
  if (Array.isArray(r["entries"])) return `${(r["entries"] as unknown[]).length} entries`;
  if (Array.isArray(r["commits"])) return `${(r["commits"] as unknown[]).length} commit(s)`;
  return "OK";
}

function normalizeSubagentSpawnInput(payload: Record<string, unknown>): SubagentSpawnInput {
  const complexity = String(payload["complexity"] ?? "").trim().toLowerCase();
  const profileId = payload["profileId"] != null ? String(payload["profileId"]).trim() : undefined;
  return {
    task: String(payload["task"] ?? ""),
    context: payload["context"] != null ? String(payload["context"]) : undefined,
    complexity: complexity === "standard" || complexity === "complex" || complexity === "deep"
      ? complexity
      : "auto",
    label: payload["label"] != null ? String(payload["label"]) : undefined,
    parallel: payload["parallel"] === true || payload["parallel"] === "true",
    profileId: profileId || undefined,
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

  generators.forEach(startGenerator);

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
