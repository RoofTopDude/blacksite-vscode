/* Central webview store. Holds all UI + conversation state, dispatches incoming
   host messages into the chat model, and exposes typed actions that post back.
   Subscribed via useSyncExternalStore over a monotonic version counter. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSyncExternalStore } from "react";
import { post as rawPost, onMessage } from "./bridge";
import { countLabel, readNum, readStr } from "./format";
import { defaultBedrockModel } from "../../../bedrock-config.js";
import type {
  ApprovalDecision, ClaudeEffort, ExtendedSettings, HistorySession, IncomingMessage, KeyStatus, LogStats,
  MemoryStats, ModelInfo, OpenRouterConfig, OutgoingMessage, ProviderName, QCardOption, ReasoningEffort,
  ReferenceAttachmentInfo, ServiceTier, SubagentProfile, SubagentSettings, TranscriptDocumentData,
} from "./protocol";

/** Typed post — narrows to the chat webview's outbound protocol. */
function post(message: OutgoingMessage): void {
  rawPost(message);
}
import {
  addQuestionCard, answerQuestionCard, appendText, appendThinking, applyApprovalPending,
  applyApprovalResult, applyDiagnostic, applyToolResult, chooseApprovalDecision, createChatState, createUserTurn,
  ensureLaneTurn, ensureParentLiveTurn, ensureToolCall, finalizeThinking, finalizeTurn, lastUserPrompt,
  resetConversation, resetLiveResponse, resolveStreamTurn, restoreConversation, type ChatState,
} from "./chat-model";
import { resolveSlashCommand } from "./slash-commands";
import { emptyCost, emptyUsage, type CostTotals, type UsageTotals } from "./tokens";
import { findModelByQuery } from "../components/settings/helpers";

export type ViewName = "chat" | "history" | "settings";

export interface Lightbox {
  dataUrl: string;
  label: string;
}

/** A question-card option preview expanded to a full-page overlay — either the user clicked
 *  its expand affordance, or SandboxPreview auto-opened it (see openPreviewModal callers). */
export interface PreviewModalState {
  label: string;
  preview: NonNullable<QCardOption["preview"]>;
}

