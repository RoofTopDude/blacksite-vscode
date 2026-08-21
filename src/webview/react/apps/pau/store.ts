/* PAU (beta) webview store. Single module-level store, subscribed via useSyncExternalStore —
   same shape as apps/data/store.ts. The host pushes the full receipt list on every change
   (pau-metrics-provider.ts's `_postState`, mirroring run-provider.ts's convention), so this
   store just replaces state wholesale rather than patching incrementally. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";

export interface PauCategorySummary {
  type: string;
  segments: number;
  tokens: number;
  tokenShare: number;
  pau: number;
  pauShare: number;
  replayTokens: number;
  maxHogScore: number;
}

export interface PauTopHog {
  id: string;
  type: string;
  source?: string;
  tokens: number;
  pau: number;
  pauShare: number;
  duplicateRatio: number;
  replayCount: number;
  effectiveHogScore: number;
  hogSeverity: string;
  recommendations: string[];
}

export interface PauReceiptSummary {
  capturedAt: number;
  runId?: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
  totalTokens: number;
  totalPAU: number;
  tokenAccountingGrade: "A" | "B" | "C" | "D";
  tokenAccountingNote: string;
  rawUtilization: number | null;
  pauUtilization: number | null;
  duplicateTokenRatio: number;
  replayTokens: number;
  replayOverheadRatio: number;
  maxHogScore: number;
  contextHealthScore: number;
  categories: PauCategorySummary[];
  warnings: string[];
  topHogs: PauTopHog[];
}

export type PauReceipt = { skipped: true; reason: string } | ({ skipped: false } & PauReceiptSummary);

export interface PauReceiptEvent {
  at: number;
  receipt: PauReceipt;
  laneId?: string;
}

export interface PauState {
  ready: boolean;
  enabled: boolean;
  receipts: PauReceiptEvent[];
  selectedIndex: number | null;
}

export const state: PauState = {
  ready: false,
  enabled: false,
  receipts: [],
  selectedIndex: null,
};

let version = 0;
const listeners = new Set<() => void>();
function bump(): void { version += 1; for (const l of listeners) l(); }
function subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l); }
function getSnapshot(): number { return version; }

export function usePauStore(): PauState {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state;
}

/** The receipt currently shown in the detail pane — the selected history row, or the latest
 *  receipt when nothing is explicitly selected. */
export function selectedReceipt(): PauReceiptEvent | null {
  if (state.receipts.length === 0) return null;
  if (state.selectedIndex != null && state.receipts[state.selectedIndex]) return state.receipts[state.selectedIndex]!;
  return state.receipts[state.receipts.length - 1]!;
}

function handleIncoming(msg: any): void {
  if (msg?.type !== "pau_state") return;
  state.ready = true;
  state.enabled = !!msg.enabled;
  state.receipts = Array.isArray(msg.receipts) ? msg.receipts : [];
  if (state.selectedIndex != null && state.selectedIndex >= state.receipts.length) state.selectedIndex = null;
  bump();
}

export const actions = {
  select(index: number | null): void { state.selectedIndex = index; bump(); },
  clear(): void { post({ type: "clear" }); },
  openSettings(): void { post({ type: "open_settings" }); },
};

let started = false;
export function initPauStore(): void {
  if (started) return;
  started = true;
  onMessage(handleIncoming);
  post({ type: "ready" });
}
