import type * as vscode from "vscode";
import type { LocalRuntime } from "@blacksite/local-runtime";
import {
  WORKSPACE_TOOLS, MEMORY_TOOLS, DIAGNOSTICS_TOOLS, CODE_INTEL_TOOLS, GIT_TOOLS, TEST_TOOLS, WORKTREE_TOOLS, SUBAGENT_TOOLS, SERVICE_TOOLS, BROWSER_TOOLS, UI_TOOLS, PLANNING_TOOLS, TRANSCRIPT_TOOLS, AGENT_MEMORY_TOOLS,
  resolveToolDispatch,
} from "./tools/definitions.js";
import type { ToolDefinition, QCardOption } from "./tools/definitions.js";
import type { AgentMemoryIndex } from "./agent-memory-index.js";
import type { BrowserRunner } from "./chromium-runner.js";
import type { EditProvider } from "./diff-edit-service.js";
import type { DiagnosticsProvider, ProblemInput } from "./diagnostics-publisher.js";
import type { LspProvider } from "./lsp-service.js";
import type { PlanningProvider } from "./planning-store.js";
import { requestApprovalWithDetails } from "./approval-gate.js";
import { saveCheckpoint, clearCheckpoint } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_ITER   = 40;

// ── Provider config ────────────────────────────────────────────────────────────

export type ProviderName = "anthropic" | "openrouter" | "openai";

const PROVIDER_DEFAULTS: Record<ProviderName, { baseUrl: string; authHeader: "x-api-key" | "Bearer" }> = {
  anthropic:  { baseUrl: "https://api.anthropic.com/v1/messages",          authHeader: "x-api-key" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1/chat/completions",   authHeader: "Bearer" },
  openai:     { baseUrl: "https://api.openai.com/v1/chat/completions",      authHeader: "Bearer" },
};

// ── Public event types ─────────────────────────────────────────────────────────

export type BaseAgentEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "execution_diagnostic"; level: "info" | "warn" | "error"; message: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string; inputPreview: string; input: Record<string, unknown> }
  | { type: "tool_call_result"; toolCallId: string; toolName: string; ok: boolean; summary: string; result: unknown; elapsedMs: number }
  | { type: "approval_pending"; toolCallId: string; description: string; tier: string }
  | { type: "approval_result"; toolCallId: string; granted: boolean }
  | { type: "question_card_pending"; toolCallId: string; question: string; options: QCardOption[]; context?: string }
  | { type: "question_card_result"; toolCallId: string; selectedKey: string }
  | { type: "turn_complete"; stopReason: string; iterations: number }
  | { type: "error"; message: string };

export type SubagentComplexity = "auto" | "standard" | "complex" | "deep";

export interface SubagentSpawnInput {
  task: string;
  context?: string;
  complexity?: SubagentComplexity;
  label?: string;
  parallel?: boolean;
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

interface TextBlock       { type: "text";        text: string }
interface ThinkingBlock   { type: "thinking";    thinking: string }
interface ToolUseBlock    { type: "tool_use";    id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string }
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage { role: "user" | "assistant"; content: string | ContentBlock[] }

// ── OpenAI message types ───────────────────────────────────────────────────────

interface OAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
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
  /** Backs the memory_* tools with persistent project memory/context storage. */
  memoryProvider?: MemoryProvider;
  /** Backs the plan_* and todo_* tools with persistent workspace planning state. */
  planningProvider?: PlanningProvider;
  /** Backs the file_edit tool with a diff-preview-and-apply flow in the editor. */
  editProvider?: EditProvider;
  /** Backs the report_problems tool with VS Code's Problems panel. */
  diagnosticsProvider?: DiagnosticsProvider;
  /** Backs the code_* tools with VS Code's language-server intelligence. */
  lspProvider?: LspProvider;
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
}

export interface MemoryProvider {
  append(note: string): void;
  readMemory(): string;
  readContext(): string;
}

export interface CompressionProvider {
  compress(messages: AnthropicMessage[]): Promise<string>;
}

export interface TranscriptProvider {
  getFullHistory(): AnthropicMessage[];
}

// ── AgentSession ───────────────────────────────────────────────────────────────

export class AgentSession {
  readonly sessionId: string;
  private messages: AnthropicMessage[] = [];
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
  /** Immutable transcript: every message ever appended, never trimmed by compression. */
  private _fullHistory: AnthropicMessage[] = [];

  constructor(private readonly opts: AgentSessionOptions) {
    this.sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.provider = opts.provider ?? "anthropic";
    this._signal = opts.signal;
  }

  /** Attach (or replace) the abort signal used to cancel in-flight requests and tool calls. */
  attachSignal(signal: AbortSignal): void {
    this._signal = signal;
  }