export interface Store {
  view: ViewName;
  inspectorOpen: boolean;
  chat: ChatState;
  settings: ExtendedSettings;
  keyStatus: KeyStatus;
  allModels: ModelInfo[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** Live listing succeeded but is incomplete (e.g. Bedrock hid models the account cannot
      invoke on-demand). Not an error — the list on screen is real, not a fallback. */
  modelsNotice: string | null;
  /** Per-provider model cache — populated whenever any provider's models are fetched. */
  providerModels: Partial<Record<ProviderName, ModelInfo[]>>;
  /** Per-provider loading state for independent fetches. */
  providerModelsLoading: Partial<Record<ProviderName, boolean>>;
  /** When each provider's models last arrived — drives refreshModels' short TTL. */
  providerModelsFetchedAt: Partial<Record<ProviderName, number>>;
  memoryStats: MemoryStats | null;
  logStats: LogStats | null;
  history: HistorySession[];
  pendingCtx: { text?: string; label?: string } | null;
  mentionItems: string[];
  mentionQuery: string;
  lightbox: Lightbox | null;
  previewModal: PreviewModalState | null;
  focusNonce: number;
  /** A follow-up message typed while the agent is running; auto-sent when the turn ends. */
  queuedMessage: string | null;
  /** Whether the slash-command help panel is pinned open. */
  slashHelpOpen: boolean;
  /** Aggregate token usage accumulated from provider usage events this session. */
  sessionUsage: UsageTotals;
  /** Aggregate estimated spend accumulated from provider usage events this session (see
      estimateUsageCostUsd in model-fetcher.ts — computed host-side, per event). */
  sessionCost: CostTotals;
  /** Files already ingested into permanent per-conversation storage, staged for the next send. */
  pendingAttachments: ReferenceAttachmentInfo[];
  /** Set while a picked/pasted file is being copied + extracted host-side. */
  attaching: boolean;
  attachError: string | null;
  /** Full text is fetched only after a document card expands. */
  transcriptDocuments: Record<string, TranscriptDocumentData>;
}

const defaultSettings: ExtendedSettings = {
  provider: "anthropic",
  providerSettings: {},
  maxIterations: 40,
  disabledTools: [],
  compression: null,
};

export const store: Store = {
  view: "chat",
  inspectorOpen: false,
  chat: createChatState(),
  settings: defaultSettings,
  keyStatus: {},
  allModels: [],
  modelsLoading: false,
  modelsError: null,
  modelsNotice: null,
  providerModels: {},
  providerModelsLoading: {},
  providerModelsFetchedAt: {},
  memoryStats: null,
  logStats: null,
  history: [],
  pendingCtx: null,
  mentionItems: [],
  mentionQuery: "",
  lightbox: null,
  previewModal: null,
  focusNonce: 0,
  queuedMessage: null,
  slashHelpOpen: false,
  sessionUsage: emptyUsage(),
  sessionCost: emptyCost(),
  pendingAttachments: [],
  attaching: false,
  attachError: null,
  transcriptDocuments: {},
};

let version = 0;
const listeners = new Set<() => void>();
let bumpScheduled = false;

function bump(): void {
  // Host streams can deliver many token events in one frame. Coalesce store
  // notifications so React renders at most roughly once per animation-sized
  // slice instead of once per token.
  if (bumpScheduled) return;
  bumpScheduled = true;
  setTimeout(() => {
    bumpScheduled = false;
    version += 1;
    for (const l of listeners) l();
  }, 16);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return version;
}

/** Subscribe a component to all store changes. Returns the live store object. */
export function useStore(): Store {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return store;
}

/* ── Incoming host messages ───────────────────────────────────────────── */

function handleIncoming(msg: IncomingMessage): void {
  const chat = store.chat;
  switch (msg.type) {
    case "history_restored":
      store.sessionUsage = emptyUsage();
      store.sessionCost = emptyCost();
      store.transcriptDocuments = {};
      if (msg.messages?.length) restoreConversation(chat, msg.messages);
      else { resetConversation(chat); chat.running = false; }
      break;

    case "inject_context":
      store.pendingCtx = { text: msg.text, label: msg.label };
      store.focusNonce += 1;
      break;

    case "stream_start":
      chat.running = true;
      if (!chat.currentLiveTurnId) ensureParentLiveTurn(chat, msg.id);
      break;

    case "stream_subagent_lane_start":
      ensureLaneTurn(chat, msg);
      break;

    case "stream_iteration": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) turn.iterations = Math.max(turn.iterations, readNum(msg.iteration) || 0);
      break;
    }

