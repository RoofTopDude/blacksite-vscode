/* Data webview store. Single module-level store (one instance per bundle) that
   owns catalog/query/assistant/vector state and dispatches the data provider's
   messages. Subscribed via useSyncExternalStore. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";

export type DataTab = "explorer" | "query" | "assistant" | "vectors" | "rag";

export interface AssistantEntry {
  id: number;
  role: "user" | "assistant";
  text?: string;
  sql?: string;
  safety?: string;
  needsConfirmation?: boolean;
  pending?: boolean;
  error?: string;
}

export interface DataState {
  status: any;
  catalog: any;
  savedQueries: any[];
  tab: DataTab;
  selectedObject: string | null;
  description: any | null;
  preview: any | null;
  previewReq: { filter: string; orderBy?: string; orderDir?: "asc" | "desc" };
  drawerRow: any | null;
  sql: string;
  queryName: string;
  queryStatus: string;
  queryResult: any | null;
  confirm: string | null;
  assistantLog: AssistantEntry[];
  vectorStats: any | null;
  vectorResults: any[] | null;
  vectorQuery: string;
  vectorCollection: string;
  sidecarStatus: string;
  sidecarMsg: string;
  backend: string;
  error: string;
}

const PAGE = 50;

export const state: DataState = {
  status: { available: false },
  catalog: null,
  savedQueries: [],
  tab: "explorer",
  selectedObject: null,
  description: null,
  preview: null,
  previewReq: { filter: "" },
  drawerRow: null,
  sql: "",
  queryName: "",
  queryStatus: "",
  queryResult: null,
  confirm: null,
  assistantLog: [],
  vectorStats: null,
  vectorResults: null,
  vectorQuery: "",
  vectorCollection: "",
  sidecarStatus: "Status unknown.",
  sidecarMsg: "",
  backend: "exact_local",
  error: "",
};

let version = 0;
const listeners = new Set<() => void>();
function bump(): void { version += 1; for (const l of listeners) l(); }
function subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l); }
function getSnapshot(): number { return version; }

export function useDataStore(): DataState {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state;
}

let assistantSeq = 0;

function handleIncoming(msg: any): void {
  switch (msg.type) {
    case "data_state":
      state.status = msg.status || state.status;
      if (msg.catalog) state.catalog = msg.catalog;
      state.savedQueries = msg.savedQueries || [];
      break;
    case "object_description":
      if (state.selectedObject === msg.description?.name) state.description = msg.description;
      break;
    case "preview_result":
      if (state.selectedObject === msg.result?.object) state.preview = msg.result;
      break;
    case "query_result":
      state.confirm = null;
      state.queryResult = msg.result;
      state.queryStatus = formatQueryStatus(msg.result);
      if (!msg.result?.ok && msg.result?.kind === "blocked" && msg.result?.needsConfirmation) {
        state.confirm = msg.result.message;
      }
      break;
    case "vector_stats":
      state.vectorStats = msg.stats;
      break;
    case "vector_results":
      state.vectorResults = Array.isArray(msg.hits) ? msg.hits : [];
      state.vectorQuery = msg.query || "";
      break;
    case "assistant_reply": {
      state.assistantLog = state.assistantLog.filter((e) => !e.pending);
      const reply = msg.reply || {};
      state.assistantLog.push({
        id: ++assistantSeq, role: "assistant",
        text: reply.ok ? reply.explanation : (reply.error || "No answer."),
        sql: reply.ok ? reply.sql : undefined,
        safety: reply.safety, needsConfirmation: reply.needsConfirmation,
        error: reply.ok ? undefined : (reply.error || "No answer."),
      });
      break;
    }
    case "sidecar_status":
      state.sidecarStatus = !msg.engineAvailable
        ? "No container engine (docker/podman) detected."
        : msg.status ? `${msg.profile}: ${msg.status.health} — ${msg.status.detail}` : `${msg.profile}: engine ready, container not created.`;
      if (msg.activeBackend) state.backend = msg.activeBackend;
      break;
    case "sidecar_action":
      state.sidecarMsg = (msg.ok ? "" : "⚠ ") + (msg.message || "");
      break;
    case "load_query":
      state.sql = msg.sql || "";
      if (msg.name) state.queryName = msg.name;
      state.tab = "query";
      break;
    case "data_error":
      state.error = msg.message || "";
      state.queryStatus = `Error: ${msg.message || ""}`;
      break;
  }
  bump();
}

function formatQueryStatus(result: any): string {
  if (!result) return "";
  if (!result.ok && result.kind === "blocked") return result.needsConfirmation ? "Awaiting confirmation." : result.message;
  if (result.kind === "write") return `OK · ${result.changes} row(s) changed · ${result.elapsedMs}ms`;
  return `${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""} · ${result.elapsedMs}ms`;
}

export const actions = {
  setTab(tab: DataTab): void { state.tab = tab; bump(); if (tab === "vectors") post({ type: "sidecar_status" }); },
  selectObject(name: string): void {
    state.selectedObject = name;
    state.description = null;
    state.preview = null;
    state.previewReq = { filter: "" };
    bump();
    post({ type: "describe_object", name });
    post({ type: "preview_rows", name, offset: 0, limit: PAGE });
  },
  setFilter(filter: string): void {
    state.previewReq = { ...state.previewReq, filter };
    bump();
    if (state.selectedObject) post({ type: "preview_rows", name: state.selectedObject, offset: 0, limit: PAGE, filter });
  },
  sort(col: string): void {
    const dir = state.previewReq.orderBy === col && state.previewReq.orderDir === "asc" ? "desc" : "asc";
    state.previewReq = { ...state.previewReq, orderBy: col, orderDir: dir };
    bump();
    if (state.selectedObject) post({ type: "preview_rows", name: state.selectedObject, offset: state.preview?.offset ?? 0, limit: PAGE, filter: state.previewReq.filter, orderBy: col, orderDir: dir });
  },
  page(dir: number): void {
    const offset = Math.max(0, (state.preview?.offset ?? 0) + dir * PAGE);
    if (state.selectedObject) post({ type: "preview_rows", name: state.selectedObject, offset, limit: PAGE, filter: state.previewReq.filter, orderBy: state.previewReq.orderBy, orderDir: state.previewReq.orderDir });
  },
  openDrawer(row: any): void { state.drawerRow = row; bump(); },
  closeDrawer(): void { state.drawerRow = null; bump(); },
  setSql(sql: string): void { state.sql = sql; bump(); },
  setQueryName(name: string): void { state.queryName = name; bump(); },
  runQuery(confirmed: boolean): void {
    const sql = state.sql.trim();
    if (!sql) return;
    state.queryStatus = "Running…";
    bump();
    post({ type: "run_query", sql, confirmed });
  },
  cancelConfirm(): void { state.confirm = null; state.queryStatus = ""; bump(); },
  saveQuery(): void {
    const sql = state.sql.trim();
    if (!sql) return;
    post({ type: "save_query", name: state.queryName.trim() || "Untitled query", sql });
  },
  openSaved(id: string): void { post({ type: "open_saved_query", id }); },
  deleteSaved(id: string): void { post({ type: "delete_saved_query", id }); },
  askAssistant(question: string): void {
    const q = question.trim();
    if (!q) return;
    state.assistantLog.push({ id: ++assistantSeq, role: "user", text: q });
    state.assistantLog.push({ id: ++assistantSeq, role: "assistant", pending: true });
    bump();
    post({ type: "assistant_ask", question: q });
  },
  useSql(sql: string): void { state.sql = sql; state.tab = "query"; bump(); },
  setVectorCollection(c: string): void { state.vectorCollection = c; bump(); },
  vectorSearch(text: string): void {
    const t = text.trim();
    if (!t) return;
    post({ type: "vector_search", text: t, topK: 10, collection: state.vectorCollection || undefined });
  },
  sidecarUp(): void { state.sidecarMsg = "Starting…"; bump(); post({ type: "sidecar_up" }); },
  sidecarStop(): void { state.sidecarMsg = "Stopping…"; bump(); post({ type: "sidecar_stop" }); },
  sidecarStatus(): void { post({ type: "sidecar_status" }); },
  setBackend(mode: string): void { state.backend = mode; bump(); },
  applyBackend(): void { state.sidecarMsg = "Switching…"; bump(); post({ type: "set_vector_backend", mode: state.backend }); },
  openSourceFile(path: string): void { post({ type: "open_source_file", path }); },
};

let started = false;
export function initDataStore(): void {
  if (started) return;
  started = true;
  onMessage(handleIncoming);
  post({ type: "ready" });
}