  get iteration(): number { return this._iteration; }
  get history(): AnthropicMessage[] { return [...this.messages]; }
  /** Full uncompressed transcript — every message since session start, never trimmed. */
  get fullHistory(): AnthropicMessage[] { return [...this._fullHistory]; }

  restoreHistory(messages: AnthropicMessage[]): void {
    this.messages = [...messages];
    this._fullHistory = [...messages];
  }

  private _getTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [...WORKSPACE_TOOLS, ...GIT_TOOLS, ...TEST_TOOLS, ...WORKTREE_TOOLS, ...SERVICE_TOOLS];
    if (this.opts.subagentProvider) all.push(...SUBAGENT_TOOLS);
    if (this.opts.memoryProvider) all.push(...MEMORY_TOOLS);
    if (this.opts.planningProvider) all.push(...PLANNING_TOOLS);
    if (this.opts.diagnosticsProvider) all.push(...DIAGNOSTICS_TOOLS);
    if (this.opts.lspProvider) all.push(...CODE_INTEL_TOOLS);
    if (this.opts.browserRunner) all.push(...BROWSER_TOOLS);
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

  private async _compressHistory(): Promise<boolean> {
    if (!this.opts.compressionProvider) return false;
    const keepRecent = this.opts.compressionKeepRecent ?? 20;
    if (this.messages.length <= keepRecent + 4) return false;

    const toCompress = this.messages.slice(0, this.messages.length - keepRecent);
    const recent = this.messages.slice(-keepRecent);
    try {
      const summary = await this.opts.compressionProvider.compress(toCompress);

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

      this._compressedSummary = this._compressedSummary
        ? `${this._compressedSummary}\n\n---\n\n${passLabel}\n${summary}`
        : `${passLabel}\n${summary}`;
      this.messages = recent;
      this._compressionCount++;
      return true;
    } catch {
      return false;
    }
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

  async *send(userContent: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: userContent });
    this._fullHistory.push({ role: "user", content: userContent });
    const maxIter = this.opts.maxIterations ?? DEFAULT_MAX_ITER;
    const turnStartIteration = this._iteration;