    case "stream_thinking": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) appendThinking(turn, String(msg.text || ""));
      break;
    }

    case "stream_usage": {
      const it = readNum(msg.inputTokens) ?? 0;
      const cr = readNum(msg.cacheReadTokens) ?? 0;
      const cw = readNum(msg.cacheWriteTokens) ?? 0;
      const out = readNum(msg.outputTokens) ?? 0;
      const totalInput = it + cr + cw;
      const cl = readNum(msg.contextLength) ?? 0;
      if (cl > 0) chat.sessionContextLength = cl;
      if (totalInput > 0) chat.lastInputTokens = totalInput;
      // Accumulate authoritative per-call usage into the live session total.
      const u = store.sessionUsage;
      store.sessionUsage = { input: u.input + it, output: u.output + out, cacheRead: u.cacheRead + cr, cacheWrite: u.cacheWrite + cw };
      // Cost is computed host-side per event (the only place that knows which model was active
      // for this exact call — see estimateUsageCostUsd). A billed event with no costUsd at all
      // means the model had no known pricing whatsoever, which also makes the running total partial.
      const billedTokens = it + out + cr + cw > 0;
      const priced = msg.costUsd != null;
      store.sessionCost = {
        usd: store.sessionCost.usd + (readNum(msg.costUsd) ?? 0),
        partial: store.sessionCost.partial || !!msg.costPartial || (billedTokens && !priced),
      };
      break;
    }

    case "session_runtime": {
      const runtime = msg.runtime || null;
      chat.sessionRuntime = runtime;
      const ctxLen = readNum(runtime?.contextLength);
      const inputTokens = readNum(runtime?.lastInputTokens);
      if (ctxLen != null && ctxLen > 0) chat.sessionContextLength = ctxLen;
      if (inputTokens != null && inputTokens >= 0) chat.lastInputTokens = inputTokens;
      break;
    }

    case "stream_diagnostic": {
      const turn = readStr(msg.laneId) ? ensureLaneTurn(chat, msg) : store.chat.byId.get(chat.currentLiveTurnId || "") || null;
      if (turn) applyDiagnostic(turn, readStr(msg.level) || "info", readStr(msg.message) || "");
      break;
    }

    case "stream_delta": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) appendText(turn, String(msg.text || ""));
      break;
    }

    case "stream_reset": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) {
        resetLiveResponse(turn);
        // The retry notice itself arrives separately as a stream_diagnostic from the provider
        // layer, so the user sees *why* the answer restarted rather than it silently vanishing.
      }
      break;
    }

    case "stream_tool_call": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) ensureToolCall(chat, turn, { toolCallId: msg.toolCallId, toolName: msg.toolName, input: msg.input || {}, inputPreview: msg.inputPreview || "" });
      break;
    }

    case "stream_tool_result": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) {
        const call = ensureToolCall(chat, turn, { toolCallId: msg.toolCallId, toolName: msg.toolName, input: {} });
        applyToolResult(turn, call, msg.result, msg.elapsedMs);
      }
      break;
    }

    case "stream_approval_pending": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) {
        applyApprovalPending(
          chat,
          turn,
          msg.toolCallId || `approval_${Date.now()}`,
          String(msg.description || "Approval required"),
          String(msg.tier || ""),
          !!msg.unrecognizedCommand,
        );
      }
      break;
    }

    case "stream_approval_result": {
      const turn = readStr(msg.laneId) ? ensureLaneTurn(chat, msg) : store.chat.byId.get(chat.currentLiveTurnId || "") || null;
      if (turn) {
        applyApprovalResult(
          turn,
          msg.toolCallId || "",
          !!msg.granted,
          (msg.decision as ApprovalDecision | undefined) ?? (msg.granted ? "allow" : "deny"),
        );
      }
      break;
    }

    case "stream_question_card": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) addQuestionCard(chat, turn, String(msg.toolCallId || ""), Array.isArray(msg.questions) ? msg.questions : []);
      break;
    }

    case "stream_end": {
      const laneId = readStr(msg.laneId);
      const turn = laneId ? ensureLaneTurn(chat, msg) : store.chat.byId.get(chat.currentLiveTurnId || "") || null;
      if (turn) {
        finalizeThinking(turn);
        finalizeTurn(turn, { status: "complete", stopReason: String(msg.stopReason || ""), iterations: readNum(msg.iterations) ?? undefined });
      }
      if (!laneId) { chat.currentLiveTurnId = null; chat.running = false; flushQueuedMessage(); }
      break;
    }

    case "stream_subagent_lane_end": {
      const lane = ensureLaneTurn(chat, msg);
      if (lane) {
        if (readStr(msg.label)) lane.label = readStr(msg.label);
        if (readStr(msg.error)) lane.errorMessage = readStr(msg.error);
        if (!lane.raw && readStr(msg.answer)) appendText(lane, String(msg.answer));
        if (lane.status === "streaming") finalizeTurn(lane, { status: msg.ok === false ? "error" : "complete", stopReason: String(msg.stopReason || "") });
      }
      break;
    }

    case "stream_error": {
      const laneId = readStr(msg.laneId);
      if (laneId) {
        const turn = ensureLaneTurn(chat, msg);
        if (turn) {
          finalizeThinking(turn);
          turn.errorMessage = String(msg.message || "Unknown error");
          appendText(turn, `\n\n**Error:** ${String(msg.message || "Unknown error")}`);
          finalizeTurn(turn, { status: "error" });
        }
      } else {
        chat.lastConversationError = String(msg.message || "Unknown error");
        const live = store.chat.byId.get(chat.currentLiveTurnId || "") || null;
        if (live) {
          finalizeThinking(live);
          live.errorMessage = chat.lastConversationError;
          appendText(live, `\n\n**Error:** ${chat.lastConversationError}`);
          finalizeTurn(live, { status: "error" });
          chat.currentLiveTurnId = null;
        }
        chat.running = false;
      }
      break;
    }

    case "clear":
      chat.sessionContextLength = 0;
      chat.lastInputTokens = 0;
      chat.sessionRuntime = null;
      resetConversation(chat);
      chat.running = false;
      store.view = "chat";
      store.queuedMessage = null;
      store.slashHelpOpen = false;
      store.sessionUsage = emptyUsage();
      store.sessionCost = emptyCost();
      store.transcriptDocuments = {};
      break;

    case "settings_data":
      if (msg.settings) store.settings = msg.settings;
      store.keyStatus = msg.keyStatus || {};
      store.allModels = msg.models || [];
      if (msg.settings?.provider && msg.models) {
        store.providerModels = { ...store.providerModels, [msg.settings.provider]: msg.models };
      }
      store.memoryStats = msg.memoryStats || null;
      store.logStats = msg.logStats || null;
      store.modelsError = null;
      store.modelsNotice = null;
      store.modelsLoading = false;
      break;

    case "memory_stats":
      store.memoryStats = msg.stats || null;
      break;

    case "models_loading":
      if (msg.provider) {
        store.providerModelsLoading = { ...store.providerModelsLoading, [msg.provider]: true };
      }
      store.modelsLoading = true;
      store.modelsError = null;
      store.modelsNotice = null;
      break;

    case "models_data": {
      const p = msg.provider;
      if (p) {
        store.providerModelsLoading = { ...store.providerModelsLoading, [p]: false };
        if (msg.models) store.providerModels = { ...store.providerModels, [p]: msg.models };
        // Only a real API listing counts as "fresh" — a fallback (no key, fetch error)
        // must not suppress the next open's retry via the TTL.
        if (msg.source === "api") store.providerModelsFetchedAt = { ...store.providerModelsFetchedAt, [p]: Date.now() };
      }
      store.modelsLoading = false;
      if (p === store.settings.provider) {
        store.allModels = msg.models || [];
        store.modelsError = msg.error || null;
        store.modelsNotice = msg.notice || null;
      }
      break;
    }

    case "history_data":
      store.history = msg.sessions || [];
      break;

    case "key_status_update":
      store.keyStatus = msg.keyStatus || {};
      break;

    case "files_data":
      store.mentionItems = Array.isArray(msg.files) ? msg.files : [];
      store.mentionQuery = typeof msg.query === "string" ? msg.query : "";
      break;

    case "attachments_added":
      store.attaching = false;
      store.attachError = null;
      if (msg.attachments?.length) {
        const existing = new Set(store.pendingAttachments.map((a) => a.id));
        store.pendingAttachments = [
          ...store.pendingAttachments,
          ...msg.attachments.filter((a) => !existing.has(a.id)),
        ];
      }
      break;

    case "attach_error":
      store.attaching = false;
      store.attachError = msg.message || "Failed to attach file.";
      break;

    case "transcript_document_data":
      store.transcriptDocuments = {
        ...store.transcriptDocuments,
        [msg.documentId]: { documentId: msg.documentId, markdown: msg.markdown, error: msg.error },
      };
      break;
  }
  bump();
}

