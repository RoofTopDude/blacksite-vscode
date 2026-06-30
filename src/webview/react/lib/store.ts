/* Central webview store. Holds all UI + conversation state, dispatches incoming
   host messages into the chat model, and exposes typed actions that post back.
   Subscribed via useSyncExternalStore over a monotonic version counter. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSyncExternalStore } from "react";
import { post as rawPost, onMessage } from "./bridge";
import { countLabel, readNum, readStr } from "./format";
import { defaultBedrockModel } from "../../../bedrock-config.js";
import type {
  ApprovalDecision, ExtendedSettings, HistorySession, IncomingMessage, KeyStatus, LogStats,
  MemoryStats, ModelInfo, OpenRouterConfig, OutgoingMessage, ProviderName, SubagentProfile, SubagentSettings,
} from "./protocol";

/** Typed post — narrows to the chat webview's outbound protocol. */
function post(message: OutgoingMessage): void {
  rawPost(message);
}
import {
  addQuestionCard, answerQuestionCard, appendText, appendThinking, applyApprovalPending,
  applyApprovalResult, applyDiagnostic, applyToolResult, chooseApprovalDecision, createChatState, createUserTurn,
  ensureLaneTurn, ensureParentLiveTurn, ensureToolCall, finalizeThinking, finalizeTurn,
  resetConversation, resolveStreamTurn, restoreConversation, type ChatState,
} from "./chat-model";

export type ViewName = "chat" | "history" | "settings";

export interface Lightbox {
  dataUrl: string;
  label: string;
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
  /** Per-provider model cache — populated whenever any provider's models are fetched. */
  providerModels: Partial<Record<ProviderName, ModelInfo[]>>;
  /** Per-provider loading state for independent fetches. */
  providerModelsLoading: Partial<Record<ProviderName, boolean>>;
  memoryStats: MemoryStats | null;
  logStats: LogStats | null;
  history: HistorySession[];
  pendingCtx: { text?: string; label?: string } | null;
  mentionItems: string[];
  mentionQuery: string;
  lightbox: Lightbox | null;
  focusNonce: number;
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
  providerModels: {},
  providerModelsLoading: {},
  memoryStats: null,
  logStats: null,
  history: [],
  pendingCtx: null,
  mentionItems: [],
  mentionQuery: "",
  lightbox: null,
  focusNonce: 0,
};

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const l of listeners) l();
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
      const totalInput = it + cr + cw;
      const cl = readNum(msg.contextLength) ?? 0;
      if (cl > 0) chat.sessionContextLength = cl;
      if (totalInput > 0) chat.lastInputTokens = totalInput;
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
          (msg.decision as ApprovalDecision | undefined) ?? (!!msg.granted ? "allow" : "deny"),
        );
      }
      break;
    }

    case "stream_question_card": {
      const turn = resolveStreamTurn(chat, msg);
      if (turn) addQuestionCard(turn, String(msg.toolCallId || ""), String(msg.question || ""), Array.isArray(msg.options) ? msg.options : [], msg.context ? String(msg.context) : null);
      break;
    }

    case "stream_end": {
      const laneId = readStr(msg.laneId);
      const turn = laneId ? ensureLaneTurn(chat, msg) : store.chat.byId.get(chat.currentLiveTurnId || "") || null;
      if (turn) {
        finalizeThinking(turn);
        finalizeTurn(turn, { status: "complete", stopReason: String(msg.stopReason || ""), iterations: readNum(msg.iterations) ?? undefined });
      }
      if (!laneId) { chat.currentLiveTurnId = null; chat.running = false; }
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
      break;

    case "models_data": {
      const p = msg.provider;
      if (p) {
        store.providerModelsLoading = { ...store.providerModelsLoading, [p]: false };
        if (msg.models) store.providerModels = { ...store.providerModels, [p]: msg.models };
      }
      store.modelsLoading = false;
      if (p === store.settings.provider) {
        store.allModels = msg.models || [];
        store.modelsError = msg.error || null;
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
    if (!trimmed || store.chat.running) return;
    const ctx = store.pendingCtx;
    store.pendingCtx = null;
    store.chat.lastConversationError = "";
    store.chat.running = true;
    const ctxLabel = ctx?.label || (mentions.length ? countLabel(mentions.length, "file") : null);
    createUserTurn(store.chat, trimmed, ctxLabel);
    store.chat.currentLiveTurnId = null;
    bump();
    post({ type: "send_message", payload: { content: trimmed, context: ctx, mentions } });
  },
  cancel(): void { post({ type: "cancel_current" }); },
  newChat(): void { post({ type: "new_chat" }); },
  compact(): void { post({ type: "compact_conversation" }); },
  requestFiles(query: string): void { post({ type: "request_files", query }); },
  loadSession(sessionId: string): void { post({ type: "load_session", sessionId }); store.view = "chat"; bump(); },
  deleteSession(sessionId: string): void { post({ type: "delete_session", sessionId }); },
  answerQuestion(turnId: string, toolCallId: string, key: string): void {
    const turn = store.chat.byId.get(turnId);
    if (turn) { answerQuestionCard(turn, toolCallId, key); bump(); }
    post({ type: "question_card_answer", toolCallId, selectedKey: key });
  },
  answerApproval(turnId: string, toolCallId: string, decision: ApprovalDecision): void {
    const turn = store.chat.byId.get(turnId);
    if (turn) { chooseApprovalDecision(turn, toolCallId, decision); bump(); }
    post({ type: "approval_decision", toolCallId, decision });
  },
  openLightbox(dataUrl: string, label: string): void { store.lightbox = { dataUrl, label }; bump(); },
  closeLightbox(): void { store.lightbox = null; bump(); },
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
  setThinking(provider: ProviderName, enabled: boolean, budgetTokens: number): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), thinking: { enabled, budgetTokens } } } };
    bump();
    post({ type: "set_thinking", provider, enabled, budgetTokens });
  },
  setReasoningEffort(provider: ProviderName, effort: "low" | "medium" | "high"): void {
    store.settings = { ...store.settings, providerSettings: { ...store.settings.providerSettings, [provider]: { ...curProvider(provider), reasoningEffort: effort } } };
    bump();
    post({ type: "set_reasoning_effort", provider, effort });
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
  setEmbedding(opts: { provider?: ProviderName; model?: string; dims?: number }): void {
    post({ type: "set_embedding", ...opts });
  },
  rebuildEmbeddings(): void { post({ type: "rebuild_embeddings" }); },
  fetchModels(provider: ProviderName): void { post({ type: "fetch_models", provider }); },
  fetchModelsForProvider(provider: ProviderName): void {
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

function baseProviderSettings(provider: ProviderName) {
  switch (provider) {
    case "anthropic":
      return { model: "claude-sonnet-4-6", temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000 } };
    case "openrouter":
      return { model: "anthropic/claude-sonnet-4-6", temperature: 1, maxTokens: 8192 };
    case "openai":
      return { model: "gpt-4o", temperature: 1, maxTokens: 8192, reasoningEffort: "medium" as const };
    case "bedrock":
      return { model: defaultBedrockModel(store.settings.bedrockApi), temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000 } };
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
