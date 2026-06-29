import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { LocalRuntime } from "@blacksite/local-runtime";
import { AgentSession, type ProviderName } from "./agent-session.js";
import type {
  AgentEvent,
  BaseAgentEvent,
  ThinkingConfig,
  QCardOption,
  SubagentBudgetSummary,
  SubagentProvider,
  SubagentProviderMessage,
  SubagentSpawnInput,
  CompressionProvider,
  TranscriptProvider,
  DataToolProvider,
} from "./agent-session.js";
import { BackgroundRunner } from "./background-runner.js";
import { ChromiumRunner } from "./chromium-runner.js";
import { DiffEditService } from "./diff-edit-service.js";
import { LspService } from "./lsp-service.js";
import { WorkspaceEditApplier } from "./workspace-edit-applier.js";
import { SecretStore } from "./secret-store.js";
import { SessionStore } from "./session-store.js";
import { MemoryStore } from "./memory-store.js";
import type { DiagnosticsProvider } from "./diagnostics-publisher.js";
import { gatherWorkspaceSnapshot, buildSystemPrompt } from "./workspace-context.js";
import type { McpServerInfo } from "./workspace-context.js";
import { getMcpServers } from "./mcp-panel.js";
import { clearCheckpoint } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";
import { fetchModels, getFallbackModels, getContextLength } from "./model-fetcher.js";
import { findSubagentProfile, mergeBuiltinSubagentProfiles } from "./builtin-subagent-profiles.js";
import type { ModelInfo } from "./model-fetcher.js";
import { compressHistory } from "./compressor.js";
import { PlanningStore } from "./planning-store.js";
import { VectorStore } from "./vector-store.js";
import { EmbeddingService, sparseEmbed } from "./embedding-service.js";
import { AgentMemoryIndex } from "./agent-memory-index.js";
import { ExecutionLogger } from "./execution-logger.js";
import type { LogStats } from "./execution-logger.js";
import type { PersistedSessionState, SessionRestoreState, SessionRuntimeState } from "./session-state.js";
import type { DataAssistant } from "./data-provider.js";
import { AssistantQueryPlanner } from "./data/assistant-query-planner.js";
import type { DataSurfaceProvider } from "./data/data-surface-provider.js";
import { renderWebviewHtml } from "./webview-html.js";
import type { ApprovalDecision } from "./approval-gate.js";

// ── Settings schema ────────────────────────────────────────────────────────────

export interface ProviderSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  thinking?: ThinkingConfig;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface CompressionSettings {
  enabled: boolean;
  /** Provider to use for compression calls (defaults to main provider). */
  provider?: ProviderName;
  /** Model to use for compression (defaults to main model). */
  model?: string;
  /** Percent of context window that triggers compression (10–90). Default: 60. */
  triggerPct: number;
  /** Recent messages to keep verbatim after compression. Default: 20. */
  keepRecent: number;
}

export interface AgentMemorySettings {
  enabled: boolean;
  /** Cosine similarity threshold for related-call injection (0–1). Default: 0.70. */
  similarityThreshold?: number;
}

export interface OpenRouterConfig {
  httpReferer?: string;
  xTitle?: string;
}

export interface SubagentProfile {
  id: string;
  name: string;
  description: string;
  systemPromptAddition?: string;
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentSettings {
  provider?: ProviderName;
  model?: string;
  maxConcurrent?: number;
  profiles: SubagentProfile[];
}

export interface ExtendedSettings {
  provider: ProviderName;
  providerSettings: Partial<Record<ProviderName, ProviderSettings>>;
  maxIterations: number;
  disabledTools: string[];
  compression?: CompressionSettings;
  agentMemory?: AgentMemorySettings;
  openrouterConfig?: OpenRouterConfig;
  subagent?: SubagentSettings;
}

const SETTINGS_KEY = "blacksite.settings.v2";

const PROVIDER_DEFAULTS: Record<ProviderName, ProviderSettings> = {
  anthropic:  { model: "claude-sonnet-4-6",           temperature: 1.0, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000 } },
  openrouter: { model: "anthropic/claude-sonnet-4-6", temperature: 1.0, maxTokens: 8192 },
  openai:     { model: "gpt-4o",                      temperature: 1.0, maxTokens: 8192 },
};

type ResolvedSubagentBudget = SubagentBudgetSummary & {
  maxIterations: number;
};

const DELEGATED_TOOL_NAMES = ["subagent_spawn"];
const SUBAGENT_TIMEOUT_REASON = "Delegated lane timed out.";

function makeLaneId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeDelegatedComplexity(input: SubagentSpawnInput): Exclude<SubagentSpawnInput["complexity"], "auto" | undefined> {
  if (input.complexity === "standard" || input.complexity === "complex" || input.complexity === "deep") return input.complexity;
  const chars = input.task.length + (input.context?.length ?? 0);
  if (chars > 10_000) return "deep";
  if (chars > 3_000) return "complex";
  return "standard";
}

function resolveSubagentBudget(input: SubagentSpawnInput, sessionMaxIterations: number): ResolvedSubagentBudget {
  const complexity = normalizeDelegatedComplexity(input);
  const timeoutSeconds = complexity === "deep" ? 420 : complexity === "complex" ? 240 : 120;
  const maxToolRounds = complexity === "deep" ? 14 : complexity === "complex" ? 10 : 6;
  const maxIterations = Math.min(Math.max(sessionMaxIterations, maxToolRounds + 2), maxToolRounds + 4);
  return { complexity, timeoutSeconds, maxToolRounds, maxIterations };
}

function delegatedLanePrompt(task: string, context?: string): string {
  const trimmedContext = context?.trim();
  return trimmedContext
    ? `Delegated task:\n${task.trim()}\n\nAdditional context:\n${trimmedContext}`
    : `Delegated task:\n${task.trim()}`;
}

function buildDelegatedSystemPrompt(basePrompt: string, budget: ResolvedSubagentBudget, profileAddition?: string): string {
  const lines = [
    "You are a delegated Blacksite subagent running one focused lane for a parent agent.",
    "Stay tightly scoped to the delegated task. Gather evidence, make changes if needed, and return a concise synthesis for the parent to integrate.",
    "Do not address the end user directly. Do not explain the parent workflow. Work only within this lane.",
    "If you need user approval, ask through the provided tools. If information is missing, state the gap clearly in the final answer.",
    `Execution budget: ${budget.complexity} complexity, ${budget.maxToolRounds} tool rounds, ${budget.timeoutSeconds}s timeout.`,
  ];
  if (profileAddition?.trim()) {
    lines.push("", `Profile guidance: ${profileAddition.trim()}`);
  }
  lines.push("", basePrompt);
  return lines.join("\n");
}

function extractLatestAssistantText(history: Array<{ role: string; content: unknown }>): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function isBaseAgentEvent(event: AgentEvent): event is BaseAgentEvent {
  return event.type !== "subagent_lane_start"
    && event.type !== "subagent_lane_event"
    && event.type !== "subagent_lane_complete";
}

function namespaceChildEvent(laneId: string, event: BaseAgentEvent): BaseAgentEvent {
  const namespacedId = (toolCallId: string): string => `${laneId}:${toolCallId}`;
  switch (event.type) {
    case "tool_call_start":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "tool_call_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "approval_pending":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "approval_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "question_card_pending":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "question_card_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    default:
      return event;
  }
}