/* ── Actions (webview → host) ─────────────────────────────────────────── */

export const actions = {
  setView(view: ViewName): void {
    store.view = view;
    if (view === "settings") post({ type: "get_settings" });
    if (view === "history") post({ type: "get_history" });
    bump();
  },
  toggleInspector(): void {
    store.inspectorOpen = !store.inspectorOpen;
    bump();
  },
  setPendingCtx(ctx: { text?: string; label?: string } | null): void {
    store.pendingCtx = ctx;
    bump();
  },
  sendMessage(text: string, mentions: string[]): void {
    const trimmed = text.trim();
    const attachments = store.pendingAttachments.map((a) => a.id);
    if ((!trimmed && attachments.length === 0) || store.chat.running) return;
    const ctx = store.pendingCtx;
    store.pendingCtx = null;
    store.pendingAttachments = [];
    store.chat.lastConversationError = "";
    store.chat.running = true;
    const labelParts = [
      ctx?.label,
      mentions.length ? countLabel(mentions.length, "file") : null,
      attachments.length ? countLabel(attachments.length, "attachment") : null,
    ].filter(Boolean);
    createUserTurn(store.chat, trimmed, labelParts.length ? labelParts.join(", ") : null);
    store.chat.currentLiveTurnId = null;
    bump();
    post({ type: "send_message", payload: { content: trimmed, context: ctx, mentions, attachments } });
  },
  cancel(): void { post({ type: "cancel_current" }); },
  newChat(): void { post({ type: "new_chat" }); },
  compact(): void { post({ type: "compact_conversation" }); },
  requestFiles(query: string): void { post({ type: "request_files", query }); },

  /** Trigger the host's native file picker to attach files to the current conversation. */
  requestAttachFiles(): void {
    store.attaching = true;
    store.attachError = null;
    bump();
    post({ type: "request_attach_files" });
  },
  /** Attach a pasted/dropped file (e.g. a clipboard image) not already on disk. */
  attachPastedFile(name: string, mimeType: string, base64: string): void {
    store.attaching = true;
    store.attachError = null;
    bump();
    post({ type: "attach_pasted_file", payload: { name, mimeType, base64 } });
  },
  /** Un-stage a pending attachment from the next send. The permanently-stored copy is untouched. */
  removeAttachment(id: string): void {
    store.pendingAttachments = store.pendingAttachments.filter((a) => a.id !== id);
    bump();
    post({ type: "remove_attachment", id });
  },
  clearAttachError(): void { store.attachError = null; bump(); },
  loadTranscriptDocument(documentId: string): void { post({ type: "load_transcript_document", documentId }); },
  openTranscriptDocument(documentId: string): void { post({ type: "open_transcript_document", documentId }); },

  /** Queue a follow-up while a run is in flight; flushed automatically when the turn ends. */
  queueMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    store.queuedMessage = trimmed;
    bump();
  },
  clearQueuedMessage(): void { store.queuedMessage = null; bump(); },
  /** Send a queued message immediately (used when a run ends in error and won't auto-flush). */
  flushQueuedNow(): void { flushQueuedMessage(); },
  /** Resend the most recent user prompt. */
  retryLast(): void {
    if (store.chat.running) return;
    const prompt = lastUserPrompt(store.chat);
    if (prompt) actions.sendMessage(prompt, []);
  },
  toggleSlashHelp(open?: boolean): void {
    store.slashHelpOpen = open ?? !store.slashHelpOpen;
    bump();
  },
  /** Switch the active model from a free-text query (e.g. `/model sonnet`). */
  switchModelByQuery(query: string): void {
    const q = query.trim();
    if (!q) { actions.setView("settings"); return; }
    const match = findModelByQuery(store.allModels, q);
    actions.setModel(store.settings.provider, match?.id ?? q);
  },
  /** Dispatch a parsed slash command to its action. */
  runSlashCommand(name: string, arg: string): void {
    const def = resolveSlashCommand(name);
    if (!def) return;
    switch (def.name) {
      case "clear": actions.newChat(); break;
      case "compact": actions.compact(); break;
      case "model": actions.switchModelByQuery(arg); break;
      case "retry": actions.retryLast(); break;
      case "settings": actions.setView("settings"); break;
      case "history": actions.setView("history"); break;
      case "help": actions.toggleSlashHelp(true); break;
    }
  },
  loadSession(sessionId: string): void { post({ type: "load_session", sessionId }); store.view = "chat"; bump(); },
  deleteSession(sessionId: string): void { post({ type: "delete_session", sessionId }); },
  answerQuestion(turnId: string, toolCallId: string, questionIndex: number, selectedKeys: string[]): void {
    const turn = store.chat.byId.get(turnId);
    if (turn) { answerQuestionCard(turn, toolCallId, questionIndex, selectedKeys); bump(); }
    post({ type: "question_card_answer", toolCallId, questionIndex, selectedKeys });
  },
  answerApproval(turnId: string, toolCallId: string, decision: ApprovalDecision, command?: string, scope?: "workspace" | "global"): void {
    const turn = store.chat.byId.get(turnId);
    if (turn) { chooseApprovalDecision(turn, toolCallId, decision); bump(); }
    post({ type: "approval_decision", toolCallId, decision, command, scope });
  },
  openLightbox(dataUrl: string, label: string): void { store.lightbox = { dataUrl, label }; bump(); },
  /**
   * Best-effort "show me more" from a docked PendingBar item: switches to the chat view
   * and scrolls the owning tool/question card into view if it's currently rendered. If the
   * target is behind a collapsed ToolLog summary (not mounted yet), falls back to the lane
   * or turn container — the docked bar's own Allow/Deny/answer buttons are always the real
   * way to act, so this is a convenience, not the fix's load-bearing path.
   */
  revealInThread(turnId: string, toolCallId: string, laneId?: string | null): void {
    actions.setView("chat");
    requestAnimationFrame(() => {
      const el = document.getElementById(`tool-${toolCallId}`)
        ?? document.getElementById(laneId ? `lane-${laneId}` : `turn-${turnId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  },
  closeLightbox(): void { store.lightbox = null; bump(); },
  openPreviewModal(label: string, preview: NonNullable<QCardOption["preview"]>): void { store.previewModal = { label, preview }; bump(); },
  closePreviewModal(): void { store.previewModal = null; bump(); },
  openFile(filePath: string, line?: number): void { post({ type: "open_file", path: filePath, line }); },
  // Settings
  setProvider(provider: ProviderName): void { post({ type: "set_active_provider", provider }); },
  setModel(provider: ProviderName, model: string): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), model } } };
    bump();
    post({ type: "set_provider_model", provider, model });
  },
  setTemperature(provider: ProviderName, temperature: number): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), temperature } } };
    bump();
    post({ type: "set_temperature", provider, temperature });
  },
  setMaxTokens(provider: ProviderName, maxTokens: number): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), maxTokens } } };
    bump();
    post({ type: "set_max_tokens", provider, maxTokens });
  },
  setMaxTokensUnlimited(provider: ProviderName, unlimited: boolean): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), maxTokensUnlimited: unlimited } } };
    bump();
    post({ type: "set_max_tokens_unlimited", provider, unlimited });
  },
  setThinking(provider: ProviderName, enabled: boolean, budgetTokens: number, effort?: ClaudeEffort): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), thinking: { enabled, budgetTokens, effort } } } };
    bump();
    post({ type: "set_thinking", provider, enabled, budgetTokens, effort });
  },
  setReasoningEffort(provider: ProviderName, effort: ReasoningEffort): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), reasoningEffort: effort } } };
    bump();
    post({ type: "set_reasoning_effort", provider, effort });
  },
  setServiceTier(provider: ProviderName, tier: ServiceTier): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), serviceTier: tier } } };
    bump();
    post({ type: "set_service_tier", provider, tier });
  },
  setBaseUrl(provider: ProviderName, baseUrl: string): void {
    const trimmed = baseUrl.trim();
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), baseUrl: trimmed || undefined } } };
    bump();
    post({ type: "set_base_url", provider, baseUrl: trimmed });
  },
  setCacheTtl(provider: ProviderName, ttl: "5m" | "1h"): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), cacheTtl: ttl === "1h" ? "1h" : undefined } } };
    bump();
    post({ type: "set_cache_ttl", provider, ttl });
  },
  setFastMode(provider: ProviderName, enabled: boolean): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), fastMode: enabled } } };
    bump();
    post({ type: "set_fast_mode", provider, enabled });
  },
  setTaskBudget(provider: ProviderName, tokens: number): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), taskBudgetTokens: tokens || undefined } } };
    bump();
    post({ type: "set_task_budget", provider, tokens });
  },
  setContextEditing(provider: ProviderName, enabled: boolean): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), contextEditingEnabled: enabled } } };
    bump();
    post({ type: "set_context_editing", provider, enabled });
  },
  setRefusalFallback(provider: ProviderName, enabled: boolean): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), refusalFallbackEnabled: enabled } } };
    bump();
    post({ type: "set_refusal_fallback", provider, enabled });
  },
  setCompaction(provider: ProviderName, tokens: number): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), compactionTriggerTokens: tokens || undefined } } };
    bump();
    post({ type: "set_compaction", provider, tokens });
  },
  setResponsesApi(provider: ProviderName, enabled: boolean): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), useResponsesApi: enabled } } };
    bump();
    post({ type: "set_responses_api", provider, enabled });
  },
  setMaxIterations(maxIterations: number): void {
    store.settings = { ...store.settings, maxIterations };
    bump();
    post({ type: "set_max_iterations", maxIterations });
  },
  toggleTool(toolName: string, enabled: boolean): void {
    const disabled = new Set(store.settings.disabledTools);
    if (enabled) disabled.delete(toolName); else disabled.add(toolName);
    store.settings = { ...store.settings, disabledTools: [...disabled] };
    bump();
    post({ type: "toggle_tool", toolName, enabled });
  },
  toggleAllTools(allToolNames: string[], enabled: boolean): void {
    store.settings = { ...store.settings, disabledTools: enabled ? [] : [...allToolNames] };
    bump();
    for (const toolName of allToolNames) post({ type: "toggle_tool", toolName, enabled });
  },
  setCompression(opts: { enabled: boolean; triggerPct: number; keepRecent: number; provider?: ProviderName; model?: string }): void {
    post({ type: "set_compression", ...opts });
  },
  setMemoryIndex(enabled: boolean): void { post({ type: "set_memory_index", enabled }); },
  setEmbedding(opts: { provider?: ProviderName | "voyage"; model?: string; dims?: number }): void {
    post({ type: "set_embedding", ...opts });
  },
  rebuildEmbeddings(): void { post({ type: "rebuild_embeddings" }); },
  setVisionFallback(opts: { provider?: ProviderName; model?: string }): void {
    post({ type: "set_vision_fallback", ...opts });
  },
  clearVisionFallback(): void { post({ type: "set_vision_fallback" }); },
  fetchModels(provider: ProviderName): void { post({ type: "fetch_models", provider }); },
  fetchModelsForProvider(provider: ProviderName): void {
    store.providerModelsLoading = { ...store.providerModelsLoading, [provider]: true };
    bump();
    post({ type: "fetch_models", provider });
  },
  /**
   * Keep a rendered model list live: called whenever a view containing one opens.
   * Always refetches from the provider API unless a fetch is already in flight or
   * one landed within the last 30s (rapid open/close/open shouldn't hammer the API).
   * Stale-while-revalidate — the cached list stays rendered while the refresh runs.
   * Pass force for explicit Refresh buttons, which should always hit the API.
   */
  refreshModels(provider: ProviderName, opts: { force?: boolean } = {}): void {
    if (store.providerModelsLoading[provider]) return;
    const fetchedAt = store.providerModelsFetchedAt[provider] ?? 0;
    if (!opts.force && Date.now() - fetchedAt < 30_000) return;
    store.providerModelsLoading = { ...store.providerModelsLoading, [provider]: true };
    bump();
    post({ type: "fetch_models", provider });
  },
  setApiKey(provider: string): void { post({ type: "set_api_key", provider }); },
  clearApiKey(provider: string): void { post({ type: "clear_api_key", provider }); },
  showLogs(): void { post({ type: "show_logs" }); },
  exportLogs(): void { post({ type: "export_logs" }); },
  openSettings(query?: string): void { post({ type: "open_settings", query }); },

  // ── Bedrock API mode ────────────────────────────────────────────────────────
  setBedrockApi(api: "converse" | "mantle"): void {
    store.settings = { ...store.settings, bedrockApi: api };
    bump();
    post({ type: "set_bedrock_api", api });
  },

  // ── OpenRouter config ───────────────────────────────────────────────────────
  setOpenRouterConfig(cfg: OpenRouterConfig): void {
    store.settings = { ...store.settings, openrouterConfig: { ...store.settings.openrouterConfig, ...cfg } };
    bump();
    post({ type: "set_openrouter_config", ...cfg });
  },

  // ── Subagent settings ───────────────────────────────────────────────────────
  setSubagentProvider(provider: ProviderName | undefined, model: string | undefined): void {
    const cur = store.settings.subagent ?? { profiles: [] };
    store.settings = { ...store.settings, subagent: { ...cur, provider, model } };
    bump();
    post({ type: "set_subagent_provider", provider, model });
  },
  setSubagentMaxConcurrent(maxConcurrent: number): void {
    const cur = store.settings.subagent ?? { profiles: [] };
    store.settings = { ...store.settings, subagent: { ...cur, maxConcurrent } };
    bump();
    post({ type: "set_subagent_max_concurrent", maxConcurrent });
  },
  upsertSubagentProfile(profile: SubagentProfile): void {
    const cur: SubagentSettings = store.settings.subagent ?? { profiles: [] };
    const existing = cur.profiles.findIndex((p) => p.id === profile.id);
    const profiles = existing >= 0
      ? cur.profiles.map((p) => p.id === profile.id ? profile : p)
      : [...cur.profiles, profile];
    store.settings = { ...store.settings, subagent: { ...cur, profiles } };
    bump();
    post({ type: "upsert_subagent_profile", profile });
  },
  deleteSubagentProfile(profileId: string): void {
    const cur: SubagentSettings = store.settings.subagent ?? { profiles: [] };
    store.settings = { ...store.settings, subagent: { ...cur, profiles: cur.profiles.filter((p) => p.id !== profileId) } };
    bump();
    post({ type: "delete_subagent_profile", profileId });
  },
};

/** Send the queued follow-up once the run has settled. No-op if empty or still running. */
function flushQueuedMessage(): void {
  const text = store.queuedMessage;
  if (!text || store.chat.running) return;
  store.queuedMessage = null;
  actions.sendMessage(text, []);
}

function baseProviderSettings(provider: ProviderName) {
  switch (provider) {
    case "anthropic":
      return { model: "claude-sonnet-4-6", temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000, effort: "high" } };
    case "openrouter":
      return { model: "anthropic/claude-sonnet-4-6", temperature: 1, maxTokens: 8192 };
    case "openai":
      return { model: "gpt-4o", temperature: 1, maxTokens: 8192, reasoningEffort: "medium" as const };
    case "bedrock":
      return { model: defaultBedrockModel(store.settings.bedrockApi), temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000, effort: "high" } };
  }
}

export function curProvider(provider: ProviderName) {
  const base = baseProviderSettings(provider);
  const merged = { ...base, ...(store.settings.providerSettings[provider] || {}) };
  if (!merged.model?.trim()) merged.model = base.model;
  return merged;
}

let started = false;
/** Wire the message listener and announce readiness. Idempotent. */
export function initStore(): void {
  if (started) return;
  started = true;
  onMessage(handleIncoming);
  post({ type: "ready" });
  post({ type: "get_settings" });
}

export function contextMeter(): { show: boolean; pct: number; tone: "" | "warn" | "danger" } {
  const runtime = store.chat.sessionRuntime;
  const ctxLen = (runtime?.contextLength || store.chat.sessionContextLength) || 0;
  const input = (runtime?.lastInputTokens || store.chat.lastInputTokens) || 0;
  if (!ctxLen || !input) return { show: false, pct: 0, tone: "" };
  const pct = Math.round(Math.min(input / ctxLen, 1) * 100);
  const tone = pct >= 85 ? "danger" : pct >= 60 ? "warn" : "";
  return { show: true, pct, tone };
}
