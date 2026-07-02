import type * as vscode from "vscode";
import type { LocalRuntime } from "@blacksite/local-runtime";
import {
  WORKSPACE_TOOLS, MEMORY_TOOLS, DIAGNOSTICS_TOOLS, CODE_INTEL_TOOLS, GIT_TOOLS, TEST_TOOLS, WORKTREE_TOOLS, SUBAGENT_TOOLS, SERVICE_TOOLS, BROWSER_TOOLS, UI_TOOLS, PLANNING_TOOLS, DATA_TOOLS, TRANSCRIPT_TOOLS, AGENT_MEMORY_TOOLS, RESULT_PAGING_TOOLS,
  resolveToolDispatch,
  validateToolInput,
} from "./tools/definitions.js";
import type { ToolDefinition, QCardOption } from "./tools/definitions.js";
import { capToolResult, pageResult, searchResult, DEFAULT_PAGE_CHAR_LIMIT, JSON_ESCAPED_NEWLINE } from "./tool-result-paging.js";
import type { AgentMemoryIndex } from "./agent-memory-index.js";
import type { BrowserRunner } from "./chromium-runner.js";
import type { EditProvider } from "./diff-edit-service.js";
import type { DiagnosticsProvider, ProblemInput } from "./diagnostics-publisher.js";
import type { LspProvider } from "./lsp-service.js";
import type { PlanningProvider } from "./planning-store.js";
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
import type {
  BedrockCredentials,
  BedrockContentBlock,
  BedrockMessage,
  BedrockToolDef,
} from "./bedrock-types.js";
import type {
  AgentMessage,
  ContentBlock,
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
const MAX_INTERNAL_AUTO_CONTINUE_TURNS = 3;
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
  | { type: "approval_pending"; toolCallId: string; description: string; tier: string }
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
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
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
  /** Reasoning effort for OpenAI o1/o3 models: "low" | "medium" | "high". */
  reasoningEffort?: "low" | "medium" | "high";
  /** Tool names to suppress — these are not passed to the model. */
  disabledTools?: string[];
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
  /** Backs the db_* tools with the embedded database surface (read-only + classify). */
  dataProvider?: DataToolProvider;
  /** Backs the file_edit tool with a diff-preview-and-apply flow in the editor. */
  editProvider?: EditProvider;
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
  /** When set, enables model-based compression of older history once the context fills up. */
  compressionProvider?: CompressionProvider;
  /** Percentage of contextLength (0–100) that triggers compression. Default: 60. */
  compressionTriggerPct?: number;
  /** Number of most-recent messages to keep verbatim after compression. Default: 20. */
  compressionKeepRecent?: number;
  /** Provides the agent's transcript_read tool with access to the full uncompressed history. */
  transcriptProvider?: TranscriptProvider;
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

export interface CompressionProvider {
  compress(messages: AgentMessage[]): Promise<string>;
}

export interface TranscriptProvider {
  getFullHistory(): AgentMessage[];
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
  /** Set after the missing-contextLength diagnostic has been emitted once. */
  private _contextLengthWarned = false;
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
  /**
   * Full text of tool results too large to send to the model in one piece, keyed by the
   * tool_call id the model already has from its own tool_use block — so resuming a read
   * needs no new id scheme, just the offset from the truncation notice. FIFO-evicted past
   * RESULT_OVERFLOW_MAX_ENTRIES so a long session pinning many huge outputs can't leak memory.
   */
  private readonly _resultOverflow = new Map<string, string>();
  /** Provider-turn session driving the next model turn. */
  private readonly _providerTurnSession: ProviderTurnSession;

  constructor(private readonly opts: AgentSessionOptions) {
    this.sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.provider = opts.provider ?? "anthropic";
    this._signal = opts.signal;
    this._providerTurnSession = opts.providerTurnSessionFactory
      ? opts.providerTurnSessionFactory(this)
      : this._createBuiltinProviderTurnSession();
  }

  /** Attach (or replace) the abort signal used to cancel in-flight requests and tool calls. */
  attachSignal(signal: AbortSignal): void {
    this._signal = signal;
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
    this._isCompacting = false;
    this._providerTurnSession.importState?.(state.providerState);
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

  private _appendToolResults(results: ToolResultBlock[]): void {
    this.messages.push({ role: "user", content: results });
    this._fullHistory.push({ role: "user", content: results });
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
      appendToolResults: (results) => this._appendToolResults(results),
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
            thinkingBlocks.push({ type: "thinking", thinking: event.text });
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
    const toCompress = this._compressibleMessageCount();
    if (toCompress <= 0) {
      return { ok: false, message: `Not enough history to compact yet (${this.messages.length} messages).` };
    }
    this._isCompacting = true;
    try {
      const ok = await this._compressHistory(compressionProvider, "manual");
      if (!ok) {
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
    } finally {
      this._isCompacting = false;
    }
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

  private _getTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [...WORKSPACE_TOOLS, ...GIT_TOOLS, ...TEST_TOOLS, ...WORKTREE_TOOLS, ...SERVICE_TOOLS, ...RESULT_PAGING_TOOLS];
    if (this.opts.subagentProvider) all.push(...SUBAGENT_TOOLS);
    if (this.opts.memoryProvider) all.push(...MEMORY_TOOLS);
    if (this.opts.planningProvider) all.push(...PLANNING_TOOLS);
    if (this.opts.dataProvider) all.push(...DATA_TOOLS);
    if (this.opts.diagnosticsProvider) all.push(...DIAGNOSTICS_TOOLS);
    if (this.opts.lspProvider) all.push(...CODE_INTEL_TOOLS);
    if (this._browserToolsUsable()) all.push(...BROWSER_TOOLS);
    if (this.opts.transcriptProvider || this._compressedSummary) all.push(...TRANSCRIPT_TOOLS);
    if (this.opts.agentMemoryIndex) all.push(...AGENT_MEMORY_TOOLS);
    // editor-backed edit tools only work with an editProvider — drop them otherwise.
    const usable = this.opts.editProvider ? all : all.filter((t) => t.name !== "file_edit" && t.name !== "file_edit_batch");
    const disabled = new Set(this.opts.disabledTools ?? []);
    const filtered = disabled.size ? usable.filter((t) => !disabled.has(t.name)) : usable;
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
  ): Promise<boolean> {
    const keepRecent = this._keepRecentCount();
    if (this.messages.length <= keepRecent + 4) return false;

    // Never split an assistant tool_use from its tool_result, or the recent window opens with
    // an orphaned result and the next provider request 400s. Boundary may shift earlier.
    const recentStart = safeRecentStart(this.messages, keepRecent);
    if (recentStart <= 0) return false;
    const toCompress = this.messages.slice(0, recentStart);
    const recent = this.messages.slice(recentStart);
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
      this.messages = recent;
      this._compressionCount++;
      this._lastCompressedAt = Date.now();
      this._lastCompressedMessageCount = toCompress.length;
      this._lastCompressionError = "";
      this._lastCompressionTrigger = trigger;
      return true;
    } catch (err) {
      this._lastCompressionError = err instanceof Error ? err.message : String(err);
      return false;
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
    yield { type: "runtime_state", state: this.runtimeState };
    if (!this.opts.contextLength && !this._contextLengthWarned) {
      this._contextLengthWarned = true;
      yield {
        type: "execution_diagnostic",
        level: "warn",
        message: `Context window metadata is unavailable for model "${this.opts.model}". Usage will be tracked, but percentage-based context reporting may remain unknown until model metadata is configured.`,
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

      // Proactive compression: if the last known context usage is already at or above the
      // trigger threshold, compress before sending so the model has output headroom. The
      // post-tool check handles growth mid-turn; this covers the turn's first call.
      if (this.opts.compressionProvider && this.opts.contextLength && this._lastInputTokens > 0) {
        const preTurnPct = this._lastInputTokens / this.opts.contextLength * 100;
        const threshold = this.opts.compressionTriggerPct ?? 60;
        if (preTurnPct >= threshold && this._compressibleMessageCount() > 4) {
          yield {
            type: "execution_diagnostic",
            level: "info",
            message: `Context at ${Math.round(preTurnPct)}% before model call — compressing ${this._compressibleMessageCount()} messages to free output headroom…`,
          };
          this._isCompacting = true;
          yield { type: "runtime_state", state: this.runtimeState };
          await this._compressHistory(this.opts.compressionProvider, "auto");
          this._isCompacting = false;
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

      this._appendAssistantTurn(turnResult);
      this._lastStopReason = turnResult.stopReason;

      if (turnResult.stopReason === "protocol_violation") {
        yield { type: "execution_diagnostic", level: "error", message: "Provider turn ended without a valid terminal event. Run marked as protocol_violation." };
      } else if (turnResult.stopReason === "max_tokens") {
        yield { type: "execution_diagnostic", level: "warn", message: "Output token limit reached - the model response was cut off. Increase max tokens or enable compression to avoid this." };
      } else if (turnResult.stopReason !== "end_turn" && turnResult.stopReason !== "tool_use") {
        yield { type: "execution_diagnostic", level: "warn", message: `Agent stopped early: ${turnResult.stopReason.replace(/_/g, " ")}` };
      }

      // A turn cut off by the output-token limit surfaces tool calls with empty/partial args.
      // That is truncation, not schema-malformation — route it to the truncation-recovery branch
      // below (which gives the model the accurate "split large writes" guidance) instead of the
      // generic "did not satisfy the tool schema" message. Only treat args as malformed when the
      // model stopped cleanly (end_turn/tool_use) yet still produced invalid arguments.
      const turnWasTruncated = turnResult.stopReason === "max_tokens" || turnResult.stopReason === "protocol_violation";
      const malformedToolCalls = turnWasTruncated ? [] : findMalformedToolCalls(turnResult.toolCalls);
      if (malformedToolCalls.length > 0) {
        const callNames = [...new Set(malformedToolCalls.map(({ toolCall }) => toolCall.name))].join(", ");
        const details = malformedToolCalls
          .map(({ toolCall, reasons }) => `${toolCall.name}: ${reasons.join("; ")}`)
          .join(" | ");

        if (autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
          this.messages.pop();
          this._fullHistory.pop();
          autoContinueCount++;
          this._autoContinueCount = autoContinueCount;
          this._maxTokensOverride = this._clampToOutputCeiling(Math.min(this._effectiveMaxTokens() * 2, MAX_ESCALATED_OUTPUT_TOKENS));
          yield {
            type: "execution_diagnostic",
            level: "warn",
            message: `Malformed tool call(s) [${callNames}] — ${details}. Escalating output budget to ${this._maxTokensOverride} tokens and retrying (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})…`,
          };
          if (this.opts.compressionProvider && this._compressibleMessageCount() > 4) {
            this._isCompacting = true;
            yield { type: "runtime_state", state: this.runtimeState };
            await this._compressHistory(this.opts.compressionProvider, "auto");
            this._isCompacting = false;
            yield { type: "runtime_state", state: this.runtimeState };
          }
          this._providerTurnSession.appendUserText(
            `Your last response emitted malformed tool call arguments that did not satisfy the tool schema.\n` +
            `${details}\n` +
            `Please retry those tool calls with complete, valid JSON arguments. If writing large files, split the content into smaller sections across multiple tool calls.`,
          );
          yield { type: "runtime_state", state: this.runtimeState };
          continue;
        }

        const stopReason: AgentStopReason = "error";
        this._lastStopReason = stopReason;
        yield {
          type: "execution_diagnostic",
          level: "error",
          message: `Malformed tool call recovery failed after ${MAX_INTERNAL_AUTO_CONTINUE_TURNS} retries: ${details}`,
        };
        yield { type: "error", message: `Model repeatedly emitted malformed tool calls: ${details}` };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }

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
        if (this.opts.compressionProvider && this._compressibleMessageCount() > 4) {
          this._isCompacting = true;
          yield { type: "runtime_state", state: this.runtimeState };
          await this._compressHistory(this.opts.compressionProvider, "auto");
          this._isCompacting = false;
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
              } else if (runtimeType.startsWith("data.")) {
                if (!this.opts.dataProvider) {
                  result = { ok: false, error: "The local database is not available in this context." };
                } else {
                  result = await this.opts.dataProvider.dispatch(runtimeType.slice("data.".length), payload);
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
                    if (subEvent.type === "subagent_tool_result") finalResult = subEvent.result;
                    else yield subEvent;
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
                  result = (resp as { result?: unknown }).result;
                }
              } else {
                const firstResponse = await this.opts.runtime.handleMessage({ type: runtimeType, payload });
                const firstResult = (firstResponse as { result?: unknown }).result;
                if (isConfirmationRequired(firstResult)) {
                  const { tier, description } = firstResult as { tier: string; description: string };
                  let granted = this._autoApprove;
                  let decision: ApprovalDecision = this._autoApprove ? "allow_all" : "deny";
                  if (!granted) {
                    this._pendingGate = { kind: "approval", toolCallId: tc.id, toolName: tc.name, description, tier };
                    yield { type: "runtime_state", state: this.runtimeState };
                    if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                    yield { type: "approval_pending", toolCallId: tc.id, description, tier };
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
                  yield { type: "approval_result", toolCallId: tc.id, granted, decision };
                  if (!granted) {
                    result = { ok: false, error: "User denied the operation." };
                  } else {
                    const confirmed = await this.opts.runtime.handleMessage({ type: runtimeType, payload: { ...payload, confirmed: true } });
                    result = (confirmed as { result?: unknown }).result;
                  }
                } else {
                  result = firstResult;
                }
              }
            } catch (err) {
              result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

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
            const summary = ok ? summarizeResult(result) : String((result as Record<string, unknown> | undefined)?.["error"] ?? "Failed");

            toolResults[idx] = {
              type: "tool_result",
              tool_use_id: tc.id,
              content: this._capToolResult(tc.id, JSON.stringify(result)),
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

      this._providerTurnSession.appendToolResults(toolResults);
      yield { type: "runtime_state", state: this.runtimeState };

      // Trigger compression when context window is getting full
      if (this.opts.compressionProvider && this.opts.contextLength && this._lastInputTokens > 0) {
        const usedPct = this._lastInputTokens / this.opts.contextLength * 100;
        const threshold = this.opts.compressionTriggerPct ?? 60;
        if (usedPct >= threshold) {
          const toCompress = this._compressibleMessageCount();
          if (toCompress > 4) {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — compressing ${toCompress} older messages…` };
            this._isCompacting = true;
            yield { type: "runtime_state", state: this.runtimeState };
            const prevCount = this._compressionCount;
            const ok = await this._compressHistory(this.opts.compressionProvider, "auto");
            this._isCompacting = false;
            if (ok && this._compressionCount > prevCount) {
              yield { type: "execution_diagnostic", level: "info", message: `Compression ×${this._compressionCount} applied. ${this.messages.length} recent messages kept.` };
            } else if (!ok) {
              // Surface the real reason — the auto path previously swallowed it, so
              // a recurring summariser failure was indistinguishable from "nothing to do".
              const reason = this._lastCompressionError ? `: ${this._lastCompressionError}` : "";
              // When context is critical, shed the oldest large tool-result payloads in
              // place so repeated compression failures can't grow into a fatal 400.
              if (usedPct >= 85) {
                const freed = this._emergencyTruncateOldestToolResults(
                  Math.floor(this.opts.contextLength * 0.8),
                );
                yield freed > 0
                  ? { type: "execution_diagnostic", level: "warn", message: `Compression failed${reason}. Shed ~${Math.round(freed / 1000)}k chars of old tool output to stay under the context limit.` }
                  : { type: "execution_diagnostic", level: "warn", message: `Compression failed${reason} — session continues at full context.` };
              } else {
                yield { type: "execution_diagnostic", level: "warn", message: `Compression failed${reason} — session continues at full context.` };
              }
            }
            yield { type: "runtime_state", state: this.runtimeState };
          } else {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — not enough history to compress yet (${this.messages.length} messages).` };
          }
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

  private async *_streamTurnAnthropic(): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: AgentStopReason }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
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
      messages: withRollingCacheBreakpoint(normalizeForProvider(this.messages)),
      tools,
      stream: true,
    };
    // temperature must be omitted (or exactly 1) when thinking is enabled
    if (!thinking && this.opts.temperature !== undefined) body["temperature"] = this.opts.temperature;
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
    const response = await fetch(url, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body),
      signal: this._signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from Anthropic");

    yield* this._parseAnthropicSSE(response.body);
  }

  private async *_parseAnthropicSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: AgentStopReason }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
    const reader = response_body_reader(body);
    const textAcc     = new Map<number, string>();
    const thinkingAcc = new Map<number, string>();
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
          if (thinkingText) yield { type: "thinking_block", text: thinkingText };
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

  private async *_streamTurnBedrock(): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: AgentStopReason }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
    const credentials = this.opts.bedrock;
    if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");

    let maxTok = this._effectiveMaxTokens();
    let thinking: { enabled: boolean; budgetTokens: number } | undefined;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { enabled: true, budgetTokens: budget };
    }

    const stream = streamBedrockConverse({
      credentials,
      modelId: this.opts.model,
      messages: toBedrockMessages(normalizeForProvider(this.messages)),
      systemPrompt: this.opts.systemPrompt,
      compressedSummary: this._compressedSummary || undefined,
      maxTokens: maxTok,
      temperature: this.opts.temperature,
      tools: toBedrockTools(this._getTools()),
      thinking,
    }, this._signal);

    // State machine over the decoded Converse frames (mirrors the chrome ext).
    let isThinking = false;
    let thinkingText = "";
    let isToolUse = false;
    let toolUseId = "";
    let toolUseName = "";
    let toolUseInput = "";
    let stopReason: AgentStopReason = "end_turn";
    let usage: { inputTokens: number; outputTokens: number } | null = null;

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
          const u = (data["metadata"] as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined)?.usage
            ?? (data["usage"] as { inputTokens?: number; outputTokens?: number } | undefined);
          if (u) usage = { inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0) };
          break;
        }
      }
    }

    yield { type: "stop_reason", reason: stopReason };
    if (usage) {
      yield { type: "usage_update", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
  }

  // ── Bedrock Mantle (Messages API) streaming ────────────────────────────────

  private async *_streamTurnBedrockMantle(): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: AgentStopReason }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
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
      messages: withRollingCacheBreakpoint(normalizeForProvider(this.messages)),
      tools,
      stream: true,
    };
    if (!thinking && this.opts.temperature !== undefined) reqBody["temperature"] = this.opts.temperature;
    if (thinking) reqBody["thinking"] = thinking;

    const body = JSON.stringify(reqBody);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    const signedHeaders = signBedrockRequest(credentials, "POST", url, headers, body, "bedrock-mantle");

    const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal: this._signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Bedrock Mantle ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from Bedrock Mantle");

    yield* this._parseAnthropicSSE(response.body);
  }

  // ── OpenAI / OpenRouter streaming ──────────────────────────────────────────

  private async *_streamTurnOpenAI(): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: AgentStopReason }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
    const pd   = PROVIDER_DEFAULTS[this.provider as "openrouter" | "openai"];
    const url  = this.opts.baseUrl ?? pd.baseUrl;
    const effectiveSystem = this._compressedSummary
      ? `${this.opts.systemPrompt}\n\n---\n[COMPRESSED CONVERSATION HISTORY]\n${this._compressedSummary}\n---`
      : this.opts.systemPrompt;
    const msgs = toOpenAIMessages(normalizeForProvider(this.messages), effectiveSystem);
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
    if (reasoning) {
      oaiBody["max_completion_tokens"] = maxTok;
      if (this.opts.reasoningEffort) oaiBody["reasoning_effort"] = this.opts.reasoningEffort;
    } else {
      oaiBody["max_tokens"] = maxTok;
      if (this.opts.temperature !== undefined) oaiBody["temperature"] = this.opts.temperature;
      // reasoning_effort is rejected by non-reasoning OpenAI chat models (e.g. gpt-4o).
      // OpenRouter tolerates it and routes it to whichever model supports it.
      if (this.opts.reasoningEffort && this.provider === "openrouter") oaiBody["reasoning_effort"] = this.opts.reasoningEffort;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(oaiBody),
      signal: this._signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${this.provider} ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error(`No response body from ${this.provider}`);

    // Accumulate tool call arguments by index
    const tcArgs = new Map<number, { id: string; name: string; args: string }>();
    let stopReason = "stop";
    let oaiInputTokens = 0;
    let oaiOutputTokens = 0;
    let oaiCachedTokens = 0;

    for await (const line of response_body_reader(response.body)) {
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

      const content = delta["content"];
      if (typeof content === "string" && content) yield { type: "text_delta", text: content };

      const toolCallDeltas = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
      if (toolCallDeltas) {
        for (const tcd of toolCallDeltas) {
          const idx  = Number(tcd["index"] ?? 0);
          const id   = tcd["id"] ? String(tcd["id"]) : undefined;
          const fn   = tcd["function"] as Record<string, string> | undefined;
          const name = fn?.["name"];
          const args = fn?.["arguments"] ?? "";

          if (id && name) {
            tcArgs.set(idx, { id, name, args: "" });
          }
          if (tcArgs.has(idx)) {
            tcArgs.get(idx)!.args += args;
          }
        }
      }
    }

    // Emit accumulated tool calls
    for (const [, tc] of tcArgs) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.args) as Record<string, unknown>; } catch { /* ignore */ }
      yield {
        type: "tool_use_block",
        block: { type: "tool_use", id: tc.id, name: tc.name, input },
      };
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