function normalizeModelIdForLookup(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const slashIndex = trimmed.lastIndexOf("/");
  const colonIndex = trimmed.lastIndexOf(":");
  return colonIndex > slashIndex ? trimmed.slice(0, colonIndex) : trimmed;
}

function modelIdsMatch(left: string, right: string): boolean {
  const a = normalizeModelIdForLookup(left);
  const b = normalizeModelIdForLookup(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

interface RunSummary {
  stopReason: string;
  text: string;
  toolCalls: number;
  approvalPending: boolean;
  questionPending: boolean;
  errored: boolean;
}

// ── ChatProvider ───────────────────────────────────────────────────────────────

export class ChatProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _session: AgentSession | null = null;
  private _restoredSessionState: SessionRestoreState | null = null;
  private _runner: BackgroundRunner;
  private _chromium: ChromiumRunner;
  private _applier: WorkspaceEditApplier;
  private _editService: DiffEditService;
  private _lspService: LspService;
  // Cache of fetched model lists keyed by provider
  private _modelCache = new Map<ProviderName, ModelInfo[]>();
  // Pending question cards: toolCallId → resolve function
  private _pendingQuestionCards = new Map<string, (key: string) => void>();
  private _pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  // Semantic memory index (initialized when agentMemory.enabled = true)
  private _memoryIndex: AgentMemoryIndex | null = null;
  // Execution logger — always active; writes to OutputChannel + .blacksite/execution.log
  private _logger: ExecutionLogger;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _runtime: LocalRuntime,
    private readonly _secrets: SecretStore,
    private readonly _sessionStore: SessionStore,
    private readonly _workspaceRoot: string,
    private readonly _memory: MemoryStore,
    private readonly _diagnostics: DiagnosticsProvider,
    private readonly _planning: PlanningStore,
    private readonly _dataSurface?: DataSurfaceProvider,
  ) {
    this._runner  = new BackgroundRunner();
    this._chromium = new ChromiumRunner();
    this._applier = new WorkspaceEditApplier(_workspaceRoot);
    this._editService = new DiffEditService(_workspaceRoot, this._applier);
    this._lspService = new LspService(_workspaceRoot, this._applier);
    this._logger = new ExecutionLogger(_workspaceRoot, _context);
    this._context.subscriptions.push({ dispose: () => this._runner.dispose() });
    this._context.subscriptions.push({ dispose: () => void this._chromium.dispose() });
    this._context.subscriptions.push({ dispose: () => this._applier.dispose() });
    this._context.subscriptions.push({ dispose: () => this._memoryIndex?.dispose() });

    // Initialize memory index if it was previously enabled
    if (this._readSettings().agentMemory?.enabled) {
      this._initMemoryIndex();
    }
  }

  private _initMemoryIndex(): void {
    try {
      const settings = this._readSettings();
      const store = new VectorStore(
        path.join(this._workspaceRoot, ".blacksite", "memory-index.json"),
      );
      const embedding = new EmbeddingService(
        settings.provider,
        (p) => this._secrets.getApiKey(p),
      );
      const idx = new AgentMemoryIndex(store, embedding);
      idx.init();
      this._memoryIndex = idx;
    } catch { /* non-fatal — extension still works without memory index */ }
  }

  private _disposeMemoryIndex(): void {
    this._memoryIndex?.dispose();
    this._memoryIndex = null;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = this._loadHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => {
        this._onMessage(msg).catch((err) => {
          // Top-level guard: prevents silent rejection swallow from `void` pattern.
          console.error("[Blacksite] _onMessage unhandled rejection:", err instanceof Error ? err.message : String(err));
        });
      },
      undefined,
      this._context.subscriptions,
    );
  }

  clearMessages(): void {
    this._sessionStore.archiveActive();
    this._session = null;
    this._restoredSessionState = null;
    this._sessionStore.clearActive();
    clearCheckpoint(this._context);
    this._post({ type: "clear" });
  }

  cancelCurrentRun(): void {
    this._runner.cancel();
  }

  /** Open the VS Code Output panel to the Blacksite Agent log channel. */
  showLogs(): void {
    this._logger.show();
  }

  async closeBrowser(): Promise<void> {
    await this._chromium.dispose();
  }

  createDataAssistant(surface: DataSurfaceProvider): DataAssistant {
    return new AssistantQueryPlanner(surface, (system, user) => this._generateAssistantText(system, user));
  }

  async compactConversation(): Promise<void> {
    if (this._runner.busy) {
      void vscode.window.showInformationMessage("Blacksite is still running. Wait for the current turn to finish before compacting.");
      return;
    }

    const stored = this._sessionStore.loadActive();
    if (!this._session && !this._restoredSessionState && !stored?.messages.length) {
      void vscode.window.showInformationMessage("No conversation history is available to compact yet.");
      return;
    }

    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const compressionProviderName = settings.compression?.provider ?? settings.provider;
    const apiKey = await this._secrets.getOrPromptApiKey(compressionProviderName);
    if (!apiKey) return;

    if (!this._session) {
      this._session = await this._createSession(apiKey);
      this._logger.sessionStart(this._session.sessionId, pSettings.model, settings.provider);
      const restore = this._restoredSessionState
        ?? (stored ? { sessionId: stored.sessionId, messages: stored.messages, ...(stored.state ?? {}) } : null);
      if (restore) {
        this._restoreSessionFromState(this._session, restore.messages, restore, restore.sessionId);
        this._restoredSessionState = null;
      }
    }

    const compressionProvider = this._buildCompressionProvider(apiKey, settings, pSettings, { forceEnabled: true });
    if (!compressionProvider || !this._session) {
      void vscode.window.showWarningMessage("Compression is not available for the current session.");
      return;
    }

    const pending = this._session.manualCompact(compressionProvider);
    this._postSessionRuntimeState();
    const result = await pending;
    this._persistSession(this._session);
    this._postSessionRuntimeState();
    if (result.ok) void vscode.window.showInformationMessage(result.message);
    else void vscode.window.showWarningMessage(result.message);
  }

  async offerCheckpointResume(cp: Checkpoint): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      `Blacksite: Unfinished run detected (${cp.iteration} iteration(s)). Resume?`,
      "Resume",
      "Discard",
    );
    if (action === "Resume") {
      const apiKey = await this._secrets.getOrPromptApiKey(this._readSettings().provider);
      if (!apiKey) return;
      this._session = await this._createSession(apiKey);
      this._restoreSessionFromState(this._session, cp.messages, cp.state, cp.sessionId);
      this._post({ type: "history_restored", messages: this._session.history });
      this._postSessionRuntimeState();
      void this._continueSend("[Resumed from checkpoint]");
    } else {
      clearCheckpoint(this._context);
    }
  }

  /** Build a fresh AgentSession wired with the current settings, workspace context, and providers. */
  private async _createSession(apiKey: string): Promise<AgentSession> {
    const settings  = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const snapshot  = await gatherWorkspaceSnapshot(this._workspaceRoot, this._runtime);
    snapshot.mcpServers = this._enabledMcpServers();
    const delegationEnabled = !settings.disabledTools.includes("subagent_spawn");
    const systemPrompt = delegationEnabled
      ? `${buildSystemPrompt(snapshot)}\n- When the work has an independent investigation or implementation lane, delegate it early with subagent_spawn so the parent context stays focused on orchestration and synthesis.`
      : buildSystemPrompt(snapshot);
    const ctxLen = await this._resolveContextLength(settings.provider, pSettings.model, apiKey);
    const compressionProvider = this._buildCompressionProvider(apiKey, settings, pSettings);
    const transcriptProvider  = this._buildTranscriptProvider();

    return new AgentSession({
      apiKey,
      model: pSettings.model,
      systemPrompt,
      workspaceRoot: this._workspaceRoot,
      runtime: this._runtime,
      context: this._context,
      provider: settings.provider,
      temperature: pSettings.temperature,
      maxTokens: pSettings.maxTokens,
      thinking: pSettings.thinking,
      reasoningEffort: pSettings.reasoningEffort,
      maxIterations: settings.maxIterations,
      disabledTools: settings.disabledTools,
      contextLength: ctxLen,
      compressionProvider,
      compressionTriggerPct: settings.compression?.triggerPct,
      compressionKeepRecent: settings.compression?.keepRecent,
      transcriptProvider,
      httpReferer: settings.openrouterConfig?.httpReferer,
      xTitle: settings.openrouterConfig?.xTitle,
      serviceKeyProvider: (svc) => this._secrets.getApiKey(svc),
      browserRunner: this._chromium,
      editProvider: this._editService,
      diagnosticsProvider: this._diagnostics,
      lspProvider: this._lspService,
      questionCardProvider: (toolCallId, question, options, context) => this._createQuestionCardPromise(toolCallId, question, options, context),
      approvalProvider: (toolCallId, toolName, description, tier) => this._createApprovalPromise(toolCallId, toolName, description, tier),
      subagentProvider: this._createSubagentProvider(apiKey, settings, pSettings),
      subagentMaxConcurrent: settings.subagent?.maxConcurrent,
      memoryProvider: {
        append: (note) => this._memory.appendMemory(note),
        readMemory: () => this._memory.readMemory(),
        readContext: () => this._memory.readContext(),
      },
      planningProvider: this._planning,
      dataProvider: this._buildDataToolProvider(),
      agentMemoryIndex: this._memoryIndex ?? undefined,
    });
  }

  /**
   * Expose the embedded database to the agent as read-only / classify-only db_* tools.
   * Writes are never executed here: run_read_query rejects non-reads and
   * preview_write_query only classifies, preserving the "no silent writes" rule.
   */
  private _buildDataToolProvider(): DataToolProvider | undefined {
    const surface = this._dataSurface;
    if (!surface) return undefined;
    return {
      dispatch: async (op, payload) => {
        try {
          switch (op) {
            case "list_objects":
              return { ok: true, catalog: surface.getCatalog() };
            case "describe_object":
              return { ok: true, description: surface.describeObject(String(payload["name"] ?? "")) };
            case "preview_rows":
              return {
                ok: true,
                result: surface.previewRows(String(payload["name"] ?? ""), {
                  limit: typeof payload["limit"] === "number" ? payload["limit"] : 50,
                  offset: typeof payload["offset"] === "number" ? payload["offset"] : 0,
                  filter: typeof payload["filter"] === "string" ? payload["filter"] : undefined,
                }),
              };
            case "run_read_query": {
              const result = await surface.runQuery(String(payload["sql"] ?? ""), {
                confirmed: false,
                maxRows: typeof payload["maxRows"] === "number" ? payload["maxRows"] : 200,
              });
              if (!result.ok) {
                return { ok: false, error: result.message, classification: result.classification };
              }
              return { ...result };
            }
            case "preview_write_query":
              return { ok: true, ...surface.previewQuery(String(payload["sql"] ?? "")) };
            case "vector_search": {
              const raw = payload["vector"];
              const vector = Array.isArray(raw)
                ? raw.map((x) => Number(x))
                : sparseEmbed(String(payload["text"] ?? ""));
              const hits = await surface.vectorSearch({
                vector,
                topK: typeof payload["topK"] === "number" ? payload["topK"] : 10,
                collection: typeof payload["collection"] === "string" && payload["collection"]
                  ? (payload["collection"] as string)
                  : undefined,
              });
              return { ok: true, hits };
            }
            case "list_saved_queries":
              return { ok: true, savedQueries: surface.listSavedQueries() };
            default:
              return { ok: false, error: `Unknown data operation: ${op}` };
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  }

  private async _generateAssistantText(systemPrompt: string, userPrompt: string): Promise<string> {
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const apiKey = await this._secrets.getOrPromptApiKey(settings.provider);
    if (!apiKey) throw new Error(`No API key configured for ${settings.provider}.`);

    if (settings.provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: pSettings.model,
          max_tokens: Math.min(pSettings.maxTokens ?? 4096, 4096),
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Anthropic error ${response.status}: ${text.slice(0, 300)}`);
      }
      const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
      return data.content?.find((block) => block.type === "text")?.text?.trim() ?? "";
    }

    const baseUrl = settings.provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
    const body: Record<string, unknown> = {
      model: pSettings.model,
      max_tokens: Math.min(pSettings.maxTokens ?? 4096, 4096),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (settings.provider === "openai" && pSettings.reasoningEffort) {
      body["reasoning_effort"] = pSettings.reasoningEffort;
    }
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(settings.provider === "openrouter" ? {
        "HTTP-Referer": settings.openrouterConfig?.httpReferer ?? "https://blacksite.dev",
        "X-Title": settings.openrouterConfig?.xTitle ?? "Blacksite",
      } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${settings.provider} error ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  private _restoreSessionFromState(
    session: AgentSession,
    messages: SessionRestoreState["messages"],
    state?: PersistedSessionState,
    sessionId?: string,
  ): void {
    const fullHistory = state?.fullHistory ?? (sessionId ? this._sessionStore.loadFullHistory(sessionId) : undefined);
    session.restoreState({
      messages,
      ...(state ?? {}),
      fullHistory,
    });
  }

  private _buildRuntimeFromStoredSession(
    sessionId: string,
    messages: SessionRestoreState["messages"],
    state?: PersistedSessionState,
  ): SessionRuntimeState {
    const keepRecent = this._readSettings().compression?.keepRecent ?? 20;
    const fullHistory = state?.fullHistory ?? this._sessionStore.loadFullHistory(sessionId) ?? messages;
    const lastInputTokens = state?.lastInputTokens ?? 0;
    const contextLength = state?.contextLength;
    const usagePct = contextLength && lastInputTokens > 0
      ? Math.min(lastInputTokens / contextLength * 100, 100)
      : null;
    return {
      sessionId,
      contextLength,
      lastInputTokens,
      usagePct,
      compressionEnabled: !!this._readSettings().compression?.enabled,
      isCompacting: false,
      compressionCount: state?.compressionCount ?? 0,
      hasCompressedHistory: !!state?.compressedSummary,
      lastCompressedAt: state?.lastCompressedAt,
      lastCompressedMessageCount: state?.lastCompressedMessageCount,
      lastCompressionError: state?.lastCompressionError,
      lastCompressionTrigger: state?.lastCompressionTrigger,
      keepRecent,
      activeMessageCount: messages.length,
      fullMessageCount: fullHistory.length,
      compressedMessageCount: Math.max(fullHistory.length - messages.length, 0),
      compressibleMessageCount: messages.length > keepRecent + 4 ? messages.length - keepRecent : 0,
      lastStopReason: state?.lastStopReason,
      autoContinueCount: state?.autoContinueCount ?? 0,
      pendingGate: state?.pendingGate,
    };
  }

  private _postSessionRuntimeState(runtime?: SessionRuntimeState): void {
    const next = runtime ?? this._session?.runtimeState;
    if (!next) return;
    this._post({ type: "session_runtime", runtime: next });
  }

  private _persistSession(session: AgentSession): void {
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const stored = this._sessionStore.loadActive();
    this._sessionStore.saveActive({
      sessionId: session.sessionId,
      createdAt: stored?.sessionId === session.sessionId ? stored.createdAt : Date.now(),
      updatedAt: Date.now(),
      model: pSettings.model,
      workspaceRoot: this._workspaceRoot,
      messages: session.history,
      state: session.exportState(false),
    });
    this._sessionStore.saveFullHistory(session.sessionId, session.fullHistory);
  }

  private _buildCompressionProvider(
    apiKey: string,
    settings: ExtendedSettings,
    pSettings: ProviderSettings,
    options?: { forceEnabled?: boolean },
  ): CompressionProvider | undefined {
    if (!options?.forceEnabled && !settings.compression?.enabled) return undefined;
    const cmp = settings.compression;
    const provider = cmp?.provider ?? settings.provider;
    const model    = cmp?.model ?? pSettings.model;
    const secrets  = this._secrets;
    return {
      compress: async (messages) => {
        const cmpKey = provider !== settings.provider
          ? (await secrets.getApiKey(provider)) ?? apiKey
          : apiKey;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return compressHistory({ apiKey: cmpKey, model, provider }, messages as any);
      },
    };
  }

  private _buildTranscriptProvider(): TranscriptProvider {
    // Return the live session's full (uncompressed) history so the agent always
    // sees every message, even those removed from the active context by compression.
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getFullHistory: (): any[] => this._session?.fullHistory ?? [],
    };
  }

  private _enabledMcpServers(): McpServerInfo[] {
    return getMcpServers(this._context)
      .filter((s) => s.enabled)
      .map((s) => ({
        name: s.name,
        transport: s.transport,
        target: (s.transport === "http" ? s.url : s.command) ?? "",
      }))
      .filter((s) => s.target);
  }

  private _createSubagentProvider(
    apiKey: string,
    settings: ExtendedSettings,
    pSettings: ProviderSettings,
  ): SubagentProvider {
    return {
      spawn: (request) => this._runDelegatedLane(apiKey, settings, pSettings, request),
    };
  }

  private async *_runDelegatedLane(
    apiKey: string,
    settings: ExtendedSettings,
    pSettings: ProviderSettings,
    request: Parameters<SubagentProvider["spawn"]>[0],
  ): AsyncGenerator<SubagentProviderMessage> {
    const laneId = makeLaneId("lane");
    const subRequestId = makeLaneId("sub");
    const label = request.input.label?.trim() || "Delegated lane";
    const budget = resolveSubagentBudget(request.input, settings.maxIterations);
    const snapshot = await gatherWorkspaceSnapshot(this._workspaceRoot, this._runtime);
    snapshot.mcpServers = this._enabledMcpServers();
    const laneStartedAt = Date.now();

    // Resolve profile (builtin + user-defined), apply its system prompt addition
    const profile = request.input.profileId
      ? findSubagentProfile(settings.subagent?.profiles, request.input.profileId)
      : null;

    // Resolve subagent provider/model — may differ from parent if configured
    const subProvider = settings.subagent?.provider ?? settings.provider;
    const subModel = settings.subagent?.model ?? pSettings.model;
    const subApiKey = subProvider !== settings.provider
      ? ((await this._secrets.getApiKey(subProvider)) ?? apiKey)
      : apiKey;
    const subPSettings = subProvider !== settings.provider
      ? this._providerSettings(subProvider, settings)
      : pSettings;
    const resolvedSubModel = subModel || subPSettings.model;

    const childChromium = new ChromiumRunner();

    const controller = new AbortController();
    const forwardAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(request.signal?.reason ?? "Parent run cancelled.");
    };
    if (request.signal) {
      if (request.signal.aborted) forwardAbort();
      else request.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeoutHandle = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(SUBAGENT_TIMEOUT_REASON);
    }, budget.timeoutSeconds * 1000);

    try {
      const childSession = new AgentSession({
        apiKey: subApiKey,
        model: resolvedSubModel,
        systemPrompt: buildDelegatedSystemPrompt(buildSystemPrompt(snapshot), budget, profile?.systemPromptAddition),
        workspaceRoot: this._workspaceRoot,
        runtime: this._runtime,
        context: this._context,
        provider: subProvider,
        signal: controller.signal,
        temperature: subPSettings.temperature,
        maxTokens: subPSettings.maxTokens,
        thinking: subProvider === "anthropic" ? subPSettings.thinking : undefined,
        reasoningEffort: subPSettings.reasoningEffort,
        httpReferer: settings.openrouterConfig?.httpReferer,
        xTitle: settings.openrouterConfig?.xTitle,
        maxIterations: budget.maxIterations,
        disabledTools: Array.from(new Set([...(settings.disabledTools ?? []), ...DELEGATED_TOOL_NAMES])),
        serviceKeyProvider: (svc) => this._secrets.getApiKey(svc),
        browserRunner: childChromium,
        editProvider: this._editService,
        diagnosticsProvider: this._diagnostics,
        lspProvider: this._lspService,
        questionCardProvider: (toolCallId, question, options, context) => this._createQuestionCardPromise(
          `${laneId}:${toolCallId}`,
          question,
          options,
          context,
          controller.signal,
        ),
        approvalProvider: (toolCallId, toolName, description, tier) => this._createApprovalPromise(
          `${laneId}:${toolCallId}`,
          toolName,
          description,
          tier,
          controller.signal,
        ),
        memoryProvider: {
          append: (note) => this._memory.appendMemory(note),
          readMemory: () => this._memory.readMemory(),
          readContext: () => this._memory.readContext(),
        },
        planningProvider: this._planning,
        checkpointingEnabled: false,
      });

      yield {
        type: "subagent_lane_start",
        parentToolCallId: request.parentToolCallId,
        laneId,
        subRequestId,
        label,
        task: request.input.task,
      };

      let stopReason = "";
      let errorMessage = "";
      try {
        for await (const event of childSession.send(delegatedLanePrompt(request.input.task, request.input.context))) {
          if (!isBaseAgentEvent(event)) continue;
          if (event.type === "turn_complete") stopReason = event.stopReason;
          if (event.type === "error") errorMessage = event.message;
          yield {
            type: "subagent_lane_event",
            parentToolCallId: request.parentToolCallId,
            laneId,
            event: namespaceChildEvent(laneId, event),
          };
        }
      } catch (laneErr) {
        // Capture the error here so subagent_lane_complete is still yielded below
        // instead of propagating and losing the lane closure event entirely.
        errorMessage = laneErr instanceof Error ? laneErr.message : String(laneErr);
      }

      const answer = extractLatestAssistantText(childSession.history as unknown as Array<{ role: string; content: unknown }>);
      const toolRounds = Math.max(childSession.iteration - 1, 0);
      if (controller.signal.aborted && controller.signal.reason === SUBAGENT_TIMEOUT_REASON) {
        errorMessage = `Timed out after ${budget.timeoutSeconds}s.`;
      } else if (controller.signal.aborted && !errorMessage) {
        errorMessage = "Cancelled.";
      } else if (!errorMessage && !answer) {
        errorMessage = "Delegated lane returned no final answer.";
      }
      const ok = !errorMessage && !!answer;
      yield {
        type: "subagent_lane_complete",
        parentToolCallId: request.parentToolCallId,
        laneId,
        subRequestId,
        label,
        ok,
        answer,
        ...(errorMessage ? { error: errorMessage } : {}),
        elapsedMs: Math.max(Date.now() - laneStartedAt, 0),
        stopReason,
        toolRounds,
        budget,
      };
      yield {
        type: "subagent_tool_result",
        result: ok
          ? {
            ok: true,
            subRequestId,
            answer,
            toolRounds,
            usage: null,
            scratchFiles: [],
            budget,
            nextStep: "Review the delegated lane output and continue synthesis.",
          }
          : { ok: false, error: errorMessage || "Delegated lane failed." },
      };
    } finally {
      clearTimeout(timeoutHandle);
      request.signal?.removeEventListener("abort", forwardAbort);
      await childChromium.dispose();
    }
  }

  injectContext(text: string, label: string): void {
    this._post({ type: "inject_context", text, label });
  }

  // ── Message dispatch ─────────────────────────────────────────────────────────

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");

    switch (type) {
      case "ready":
        this._restoreSessionToWebview();
        break;

      case "send_message": {
        const p = msg.payload as { content?: string; context?: { text?: string; label?: string }; mentions?: unknown } | undefined;
        const content = String(p?.content ?? "").trim();
        const mentions = Array.isArray(p?.mentions) ? p!.mentions.map((m) => String(m)) : [];
        if (content) await this._handleSend(content, p?.context, mentions);
        break;
      }

      case "request_files": {
        const query = String(msg.query ?? "");
        const files = await this._searchWorkspaceFiles(query);
        this._post({ type: "files_data", query, files });
        break;
      }

      case "cancel_current":
        this._runner.cancel();
        break;

      case "compact_conversation":
        await this.compactConversation();
        break;

      case "new_chat":
        this._sessionStore.archiveActive();
        this._session = null;
        this._restoredSessionState = null;
        this._sessionStore.clearActive();
        clearCheckpoint(this._context);
        this._post({ type: "clear" });
        break;

      // ── History ───────────────────────────────────────────────────────────────
      case "get_history":
        this._post({ type: "history_data", sessions: this._sessionStore.loadHistory() });
        break;

      case "load_session": {
        const sessionId = String(msg.sessionId ?? "");
        if (!sessionId) break;
        this._sessionStore.archiveActive();
        const stored = this._sessionStore.loadSessionFromHistory(sessionId);
        if (!stored) break;
        this._session = null;
        this._restoredSessionState = { sessionId: stored.sessionId, messages: stored.messages, ...(stored.state ?? {}) };
        this._sessionStore.saveActive(stored);
        this._post({ type: "clear" });
        const display = stored.messages.filter((m) => m.role === "user" || m.role === "assistant");
        this._post({ type: "history_restored", messages: display });
        if (stored.state?.contextLength || stored.state?.compressionCount || stored.state?.lastInputTokens) {
          this._post({
            type: "session_runtime",
            runtime: this._buildRuntimeFromStoredSession(stored.sessionId, stored.messages, stored.state),
          });
        }
        break;
      }

      case "delete_session": {
        const sessionId = String(msg.sessionId ?? "");
        if (!sessionId) break;
        this._sessionStore.deleteSessionFromHistory(sessionId);
        this._post({ type: "history_data", sessions: this._sessionStore.loadHistory() });
        break;
      }

      // ── Settings ──────────────────────────────────────────────────────────────
      case "get_settings":
        await this._sendSettingsToWebview();
        break;

      case "set_active_provider": {
        const provider = msg.provider as ProviderName | undefined;
        if (!this._isValidProvider(provider)) break;
        const s = this._readSettings();
        s.provider = provider;
        this._writeSettings(s);
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }

      case "set_provider_model": {
        const provider = msg.provider as ProviderName | undefined;
        const model    = String(msg.model ?? "").trim();
        if (!this._isValidProvider(provider) || !model) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), model };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      case "set_temperature": {
        const provider    = msg.provider as ProviderName | undefined;
        const temperature = Number(msg.temperature);
        if (!this._isValidProvider(provider) || isNaN(temperature)) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), temperature };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      case "set_max_tokens": {
        const provider  = msg.provider as ProviderName | undefined;
        const maxTokens = Number(msg.maxTokens);
        if (!this._isValidProvider(provider) || isNaN(maxTokens) || maxTokens < 1) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), maxTokens };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      case "set_thinking": {
        const provider    = msg.provider as ProviderName | undefined;
        const enabled     = Boolean(msg.enabled);
        const budgetTokens = Number(msg.budgetTokens) || 10000;
        if (!this._isValidProvider(provider)) break;
        const s = this._readSettings();
        const cur = this._providerSettings(provider, s);
        s.providerSettings[provider] = { ...cur, thinking: { enabled, budgetTokens } };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      case "set_reasoning_effort": {
        const provider = msg.provider as ProviderName | undefined;
        const effort   = msg.effort as "low" | "medium" | "high" | undefined;
        if (!this._isValidProvider(provider) || !effort) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), reasoningEffort: effort };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      case "set_max_iterations": {
        const n = Number(msg.maxIterations);
        if (isNaN(n) || n < 1) break;
        const s = this._readSettings();
        s.maxIterations = n;
        this._writeSettings(s);
        break;
      }

      case "toggle_tool": {
        const toolName = String(msg.toolName ?? "");
        const enabled  = Boolean(msg.enabled);
        if (!toolName) break;
        const s = this._readSettings();
        if (enabled) {
          s.disabledTools = s.disabledTools.filter((t) => t !== toolName);
        } else {
          if (!s.disabledTools.includes(toolName)) s.disabledTools.push(toolName);
        }
        this._writeSettings(s);
        break;
      }

      case "set_compression": {
        const s = this._readSettings();
        const enabled    = Boolean(msg.enabled);
        const triggerPct = Number(msg.triggerPct);
        const keepRecent = Number(msg.keepRecent);
        const provider   = (msg.provider as ProviderName | undefined) ?? undefined;
        const model      = msg.model ? String(msg.model) : undefined;
        s.compression = {
          enabled,
          triggerPct: isNaN(triggerPct) ? 60 : Math.max(10, Math.min(90, triggerPct)),
          keepRecent: isNaN(keepRecent) ? 20 : Math.max(4, Math.min(80, keepRecent)),
          provider,
          model,
        };
        this._writeSettings(s);
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }

      case "set_memory_index": {
        const enabled = Boolean(msg.enabled);
        const s = this._readSettings();
        s.agentMemory = { ...s.agentMemory, enabled };
        this._writeSettings(s);
        if (enabled && !this._memoryIndex) {
          const choice = await vscode.window.showInformationMessage(
            `Agent Memory Index will create a local vector database at .blacksite/memory-index.json ` +
            `to enable semantic search over past agent actions and conversation history. ` +
            `Embedding API calls will be made using your configured provider key.`,
            "Enable",
            "Cancel",
          );
          if (choice !== "Enable") {
            s.agentMemory = { ...s.agentMemory, enabled: false };
            this._writeSettings(s);
            await this._sendSettingsToWebview();
            break;
          }
          this._initMemoryIndex();
        } else if (!enabled) {
          this._disposeMemoryIndex();
        }
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }

      case "get_memory_stats": {
        const stats = this._memoryIndex?.stats ?? { toolCalls: 0, chunks: 0, memories: 0, total: 0 };
        this._post({ type: "memory_stats", stats });
        break;
      }

      case "show_logs":
        this._logger.show();
        break;

      case "export_logs": {
        const logPath = this._logger.getLogPath();
        if (fs.existsSync(logPath)) {
          await vscode.window.showTextDocument(vscode.Uri.file(logPath), { preview: false });
        } else {
          void vscode.window.showInformationMessage("No execution logs yet — run a task first.");
        }
        break;
      }

      case "question_card_answer": {
        const toolCallId = String(msg.toolCallId ?? "");
        const selectedKey = String(msg.selectedKey ?? "");
        if (!toolCallId || !selectedKey) break;
        const resolve = this._pendingQuestionCards.get(toolCallId);
        if (resolve) {
          this._pendingQuestionCards.delete(toolCallId);
          resolve(selectedKey);
        }
        break;
      }

      case "approval_decision": {
        const toolCallId = String(msg.toolCallId ?? "");
        const decision = String(msg.decision ?? "") as ApprovalDecision;
        if (!toolCallId || (decision !== "allow" && decision !== "allow_all" && decision !== "deny")) break;
        const resolve = this._pendingApprovals.get(toolCallId);
        if (resolve) {
          this._pendingApprovals.delete(toolCallId);
          resolve(decision);
        }
        break;
      }

      case "fetch_models": {
        const provider = (msg.provider as ProviderName | undefined) ?? this._readSettings().provider;
        await this._fetchAndSendModels(provider);
        break;
      }

      // ── API keys ──────────────────────────────────────────────────────────────
      case "set_api_key": {
        const provider = String(msg.provider ?? "");
        if (!provider) break;
        const key = await this._secrets.promptForApiKey(provider);
        if (key) {
          const keyStatus = await this._secrets.getProviderStatus();
          this._post({ type: "key_status_update", keyStatus });
          // Auto-fetch models for this provider now that we have a key
          if (this._isValidProvider(provider as ProviderName)) {
            void this._fetchAndSendModels(provider as ProviderName, key);
          }
        }
        break;
      }

      case "clear_api_key": {
        const provider = String(msg.provider ?? "");
        if (!provider) break;
        await this._secrets.deleteApiKey(provider);
        this._modelCache.delete(provider as ProviderName);
        const keyStatus = await this._secrets.getProviderStatus();
        this._post({ type: "key_status_update", keyStatus });
        break;
      }

      // ── OpenRouter config ─────────────────────────────────────────────────────
      case "set_openrouter_config": {
        const s = this._readSettings();
        s.openrouterConfig = {
          ...s.openrouterConfig,
          httpReferer: msg.httpReferer != null ? String(msg.httpReferer).trim() || undefined : s.openrouterConfig?.httpReferer,
          xTitle: msg.xTitle != null ? String(msg.xTitle).trim() || undefined : s.openrouterConfig?.xTitle,
        };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      // ── Subagent settings ─────────────────────────────────────────────────────
      case "set_subagent_provider": {
        const s = this._readSettings();
        const sp = msg.provider as ProviderName | undefined;
        const sm = msg.model != null ? String(msg.model).trim() || undefined : undefined;
        s.subagent = { ...s.subagent, profiles: s.subagent?.profiles ?? [], provider: sp, model: sm };
        this._writeSettings(s);
        this._session = null;
        break;
      }

      case "set_subagent_max_concurrent": {
        const n = Number(msg.maxConcurrent);
        if (isNaN(n) || n < 1) break;
        const s = this._readSettings();
        s.subagent = { ...s.subagent, profiles: s.subagent?.profiles ?? [], maxConcurrent: Math.min(Math.max(1, n), 8) };
        this._writeSettings(s);
        break;
      }

      case "upsert_subagent_profile": {
        const profile = msg.profile as SubagentProfile | undefined;
        if (!profile?.id || !profile.name) break;
        if (profile.builtin) break; // cannot overwrite builtins via this path
        const s = this._readSettings();
        const existing = (s.subagent?.profiles ?? []).findIndex((p) => p.id === profile.id);
        const now = new Date().toISOString();
        const updated: SubagentProfile = { ...profile, updatedAt: now, createdAt: profile.createdAt ?? now };
        if (existing >= 0) {
          const profiles = [...(s.subagent?.profiles ?? [])];
          profiles[existing] = updated;
          s.subagent = { ...s.subagent, profiles, provider: s.subagent?.provider, model: s.subagent?.model };
        } else {
          s.subagent = { ...s.subagent, profiles: [...(s.subagent?.profiles ?? []), updated], provider: s.subagent?.provider, model: s.subagent?.model };
        }
        this._writeSettings(s);
        await this._sendSettingsToWebview();
        break;
      }

      case "delete_subagent_profile": {
        const profileId = String(msg.profileId ?? "").trim();
        if (!profileId) break;
        const s = this._readSettings();
        // Guard: never delete builtins
        const profiles = mergeBuiltinSubagentProfiles(s.subagent?.profiles);
        const target = profiles.find((p) => p.id === profileId);
        if (!target || target.builtin) break;
        s.subagent = { ...s.subagent, profiles: (s.subagent?.profiles ?? []).filter((p) => p.id !== profileId), provider: s.subagent?.provider, model: s.subagent?.model };
        this._writeSettings(s);
        await this._sendSettingsToWebview();
        break;
      }
    }
  }

  // ── Agent send ────────────────────────────────────────────────────────────────

  private async _handleSend(content: string, context?: { text?: string; label?: string }, mentions: string[] = []): Promise<void> {
    const settings = this._readSettings();
    const apiKey   = await this._secrets.getOrPromptApiKey(settings.provider);
    if (!apiKey) {
      this._post({ type: "stream_error", message: `No API key for ${settings.provider}. Set it in Settings.` });
      return;
    }

    if (!this._session) {
      try {
        this._session = await this._createSession(apiKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this._post({ type: "stream_error", message: `Failed to start session: ${message}` });
        return;
      }
      const _ps = this._providerSettings(settings.provider, settings);
      this._logger.sessionStart(this._session.sessionId, _ps.model, settings.provider);
      if (this._restoredSessionState) {
        this._restoreSessionFromState(
          this._session,
          this._restoredSessionState.messages,
          this._restoredSessionState,
          this._restoredSessionState.sessionId,
        );
        this._restoredSessionState = null;
        this._postSessionRuntimeState();
      }
    }

    let fullContent = content;
    const mentionBlock = this._readMentionFiles(mentions);
    if (mentionBlock) {
      fullContent = `${mentionBlock}\n\n${fullContent}`;
    }
    if (context?.text) {
      fullContent = `Context (${context.label ?? "selection"}):\n${context.text}\n\n${fullContent}`;
    }

    await this._continueSend(fullContent, {
      inputChars: fullContent.length,
      promptPreview: content,
      mentionCount: mentions.length,
      contextLabel: context?.label,
    });
  }

  // ── @-file mentions ─────────────────────────────────────────────────────────

  private _readMentionFiles(mentions: string[]): string {
    const seen = new Set<string>();
    const blocks: string[] = [];
    for (const rel of mentions) {
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const abs = path.isAbsolute(rel) ? rel : path.join(this._workspaceRoot, rel);
      try {
        const raw = fs.readFileSync(abs, "utf8").slice(0, 30_000);
        const ext = path.extname(abs).slice(1) || "text";
        blocks.push(`Referenced file \`${rel}\`:\n\`\`\`${ext}\n${raw}\n\`\`\``);
      } catch {
        blocks.push(`Referenced file \`${rel}\`: (could not be read)`);
      }
    }
    return blocks.join("\n\n");
  }

  private _fileIndex: { paths: string[]; at: number } | null = null;

  private async _searchWorkspaceFiles(query: string): Promise<string[]> {
    const FRESH_MS = 8_000;
    if (!this._fileIndex || Date.now() - this._fileIndex.at > FRESH_MS) {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.next,coverage}/**",
        4000,
      );
      const paths = uris
        .map((u) => path.relative(this._workspaceRoot, u.fsPath).replace(/\\/g, "/"))
        .filter((p) => p && !p.startsWith(".."));
      this._fileIndex = { paths, at: Date.now() };
    }

    const q = query.toLowerCase();
    const scored = this._fileIndex.paths
      .map((p) => ({ p, score: scoreMatch(p, q) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || a.p.length - b.p.length)
      .slice(0, 20)
      .map((e) => e.p);
    return scored;
  }

  private async _continueSend(
    content: string,
    meta?: { inputChars: number; promptPreview: string; mentionCount: number; contextLabel?: string },
  ): Promise<void> {
    if (!this._session) return;

    const session = this._session;
    const turnId = `turn_${Date.now()}`;
    const summary: RunSummary = {
      stopReason: "",
      text: "",
      toolCalls: 0,
      approvalPending: false,
      questionPending: false,
      errored: false,
    };

    this._post({ type: "stream_start", id: turnId });
    this._postSessionRuntimeState();
    this._logger.turnStart(turnId, meta);

    let turnError: string | undefined;
    try {
      await this._runner.runWithProgress(
        session,
        content,
        (event: AgentEvent) => {
          if (event.type === "text_delta") summary.text += event.text;
          else if (event.type === "tool_call_start") summary.toolCalls += 1;
          else if (event.type === "approval_pending") summary.approvalPending = true;
          else if (event.type === "question_card_pending") summary.questionPending = true;
          else if (event.type === "turn_complete") summary.stopReason = event.stopReason;
          else if (event.type === "error") summary.errored = true;
          this._handleAgentEvent(event, turnId);
        },
      );
    } catch (err) {
      // Safety net: covers (a) isRunning guard throw, (b) any unhandled rejection
      // that escaped send()'s own try/catch. Without this the webview stays frozen.
      const message = err instanceof Error ? err.message : String(err);
      turnError = message;
      summary.errored = true;
      this._post({ type: "stream_error", id: turnId, message });
    }

    if (!turnError && !summary.stopReason) {
      turnError = "Agent exited without a terminal turn_complete event.";
      this._post({ type: "stream_error", id: turnId, message: turnError });
    } else if (!turnError && (summary.stopReason === "error" || summary.stopReason === "protocol_violation" || summary.stopReason === "cancelled")) {
      turnError = `Terminal stop: ${summary.stopReason}`;
    }

    this._logger.turnEnd(turnId, !turnError, turnError);
    this._persistSession(session);
    this._postSessionRuntimeState();
  }

  private _postStreamEvent(
    turnId: string,
    event: BaseAgentEvent,
    lane?: { laneId: string; parentToolCallId: string },
  ): void {
    const laneMeta = lane ? { laneId: lane.laneId, parentToolCallId: lane.parentToolCallId } : {};
    switch (event.type) {
      case "text_delta":
        this._post({ type: "stream_delta", id: turnId, text: event.text, ...laneMeta });
        break;
      case "thinking_delta":
        this._post({ type: "stream_thinking", id: turnId, text: event.text, ...laneMeta });
        break;
      case "usage_update": {
        const s  = this._readSettings();
        const modelId = this._providerSettings(s.provider, s).model;
        const ctxLen = this._session?.runtimeState.contextLength ?? this._cachedContextLength(s.provider, modelId);
        this._post({ type: "stream_usage", id: turnId, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens, contextLength: ctxLen, ...laneMeta });
        break;
      }
      case "runtime_state":
        if (!lane) this._postSessionRuntimeState(event.state);
        break;
      case "execution_diagnostic":
        this._post({ type: "stream_diagnostic", id: turnId, level: event.level, message: event.message, ...laneMeta });
        break;
      case "iteration_start":
        this._post({ type: "stream_iteration", id: turnId, iteration: event.iteration, ...laneMeta });
        break;
      case "tool_call_start":
        this._post({
          type: "stream_tool_call",
          id: turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          inputPreview: event.inputPreview,
          input: event.input,
          ...laneMeta,
        });
        break;
      case "tool_call_result":
        this._post({
          type: "stream_tool_result",
          id: turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: event.ok,
          summary: event.summary,
          result: event.result,
          elapsedMs: event.elapsedMs,
          ...laneMeta,
        });
        break;
      case "approval_pending":
        this._post({
          type: "stream_approval_pending",
          id: turnId,
          toolCallId: event.toolCallId,
          description: event.description,
          tier: event.tier,
          ...laneMeta,
        });
        break;
      case "approval_result":
        this._post({
          type: "stream_approval_result",
          id: turnId,
          toolCallId: event.toolCallId,
          granted: event.granted,
          decision: event.decision,
          ...laneMeta,
        });
        break;
      case "question_card_pending":
        this._post({
          type: "stream_question_card",
          id: turnId,
          toolCallId: event.toolCallId,
          question: event.question,
          options: event.options,
          context: event.context,
          ...laneMeta,
        });
        break;
      case "question_card_result":
        this._post({
          type: "stream_tool_result",
          id: turnId,
          toolCallId: event.toolCallId,
          toolName: "question_card",
          ok: true,
          summary: `"${event.selectedKey}" selected`,
          result: { ok: true, selectedKey: event.selectedKey },
          elapsedMs: 0,
          ...laneMeta,
        });
        break;
      case "turn_complete":
        this._post({ type: "stream_end", id: turnId, stopReason: event.stopReason, iterations: event.iterations, ...laneMeta });
        break;
      case "error":
        this._post({ type: "stream_error", id: turnId, message: event.message, ...laneMeta });
        break;
    }
  }

  private _handleAgentEvent(event: AgentEvent, turnId: string): void {
    this._logger.logEvent(event);
    switch (event.type) {
      case "subagent_lane_start":
        this._post({
          type: "stream_subagent_lane_start",
          id: turnId,
          parentToolCallId: event.parentToolCallId,
          laneId: event.laneId,
          subRequestId: event.subRequestId,
          label: event.label,
          task: event.task,
        });
        break;
      case "subagent_lane_event":
        this._postStreamEvent(turnId, event.event, {
          laneId: event.laneId,
          parentToolCallId: event.parentToolCallId,
        });
        break;
      case "subagent_lane_complete":
        this._post({
          type: "stream_subagent_lane_end",
          id: turnId,
          parentToolCallId: event.parentToolCallId,
          laneId: event.laneId,
          subRequestId: event.subRequestId,
          label: event.label,
          ok: event.ok,
          answer: event.answer,
          error: event.error,
          elapsedMs: event.elapsedMs,
          stopReason: event.stopReason,
          toolRounds: event.toolRounds,
          budget: event.budget,
        });
        break;
      default:
        this._postStreamEvent(turnId, event);
        break;
    }
  }

  // ── Settings helpers ──────────────────────────────────────────────────────────

  private _readSettings(): ExtendedSettings {
    const stored = this._context.globalState.get<ExtendedSettings>(SETTINGS_KEY);
    // Check for legacy single-key settings and migrate
    if (!stored) {
      const legacyProvider = this._context.globalState.get<string>("blacksite.provider") as ProviderName | undefined;
      const legacyModel    = this._context.globalState.get<string>("blacksite.model");
      const s: ExtendedSettings = {
        provider: legacyProvider ?? this._readCfgProvider(),
        providerSettings: {},
        maxIterations: 40,
        disabledTools: [],
      };
      if (legacyModel) s.providerSettings[s.provider] = { ...PROVIDER_DEFAULTS[s.provider], model: legacyModel };
      return s;
    }
    return stored;
  }

  private _writeSettings(s: ExtendedSettings): void {
    void this._context.globalState.update(SETTINGS_KEY, s);
  }

  private _providerSettings(provider: ProviderName, s: ExtendedSettings): ProviderSettings {
    return { ...PROVIDER_DEFAULTS[provider], ...s.providerSettings[provider] };
  }

  private _lookupModelInfo(modelId: string, models?: ModelInfo[]): ModelInfo | undefined {
    return models?.find((model) => modelIdsMatch(model.id, modelId));
  }

  private _cachedContextLength(provider: ProviderName, modelId: string): number | undefined {
    const cached = this._lookupModelInfo(modelId, this._modelCache.get(provider));
    return cached?.contextLength ?? getContextLength(provider, modelId);
  }

  private async _resolveContextLength(
    provider: ProviderName,
    modelId: string,
    apiKey?: string,
  ): Promise<number | undefined> {
    const cached = this._cachedContextLength(provider, modelId);
    if (cached) return cached;
    if (!apiKey) return undefined;

    try {
      const models = await fetchModels(provider, apiKey);
      this._modelCache.set(provider, models);
      return this._lookupModelInfo(modelId, models)?.contextLength;
    } catch {
      return undefined;
    }
  }

  private _readCfgProvider(): ProviderName {
    const cfg = vscode.workspace.getConfiguration("blacksite");
    const cp  = cfg.get<string>("provider");
    if (cp === "anthropic" || cp === "openrouter" || cp === "openai") return cp;
    return "anthropic";
  }

  private _isValidProvider(p: unknown): p is ProviderName {
    return p === "anthropic" || p === "openrouter" || p === "openai";
  }

  private async _sendSettingsToWebview(): Promise<void> {
    const settings    = this._readSettings();
    const keyStatus   = await this._secrets.getProviderStatus();
    const models      = this._modelCache.get(settings.provider) ?? getFallbackModels(settings.provider);
    const memoryStats = this._memoryIndex?.stats ?? null;
    const logStats: LogStats = this._logger.stats;

    this._post({
      type: "settings_data",
      settings,
      keyStatus,
      models,
      memoryStats,
      logStats,
    });
  }

  private async _fetchAndSendModels(provider: ProviderName, knownKey?: string): Promise<void> {
    this._post({ type: "models_loading", provider });
    try {
      const apiKey = knownKey ?? await this._secrets.getApiKey(provider);
      if (!apiKey) {
        this._post({ type: "models_data", provider, models: getFallbackModels(provider), source: "fallback", error: "No API key" });
        return;
      }
      const models = await fetchModels(provider, apiKey);
      this._modelCache.set(provider, models);
      this._post({ type: "models_data", provider, models, source: "api" });
    } catch (err) {
      const fallback = getFallbackModels(provider);
      this._post({ type: "models_data", provider, models: fallback, source: "fallback", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Session restore ────────────────────────────────────────────────────────────

  private _restoreSessionToWebview(): void {
    const stored = this._sessionStore.loadActive();
    if (!stored?.messages.length) return;

    const userAssistantOnly = stored.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    this._post({ type: "history_restored", messages: userAssistantOnly });
    if (this._session) {
      this._postSessionRuntimeState();
    } else if (stored.state?.contextLength || stored.state?.compressionCount || stored.state?.lastInputTokens) {
      this._post({
        type: "session_runtime",
        runtime: this._buildRuntimeFromStoredSession(stored.sessionId, stored.messages, stored.state),
      });
    }

    if (!this._session) {
      this._restoredSessionState = { sessionId: stored.sessionId, messages: stored.messages, ...(stored.state ?? {}) };
    }
  }

  // ── Question card ─────────────────────────────────────────────────────────────

  private _createQuestionCardPromise(
    toolCallId: string,
    _question: string,
    _options: QCardOption[],
    _context?: string,
    signal: AbortSignal | undefined = this._runner.signal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this._pendingQuestionCards.set(toolCallId, resolve);
      // The question_card_pending AgentEvent already caused _handleAgentEvent to post
      // stream_question_card to the webview — this Promise just holds the resolver until
      // the user answers and question_card_answer arrives in _onMessage.
      const onAbort = (): void => {
        this._pendingQuestionCards.delete(toolCallId);
        reject(new Error("Cancelled."));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  // ── Util ──────────────────────────────────────────────────────────────────────

  private _createApprovalPromise(
    toolCallId: string,
    _toolName: string,
    _description: string,
    _tier: string,
    signal: AbortSignal | undefined = this._runner.signal,
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      this._pendingApprovals.set(toolCallId, resolve);
      const onAbort = (): void => {
        this._pendingApprovals.delete(toolCallId);
        reject(new Error("Cancelled."));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private _post(msg: unknown): void {
    void this._view?.webview.postMessage(msg);
  }

  private _loadHtml(webview: vscode.Webview): string {
    return renderWebviewHtml(webview, this._context.extensionUri, "webview.js");
  }
}

/** Rank a relative path against a lowercased query: basename hits beat path hits, prefixes beat substrings. */
function scoreMatch(relPath: string, query: string): number {
  if (!query) return 1; // empty query → show everything (recent index order)
  const lower = relPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === query) return 100;
  if (base.startsWith(query)) return 80;
  if (base.includes(query)) return 60;
  if (lower.includes(query)) return 40;
  // Subsequence fallback (fuzzy): characters of query appear in order.
  let qi = 0;
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower[i] === query[qi]) qi++;
  }
  return qi === query.length ? 20 : 0;
}