    while (this._iteration < maxIter) {
      if (this._signal?.aborted) { yield { type: "error", message: "Cancelled." }; return; }

      this._iteration++;
      yield { type: "iteration_start", iteration: this._iteration };

      const assistantBlocks: ContentBlock[] = [];
      const toolCalls: ToolUseBlock[] = [];
      const thinkingBlocks: ThinkingBlock[] = [];
      let stopReason = "end_turn";
      let currentText = "";

      try {
        const stream = this.provider === "anthropic"
          ? this._streamTurnAnthropic()
          : this._streamTurnOpenAI();

        for await (const ev of stream) {
          if (this._signal?.aborted) {
            yield { type: "execution_diagnostic", level: "warn", message: "Cancelled during streaming." };
            return;
          }
          if (ev.type === "text_delta") {
            currentText += ev.text;
            yield { type: "text_delta", text: ev.text };
          } else if (ev.type === "thinking_delta") {
            yield { type: "thinking_delta", text: ev.text };
          } else if (ev.type === "thinking_block") {
            thinkingBlocks.push({ type: "thinking", thinking: ev.text });
          } else if (ev.type === "tool_use_block") {
            toolCalls.push(ev.block);
            yield {
              type: "tool_call_start",
              toolCallId: ev.block.id,
              toolName: ev.block.name,
              inputPreview: JSON.stringify(ev.block.input).slice(0, 120),
              input: ev.block.input,
            };
          } else if (ev.type === "stop_reason") {
            stopReason = ev.reason;
          } else if (ev.type === "usage_update") {
            // Total context fill = non-cached + cache-read + cache-write
            this._lastInputTokens = ev.inputTokens + ev.cacheReadTokens + ev.cacheWriteTokens;
            yield { type: "usage_update", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens, cacheWriteTokens: ev.cacheWriteTokens };
          }
        }
      } catch (err) {
        yield { type: "error", message: err instanceof Error ? err.message : String(err) };
        return;
      }

      for (const tb of thinkingBlocks) assistantBlocks.push(tb);
      if (currentText) assistantBlocks.push({ type: "text", text: currentText });
      for (const tc of toolCalls) assistantBlocks.push(tc);
      this.messages.push({ role: "assistant", content: assistantBlocks });
      this._fullHistory.push({ role: "assistant", content: assistantBlocks });

      if (toolCalls.length === 0) {
        // Surface non-standard stop reasons so the user can see why the agent stopped.
        if (stopReason === "max_tokens") {
          yield { type: "execution_diagnostic", level: "warn", message: "Output token limit reached — the model response was cut off. Increase max tokens or enable compression to avoid this." };
        } else if (stopReason !== "end_turn" && stopReason !== "tool_use") {
          yield { type: "execution_diagnostic", level: "warn", message: `Agent stopped early: ${stopReason.replace(/_/g, " ")}` };
        }
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        if (this.opts.checkpointingEnabled !== false) clearCheckpoint(this.opts.context);
        return;
      }

      // Everything from here to the end of the iteration (tool execution, history push,
      // compression, checkpoint) runs outside the streaming try/catch above. Wrap it
      // so that any uncaught exception produces a visible error event rather than
      // silently killing the generator and leaving the UI stuck in "streaming" state.
      try {

      // Group tool calls based on whether they are parallel subagents
      const groups: { parallel: boolean; toolCalls: ToolUseBlock[] }[] = [];
      for (const tc of toolCalls) {
        const isParallel = isParallelSubagent(tc);
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.parallel === isParallel) {
          lastGroup.toolCalls.push(tc);
        } else {
          groups.push({ parallel: isParallel, toolCalls: [tc] });
        }
      }

      // Map toolCalls to their original indices for in-order results
      const tcToIndex = new Map<string, number>();
      toolCalls.forEach((tc, idx) => tcToIndex.set(tc.id, idx));

      const toolResults: ToolResultBlock[] = new Array(toolCalls.length);

      for (const group of groups) {
        if (this._signal?.aborted) {
          yield { type: "execution_diagnostic", level: "warn", message: "Cancelled between tool groups." };
          return;
        }

        if (group.parallel) {
          // Parallel execution of subagents
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
                  content: JSON.stringify(res),
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
                  content: JSON.stringify(finalResult),
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

          // Interleave and yield events from all parallel subagents
          for await (const event of mergeAsyncGenerators(generators)) {
            yield event;
          }

        } else {
          // Sequential execution
          for (const tc of group.toolCalls) {
            if (this._signal?.aborted) {
              yield { type: "execution_diagnostic", level: "warn", message: "Cancelled before tool execution." };
              return;
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
                  yield { type: "question_card_pending", toolCallId: tc.id, question, options, context };
                  try {
                    const selectedKey = await this.opts.questionCardProvider(tc.id, question, options, context);
                    const selectedLabel = options.find((o) => o.key === selectedKey)?.label ?? selectedKey;
                    yield { type: "question_card_result", toolCallId: tc.id, selectedKey };
                    result = { ok: true, selectedKey, selectedLabel };
                  } catch {
                    result = { ok: false, error: "Question was cancelled." };
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
                  if (!granted) {
                    yield { type: "approval_pending", toolCallId: tc.id, description, tier };
                    const decision = await requestApprovalWithDetails(tc.name, description, tier);
                    if (decision === "allow_all") this._autoApprove = true;
                    granted = decision !== "deny";
                  }
                  yield { type: "approval_result", toolCallId: tc.id, granted };
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
              content: JSON.stringify(result),
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

      this.messages.push({ role: "user", content: toolResults });
      this._fullHistory.push({ role: "user", content: toolResults });

      // Trigger compression when context window is getting full
      if (this.opts.compressionProvider && this.opts.contextLength && this._lastInputTokens > 0) {
        const usedPct = this._lastInputTokens / this.opts.contextLength * 100;
        const threshold = this.opts.compressionTriggerPct ?? 60;
        if (usedPct >= threshold) {
          const keepRecent = this.opts.compressionKeepRecent ?? 20;
          const toCompress = Math.max(0, this.messages.length - keepRecent);
          if (toCompress > 4) {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — compressing ${toCompress} older messages…` };
            const prevCount = this._compressionCount;
            const ok = await this._compressHistory();
            if (ok && this._compressionCount > prevCount) {
              yield { type: "execution_diagnostic", level: "info", message: `Compression ×${this._compressionCount} applied. ${this.messages.length} recent messages kept.` };
            } else if (!ok) {
              yield { type: "execution_diagnostic", level: "warn", message: "Compression failed — session continues at full context." };
            }
          } else {
            yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% — not enough history to compress yet (${this.messages.length} messages).` };
          }
        }
      }

      const cp: Checkpoint = {
        sessionId: this.sessionId,
        iteration: this._iteration,
        model: this.opts.model,
        workspaceRoot: this.opts.workspaceRoot,
        messages: this.messages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (this.opts.checkpointingEnabled !== false) saveCheckpoint(this.opts.context, cp);

      } catch (toolErr) {
        // A tool or post-tool step threw unexpectedly. Emit a visible error event so
        // the webview can recover (setRunning(false)) instead of staying frozen.
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        yield { type: "execution_diagnostic", level: "error", message: `Unexpected error during tool execution: ${msg}` };
        yield { type: "error", message: msg };
        return;
      }
    }

    yield { type: "turn_complete", stopReason: "max_iterations", iterations: this._iteration - turnStartIteration };
  }

  // ── Anthropic native streaming ─────────────────────────────────────────────

  private async *_streamTurnAnthropic(): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: string }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
    const tools = this._getTools().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    const url = this.opts.baseUrl ?? PROVIDER_DEFAULTS.anthropic.baseUrl;

    // Anthropic requires a thinking budget of at least 1024 tokens and strictly less
    // than max_tokens. Bump max_tokens up if the configured value can't satisfy both.
    let maxTok = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    let thinking: { type: "enabled"; budget_tokens: number } | undefined;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { type: "enabled", budget_tokens: budget };
    }

    const effectiveSystem = this._compressedSummary
      ? `${this.opts.systemPrompt}\n\n---\n[COMPRESSED CONVERSATION HISTORY — earlier messages summarised for context efficiency]\n${this._compressedSummary}\n---`
      : this.opts.systemPrompt;

    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: maxTok,
      system: effectiveSystem,
      messages: this.messages,
      tools,
      stream: true,
    };
    // temperature must be omitted (or exactly 1) when thinking is enabled
    if (!thinking && this.opts.temperature !== undefined) body["temperature"] = this.opts.temperature;
    if (thinking) body["thinking"] = thinking;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": this.opts.apiKey,
        "content-type": "application/json",
      },
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
    | { type: "stop_reason"; reason: string }
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
        yield { type: "stop_reason", reason: String(delta["stop_reason"] ?? "end_turn") };
        const usage = ev["usage"] as Record<string, unknown> | undefined;
        if (usage) outputTokens = Number(usage["output_tokens"] ?? 0);
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage_update", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    }
  }

  // ── OpenAI / OpenRouter streaming ──────────────────────────────────────────

  private async *_streamTurnOpenAI(): AsyncGenerator<
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "thinking_block"; text: string }
    | { type: "tool_use_block"; block: ToolUseBlock }
    | { type: "stop_reason"; reason: string }
    | { type: "usage_update"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  > {
    const pd   = PROVIDER_DEFAULTS[this.provider as "openrouter" | "openai"];
    const url  = this.opts.baseUrl ?? pd.baseUrl;
    const effectiveSystem = this._compressedSummary
      ? `${this.opts.systemPrompt}\n\n---\n[COMPRESSED CONVERSATION HISTORY]\n${this._compressedSummary}\n---`
      : this.opts.systemPrompt;
    const msgs = toOpenAIMessages(this.messages, effectiveSystem);
    const tools = this._getTools().map(t => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const extraHeaders: Record<string, string> = {};
    if (this.provider === "openrouter") {
      extraHeaders["HTTP-Referer"] = "https://blacksite.dev";
      extraHeaders["X-Title"] = "Blacksite";
    }

    // OpenAI reasoning models (o1/o3/o4, gpt-5 family) reject `max_tokens` and any
    // `temperature` other than the default — they require `max_completion_tokens`
    // and accept `reasoning_effort`. OpenRouter normalizes these, so only special-case
    // the direct OpenAI provider.
    const reasoning = this.provider === "openai" && isOpenAIReasoningModel(this.opts.model);
    const maxTok = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;

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

    yield { type: "stop_reason", reason: stopReason === "tool_calls" ? "tool_use" : "end_turn" };
    if (oaiInputTokens > 0 || oaiOutputTokens > 0) {
      yield { type: "usage_update", inputTokens: oaiInputTokens, outputTokens: oaiOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
  }
}

// ── SSE line reader ────────────────────────────────────────────────────────────

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

function toOpenAIMessages(messages: AnthropicMessage[], systemPrompt: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        // May be a mix of tool_result + text blocks
        const toolResults = (msg.content as ContentBlock[]).filter((b): b is ToolResultBlock => b.type === "tool_result");
        const textBlocks  = (msg.content as ContentBlock[]).filter((b): b is TextBlock => b.type === "text");
        for (const tr of toolResults) {
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
        const tool_calls = toolBlocks.length > 0 ? toolBlocks.map((tb) => ({
          id:       tb.id,
          type:     "function" as const,
          function: { name: tb.name, arguments: JSON.stringify(tb.input) },
        })) : undefined;
        result.push({ role: "assistant", content, tool_calls });
      }
    }
  }

  return result;
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
  return {
    task: String(payload["task"] ?? ""),
    context: payload["context"] != null ? String(payload["context"]) : undefined,
    complexity: complexity === "standard" || complexity === "complex" || complexity === "deep"
      ? complexity
      : "auto",
    label: payload["label"] != null ? String(payload["label"]) : undefined,
    parallel: payload["parallel"] === true || payload["parallel"] === "true",
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