async function* response_body_reader(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer    = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
        // May be a mix of tool_result + text blocks
        const toolResults = (msg.content as ContentBlock[]).filter((b): b is ToolResultBlock => b.type === "tool_result");
        const textBlocks  = (msg.content as ContentBlock[]).filter((b): b is TextBlock => b.type === "text");
        for (const tr of toolResults) {
          if (!emittedCallIds.has(tr.tool_use_id) || answeredCallIds.has(tr.tool_use_id)) continue;
          answeredCallIds.add(tr.tool_use_id);
          result.push({ role: "tool", content: tr.content, tool_call_id: tr.tool_use_id });
        }
        if (textBlocks.length) {
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
      }
      // Drop thinking blocks — Converse does not round-trip them back into history.
    }
    return { role: msg.role, content: nonEmptyBedrockContent(blocks) };
  });
}

export function toBedrockTools(tools: ToolDefinition[]): BedrockToolDef[] {
  return tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } },
  }));
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

/** OpenAI reasoning families that use max_completion_tokens and reject custom temperature. */
function isOpenAIReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return /^o[134](-|$)/.test(id) || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")
    || id.startsWith("gpt-5");
}

function isConfirmationRequired(result: unknown): boolean {
  return result !== null && typeof result === "object" && "requiresConfirmation" in result
    && (result as Record<string, unknown>)["requiresConfirmation"] === true;
}

function isOk(result: unknown): boolean {
  return typeof result === "object" && result !== null
    && (result as Record<string, unknown>)["ok"] === true;
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

function findMalformedToolCalls(
  toolCalls: ToolUseBlock[],
): Array<{ toolCall: ToolUseBlock; reasons: string[] }> {
  const malformed: Array<{ toolCall: ToolUseBlock; reasons: string[] }> = [];

  for (const toolCall of toolCalls) {
    const issues = validateToolInput(toolCall.name, toolCall.input);
    if (issues.length === 0) continue;

    const missing = issues
      .filter((issue) => issue.kind === "missing_required")
      .map((issue) => issue.path);
    const invalid = issues
      .filter((issue) => issue.kind === "invalid_type")
      .map((issue) => issue.path);

    const reasons: string[] = [];
    if (missing.length > 0) reasons.push(`missing required field(s): ${missing.join(", ")}`);
    if (invalid.length > 0) reasons.push(`invalid field type(s): ${invalid.join(", ")}`);

    malformed.push({
      toolCall,
      reasons: reasons.length > 0 ? reasons : issues.map((issue) => issue.message),
    });
  }

  return malformed;
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
