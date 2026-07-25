/* Plain-data conversation model + reducers. This is the React-friendly port of
   the legacy webview's imperative turn/tool-call DOM graph: events mutate these
   objects in place and the store bumps a version to trigger re-render. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  countLabel, formatDuration, liveElapsedMs, readNum, readStr, shortText, stopReasonLabel,
  toolDisplayName, toolChangePresentation, type ToolChange, type ToolFileChange, type ToolState,
} from "./format";
import { toolInputPreview, toolResultPresentation, parseToolResult } from "./tool-presentation";
import type { ApprovalDecision, ChatMessage, QCardOption, QCardQuestion, SessionRuntime } from "./protocol";

export type ApprovalState = null | "pending" | "granted" | "denied";

export interface ToolCall {
  id: string;
  parentTurnId: string;
  toolName: string;
  displayName: string;
  label: string;
  preview: string;
  input: any;
  result: any;
  state: ToolState;
  approvalState: ApprovalState;
  approvalDecision: ApprovalDecision | null;
  approvalDescription: string;
  approvalTier: string;
  /** True when the tool is pending because its command binary is unrecognized (not
   *  allow- or deny-listed), rather than (or in addition to) a network/destructive tier. */
  approvalUnrecognized: boolean;
  /** Stamped from the global ChatState.pendingSeq counter the moment this call first
   *  becomes pending — gives pendingItemsOf() a stable creation-order clock across turns
   *  and lanes, since array-push order alone doesn't compare across them. */
  pendingSeq: number;
  /** When this call started — lets a running call show a live-ticking duration before elapsedMs lands. */
  startedAt: number | null;
  elapsedMs: number | null;
  change: ToolChange | null;
  mediaDataUrl: string;
  mediaLabel: string;
}

export interface QuestionItem {
  question: string;
  options: QCardOption[];
  context: string | null;
  multiSelect: boolean;
  /** Selected option keys once answered; null while the question is still open. */
  answeredKeys: string[] | null;
  /** True when the user explicitly declined this question rather than choosing an option. */
  declined: boolean;
  /** Local selections while the user works through a card. These deliberately do not
   * resolve the host-side question until the card's single bottom submit action runs. */
  draftKeys: string[];
}

export interface QuestionCard {
  toolCallId: string;
  items: QuestionItem[];
  /** See ToolCall.pendingSeq. */
  pendingSeq: number;
}

export interface Diagnostic {
  level: string;
  message: string;
}

export type TurnRole = "user" | "assistant" | "subagent";
export type TurnStatus = "streaming" | "complete" | "error";

export interface Turn {
  id: string;
  role: TurnRole;
  index: number;
  // user turn
  text?: string;
  ctxLabel?: string | null;
  /** Files @-mentioned with this message. Kept so a retry resends the request
   *  that actually failed — `ctxLabel` only counts them for display, and
   *  rebuilding the send from text alone silently drops the attached context. */
  mentions?: string[];
  // assistant / subagent turn
  raw: string;
  thinkingRaw: string;
  thinkingOpen: boolean;
  thinkingActive: boolean;
  toolCalls: Map<string, ToolCall>;
  toolCallList: ToolCall[];
  questionCards: QuestionCard[];
  diagnostics: Diagnostic[];
  status: TurnStatus;
  iterations: number;
  stopReason: string;
  startedAt: number | null;
  endedAt: number | null;
  approvalCount: number;
  failureCount: number;
  errorMessage: string;
  summaryExpanded: boolean;
  historical: boolean;
  isTile: boolean;
  // lane meta
  label?: string;
  task?: string;
  parentToolCallId?: string;
  lanes: Turn[];
}

export interface ChatState {
  turns: Turn[];
  byId: Map<string, Turn>;
  currentLiveTurnId: string | null;
  assistantTurnCount: number;
  userTurnCount: number;
  lastConversationError: string;
  running: boolean;
  hasMessages: boolean;
  sessionContextLength: number;
  lastInputTokens: number;
  sessionRuntime: SessionRuntime | null;
  /** Monotonic counter stamped onto ToolCall/QuestionCard.pendingSeq at creation —
   *  the single clock pendingItemsOf() uses to order pending items across turns/lanes. */
  pendingSeq: number;
}

export function createChatState(): ChatState {
  return {
    turns: [],
    byId: new Map(),
    currentLiveTurnId: null,
    assistantTurnCount: 0,
    userTurnCount: 0,
    lastConversationError: "",
    running: false,
    hasMessages: false,
    sessionContextLength: 0,
    lastInputTokens: 0,
    sessionRuntime: null,
    pendingSeq: 0,
  };
}

export function resetConversation(state: ChatState): void {
  state.turns = [];
  state.byId = new Map();
  state.currentLiveTurnId = null;
  state.assistantTurnCount = 0;
  state.userTurnCount = 0;
  state.lastConversationError = "";
  state.hasMessages = false;
}

export function toolStateClass(call: ToolCall): ToolState {
  if (call.approvalState === "pending") return "pending";
  return call.state || "running";
}

function newAssistantTurn(id: string, index: number, historical: boolean, role: TurnRole = "assistant"): Turn {
  return {
    id, role, index,
    raw: "", thinkingRaw: "", thinkingOpen: true, thinkingActive: false,
    toolCalls: new Map(), toolCallList: [], questionCards: [], diagnostics: [],
    status: "streaming", iterations: 0, stopReason: "",
    startedAt: historical ? null : Date.now(), endedAt: null,
    approvalCount: 0, failureCount: 0, errorMessage: "",
    summaryExpanded: false, historical, isTile: role === "subagent", lanes: [],
  };
}

export function createUserTurn(
  state: ChatState,
  text: string,
  ctxLabel: string | null,
  historical = false,
  mentions: string[] = [],
): Turn {
  state.hasMessages = true;
  state.userTurnCount += 1;
  const turn: Turn = {
    id: `user_${Date.now()}_${state.userTurnCount}`,
    role: "user", index: state.userTurnCount, text, ctxLabel, mentions,
    raw: "", thinkingRaw: "", thinkingOpen: false, thinkingActive: false,
    toolCalls: new Map(), toolCallList: [], questionCards: [], diagnostics: [],
    // Live sends carry a wall-clock stamp so the transcript can show when the
    // user spoke; restored history has no reliable per-message time, so none.
    status: "complete", iterations: 0, stopReason: "", startedAt: historical ? null : Date.now(), endedAt: null,
    approvalCount: 0, failureCount: 0, errorMessage: "", summaryExpanded: false,
    historical, isTile: false, lanes: [],
  };
  state.turns.push(turn);
  state.byId.set(turn.id, turn);
  return turn;
}

export function createAssistantTurn(state: ChatState, id: string, historical = false): Turn {
  state.hasMessages = true;
  state.assistantTurnCount += 1;
  const turn = newAssistantTurn(id, state.assistantTurnCount, historical);
  state.turns.push(turn);
  state.byId.set(turn.id, turn);
  return turn;
}

export function ensureParentLiveTurn(state: ChatState, id?: string): Turn {
  if (state.currentLiveTurnId) {
    const existing = state.byId.get(state.currentLiveTurnId);
    if (existing) return existing;
  }
  const turn = createAssistantTurn(state, id || `live_${Date.now()}`);
  state.currentLiveTurnId = turn.id;
  return turn;
}

export function ensureLaneTurn(state: ChatState, msg: any): Turn | null {
  const laneId = readStr(msg.laneId);
  if (!laneId) return null;
  const existing = state.byId.get(laneId);
  if (existing) return existing;

  const parentTurn = ensureParentLiveTurn(state, msg.id);
  const parentToolCallId = readStr(msg.parentToolCallId) || `subagent_${Date.now()}`;
  const call = ensureToolCall(state, parentTurn, {
    toolCallId: parentToolCallId,
    toolName: "subagent_spawn",
    input: msg.task ? { task: String(msg.task), label: readStr(msg.label) } : {},
    inputPreview: msg.task ? shortText(String(msg.task), 100) : "",
  });

  const lane = newAssistantTurn(laneId, 0, false, "subagent");
  lane.label = readStr(msg.label) || "Delegated lane";
  lane.task = readStr(msg.task);
  lane.parentToolCallId = call.id;
  parentTurn.lanes.push(lane);
  state.byId.set(laneId, lane);
  return lane;
}

export function resolveStreamTurn(state: ChatState, msg: any): Turn | null {
  return readStr(msg.laneId) ? ensureLaneTurn(state, msg) : ensureParentLiveTurn(state, msg.id);
}

/** Prevent a pathological model response from exhausting the retained webview heap. */
export const MAX_LIVE_TEXT_CHARS = 2_000_000;
const LIVE_TEXT_TRUNCATION = "\n\n[… live response truncated at 2,000,000 characters …]";

function appendBounded(current: string, incoming: string): string {
  if (!incoming || current.length >= MAX_LIVE_TEXT_CHARS) return current;
  const room = MAX_LIVE_TEXT_CHARS - current.length;
  if (incoming.length <= room) return current + incoming;
  const kept = Math.max(0, room - LIVE_TEXT_TRUNCATION.length);
  return current + incoming.slice(0, kept) + LIVE_TEXT_TRUNCATION;
}

export function appendText(turn: Turn, text: string): void {
  turn.raw = appendBounded(turn.raw, text);
}

export function appendThinking(turn: Turn, text: string): void {
  turn.thinkingActive = true;
  turn.thinkingOpen = true;
  turn.thinkingRaw = appendBounded(turn.thinkingRaw, text);
}

export function finalizeThinking(turn: Turn): void {
  turn.thinkingActive = false;
  turn.thinkingOpen = false;
}

/**
 * Discard the live assistant output of a generation that failed and is being retried.
 *
 * Only the streamed text/thinking is cleared. Tool calls, diagnostics and usage are left alone
 * on purpose: a mid-stream failure is retried by re-issuing the *same* request, so anything the
 * turn had already committed (tools it ran, notices it raised) still happened and still belongs
 * in the transcript. Without this the retry's text would render concatenated onto the truncated
 * prefix the user was watching, which reads as the model repeating itself.
 */
export function resetLiveResponse(turn: Turn): void {
  turn.raw = "";
  turn.thinkingRaw = "";
  turn.thinkingActive = false;
  turn.thinkingOpen = false;
}

export function applyDiagnostic(turn: Turn, level: string, message: string): void {
  turn.diagnostics.push({ level: level || "info", message: message || "" });
}

export function ensureToolCall(_state: ChatState, turn: Turn, payload: any): ToolCall {
  const toolCallId = readStr(payload.toolCallId) || `tool_${Date.now()}_${turn.toolCallList.length + 1}`;
  const existing = turn.toolCalls.get(toolCallId);
  if (existing) return existing;

  const toolName = readStr(payload.toolName) || "approval";
  const input = payload.input && typeof payload.input === "object" ? payload.input : {};
  const call: ToolCall = {
    id: toolCallId,
    parentTurnId: turn.id,
    toolName,
    displayName: toolDisplayName(toolName),
    label: toolDisplayName(toolName),
    preview: payload.inputPreview || toolInputPreview(toolName, input),
    input,
    result: null,
    state: "running",
    approvalState: null,
    approvalDecision: null,
    approvalDescription: "",
    approvalTier: "",
    approvalUnrecognized: false,
    pendingSeq: 0,
    startedAt: Date.now(),
    elapsedMs: null,
    change: toolChangePresentation(toolName, input, null),
    mediaDataUrl: "",
    mediaLabel: "",
  };
  turn.toolCalls.set(toolCallId, call);
  turn.toolCallList.push(call);
  return call;
}

/** Live-ticking duration for a tool call: the recorded elapsedMs once it completes,
 *  otherwise time since it started (so a long-running call's duration visibly grows
 *  instead of showing nothing until it finishes). Null when there's nothing to show. */
export function toolCallLiveElapsedMs(call: ToolCall, now: number): number | null {
  if (call.elapsedMs != null) return call.elapsedMs;
  return liveElapsedMs(call.startedAt, null, now);
}

/** Cap the size of the result retained on a ToolCall. The transcript keeps one of these
 *  per tool call for the life of the conversation, and the webview is never reclaimed
 *  (retainContextWhenHidden), so retaining *full* results — a large file read, a long shell
 *  dump, a base64 screenshot — is the main way the panel's memory grows over a long session.
 *  The label/preview/change/media are extracted up front; the raw result is only kept for the
 *  expandable detail card, which itself renders at most ~12k chars. */
export const MAX_RETAINED_RESULT_CHARS = 16000;

export function boundRetainedResult(value: any): any {
  if (typeof value === "string") {
    return value.length <= MAX_RETAINED_RESULT_CHARS
      ? value
      : `${value.slice(0, MAX_RETAINED_RESULT_CHARS)}\n… [truncated — ${value.length.toLocaleString()} chars]`;
  }
  if (value == null || typeof value !== "object") return value;
  let pretty: string;
  try { pretty = JSON.stringify(value, null, 2); } catch { return value; } // circular/unstringifiable — leave as-is (rare)
  if (pretty.length <= MAX_RETAINED_RESULT_CHARS) return value; // small enough — keep it structured
  return `${pretty.slice(0, MAX_RETAINED_RESULT_CHARS)}\n… [truncated — ${pretty.length.toLocaleString()} chars]`;
}

export function applyToolResult(turn: Turn, call: ToolCall, rawResult: any, elapsedMs: any): void {
  const presentation = toolResultPresentation(call.toolName, rawResult);
  const parsed = parseToolResult(rawResult);
  call.state = presentation.state;
  call.label = presentation.label || call.displayName;
  call.preview = presentation.preview || "";
  call.elapsedMs = readNum(elapsedMs);
  // Derive the change from the full parsed result, THEN retain only a bounded copy so a long
  // transcript can't accumulate unbounded memory from large tool outputs.
  call.change = toolChangePresentation(call.toolName, call.input, parsed);
  call.result = boundRetainedResult(parsed);
  call.mediaDataUrl = presentation.mediaDataUrl || "";
  call.mediaLabel = presentation.mediaLabel || "";
  if (call.toolName === "question_card" || call.approvalState === "pending") {
    call.approvalState = null;
    call.approvalDecision = null;
    call.approvalDescription = "";
    call.approvalTier = "";
    call.approvalUnrecognized = false;
  }
  turn.failureCount = turn.toolCallList.filter((c) => toolStateClass(c) === "fail").length;
}

export function applyApprovalPending(
  state: ChatState, turn: Turn, toolCallId: string, description: string, tier = "", unrecognizedCommand = false,
): void {
  const call = ensureToolCall(state, turn, { toolCallId, toolName: "approval", input: {} });
  if (!call.approvalState) {
    turn.approvalCount += 1;
    call.pendingSeq = ++state.pendingSeq;
  }
  call.approvalState = "pending";
  call.approvalDecision = null;
  call.approvalDescription = description;
  call.approvalTier = tier;
  call.approvalUnrecognized = unrecognizedCommand;
}

export function applyApprovalResult(turn: Turn, toolCallId: string, granted: boolean, decision: ApprovalDecision = granted ? "allow" : "deny"): void {
  const call = turn.toolCalls.get(readStr(toolCallId));
  if (!call) return;
  call.approvalDecision = decision;
  call.approvalState = granted ? "granted" : "denied";
  if (!granted && !call.result) {
    call.result = { ok: false, error: "User denied the operation." };
    call.state = "fail";
    call.label = "Denied";
    call.preview = "User denied the operation.";
  }
  turn.failureCount = turn.toolCallList.filter((c) => toolStateClass(c) === "fail").length;
}

export function chooseApprovalDecision(turn: Turn, toolCallId: string, decision: ApprovalDecision): void {
  applyApprovalResult(turn, toolCallId, decision !== "deny", decision);
}

export function addQuestionCard(
  state: ChatState, turn: Turn, toolCallId: string, questions: QCardQuestion[],
): void {
  if (turn.questionCards.some((q) => q.toolCallId === toolCallId)) return;
  const items: QuestionItem[] = questions.map((q) => ({
    question: q.question,
    options: q.options,
    context: q.context ?? null,
    multiSelect: q.multiSelect === true,
    answeredKeys: null,
    declined: false,
    draftKeys: [],
  }));
  turn.questionCards.push({ toolCallId, items, pendingSeq: ++state.pendingSeq });
  const call = turn.toolCalls.get(readStr(toolCallId));
  if (call && !call.approvalState) {
    turn.approvalCount += 1;
    call.approvalState = "pending";
    call.approvalDescription = "Waiting for your response";
  }
}

export function answerQuestionCard(turn: Turn, toolCallId: string, questionIndex: number, selectedKeys: string[]): void {
  const card = turn.questionCards.find((q) => q.toolCallId === toolCallId);
  const item = card?.items[questionIndex];
  if (item) {
    item.answeredKeys = selectedKeys;
    item.draftKeys = selectedKeys;
    item.declined = false;
  }
}

/** Resolve one question without choosing an option. This unblocks the agent while keeping
 * the transcript honest about why there is no selected label. */
export function declineQuestionCard(turn: Turn, toolCallId: string, questionIndex: number): void {
  const card = turn.questionCards.find((q) => q.toolCallId === toolCallId);
  const item = card?.items[questionIndex];
  if (item) {
    item.answeredKeys = [];
    item.draftKeys = [];
    item.declined = true;
  }
}

/** Pending cards live solely in the action drawer. Only a completed card belongs in the transcript. */
export function questionCardResolved(card: QuestionCard): boolean {
  return card.items.length > 0 && card.items.every((item) => item.answeredKeys != null);
}

/** Keep an in-progress selection separate from a submitted answer so both the transcript
 * and docked action bar can show honest progress without prematurely resolving the card. */
export function setQuestionDraft(turn: Turn, toolCallId: string, questionIndex: number, selectedKeys: string[]): void {
  const card = turn.questionCards.find((q) => q.toolCallId === toolCallId);
  const item = card?.items[questionIndex];
  if (item && item.answeredKeys == null) item.draftKeys = selectedKeys;
}

export function finalizeTurn(turn: Turn, opts: { status?: TurnStatus; stopReason?: string; iterations?: number } = {}): void {
  turn.status = opts.status || turn.status || "complete";
  if (opts.stopReason) turn.stopReason = opts.stopReason;
  const iter = readNum(opts.iterations);
  if (iter != null) turn.iterations = Math.max(turn.iterations, iter);
  if (!turn.historical) turn.endedAt = Date.now();
}

export function latestAssistantTurn(state: ChatState): Turn | null {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    if (state.turns[i]!.role === "assistant") return state.turns[i]!;
  }
  return null;
}

/** Text of the most recent user turn — used to resend/retry the last prompt. */
export function lastUserPrompt(state: ChatState): string | null {
  return lastUserRequest(state)?.text ?? null;
}

/** Every prompt the user has sent this conversation, oldest first and with
 *  consecutive duplicates collapsed — the recall list behind the composer's
 *  Up-arrow history. Deduping adjacent repeats keeps a retried message from
 *  costing two presses to walk past. */
export function userPromptHistory(state: ChatState): string[] {
  const out: string[] = [];
  for (const turn of state.turns) {
    if (turn.role !== "user") continue;
    const text = turn.text?.trim();
    if (!text || text === out[out.length - 1]) continue;
    out.push(text);
  }
  return out;
}

/** The last thing the user actually asked for, text *and* its @-mentioned files
 *  — everything a retry needs to reissue the same request rather than a
 *  stripped-down lookalike. */
export function lastUserRequest(state: ChatState): { text: string; mentions: string[] } | null {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const turn = state.turns[i]!;
    if (turn.role === "user" && turn.text?.trim()) {
      return { text: turn.text.trim(), mentions: turn.mentions ?? [] };
    }
  }
  return null;
}

export interface ConversationStats {
  assistantTurns: number;
  toolCalls: number;
  approvals: number;
  failures: number;
}

export function conversationStats(state: ChatState): ConversationStats {
  const assistants = state.turns.filter((t) => t.role === "assistant");
  return {
    assistantTurns: assistants.length,
    toolCalls: assistants.reduce((s, t) => s + t.toolCallList.length, 0),
    approvals: assistants.reduce((s, t) => s + t.approvalCount, 0),
    failures: assistants.reduce((s, t) => s + t.failureCount, 0),
  };
}

export interface ConversationChangeLedger {
  files: ToolFileChange[];
  fileCount: number;
  additions: number;
  deletions: number;
}

/** Every successfully applied file change in the current transcript, grouped by
 *  path. It deliberately includes delegated lanes so the conversation header
 *  stays an honest, durable account of the agent's total workspace impact. */
export function conversationChangeLedger(state: ChatState): ConversationChangeLedger {
  const byPath = new Map<string, ToolFileChange>();
  const collect = (turn: Turn): void => {
    for (const call of turn.toolCallList) {
      if ((call.state !== "ok" && call.state !== "warn") || !call.change) continue;
      const files = call.change.files?.length
        ? call.change.files
        : [{ path: call.change.path, additions: call.change.additions, deletions: call.change.deletions }];
      for (const file of files) {
        if (!file.path) continue;
        const current = byPath.get(file.path);
        if (current) {
          current.additions += file.additions;
          current.deletions += file.deletions;
        } else {
          byPath.set(file.path, { ...file });
        }
      }
    }
    turn.lanes.forEach(collect);
  };
  state.turns.forEach(collect);
  const files = [...byPath.values()];
  return {
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

/* ── Conversation history restore ─────────────────────────────────────── */

function extractUserMessageParts(content: any): { text: string; toolResults: any[] } {
  if (typeof content === "string") return { text: content, toolResults: [] };
  if (!Array.isArray(content)) return { text: "", toolResults: [] };
  let text = "";
  const toolResults: any[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") text += `${text ? "\n" : ""}${readStr(block.text)}`;
    else if (block.type === "tool_result") toolResults.push(block);
  }
  return { text, toolResults };
}

function extractAssistantBlocks(content: any): { text: string; toolUses: any[]; thinkingBlocks: string[] } {
  if (typeof content === "string") return { text: content, toolUses: [], thinkingBlocks: [] };
  if (!Array.isArray(content)) return { text: "", toolUses: [], thinkingBlocks: [] };
  const text = content.filter((b: any) => b?.type === "text").map((b: any) => readStr(b.text)).filter(Boolean).join("\n");
  const toolUses = content.filter((b: any) => b?.type === "tool_use");
  const thinkingBlocks = content.filter((b: any) => b?.type === "thinking").map((b: any) => readStr(b.thinking)).filter(Boolean);
  return { text, toolUses, thinkingBlocks };
}

export function restoreConversation(state: ChatState, messages: ChatMessage[]): void {
  resetConversation(state);
  state.hasMessages = true;
  let activeAssistant: Turn | null = null;

  for (const message of messages || []) {
    if (message.role === "assistant") {
      if (!activeAssistant) activeAssistant = createAssistantTurn(state, `history_${Date.now()}_${state.assistantTurnCount + 1}`, true);
      const { text, toolUses, thinkingBlocks } = extractAssistantBlocks(message.content);
      activeAssistant.iterations += 1;
      thinkingBlocks.forEach((chunk) => appendThinking(activeAssistant!, chunk));
      if (thinkingBlocks.length) finalizeThinking(activeAssistant!);
      if (text) appendText(activeAssistant, text);
      toolUses.forEach((toolUse: any) => {
        ensureToolCall(state, activeAssistant!, { toolCallId: toolUse.id, toolName: toolUse.name, input: toolUse.input || {} });
      });
      continue;
    }
    if (message.role !== "user") continue;
    const { text, toolResults } = extractUserMessageParts(message.content);
    if (toolResults.length && activeAssistant) {
      toolResults.forEach((toolResult: any) => {
        const id = readStr(toolResult.tool_use_id);
        const existing = activeAssistant!.toolCalls.get(id);
        const call = existing || ensureToolCall(state, activeAssistant!, { toolCallId: id, toolName: "approval", input: {} });
        applyToolResult(activeAssistant!, call, toolResult.content, call.elapsedMs);
      });
    }
    if (text.trim()) {
      if (activeAssistant) finalizeTurn(activeAssistant, { status: "complete" });
      activeAssistant = null;
      createUserTurn(state, text, null, true);
    }
  }
  if (activeAssistant) finalizeTurn(activeAssistant, { status: "complete" });
  state.running = false;
}

/* ── Derived display state ────────────────────────────────────────────── */

export interface ToolGroup {
  key: string;
  displayName: string;
  state: ToolState;
  calls: ToolCall[];
}

export function toolGroupsOf(turn: Turn): ToolGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, ToolCall[]>();
  for (const call of turn.toolCallList) {
    // Delegated-lane spawns get their own card (see LaneTile in Turn.tsx) — showing
    // them again as a generic tool row here would duplicate the same task/status info.
    if (call.toolName === "subagent_spawn") continue;
    const key = call.toolName || "tool";
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(call);
  }
  return order.map((key) => {
    const calls = byKey.get(key)!;
    let state: ToolState = "ok";
    let failed = 0, running = 0, pending = 0;
    for (const c of calls) {
      const s = toolStateClass(c);
      if (s === "fail") failed++;
      else if (s === "running") running++;
      else if (s === "pending") pending++;
    }
    if (failed > 0) state = "fail";
    else if (pending > 0 || running > 0) state = "running";
    return { key, displayName: toolDisplayName(key), state, calls };
  });
}

/** Binary name for a shell/process approval, used for the "always allow {binary}" action. Empty for non-shell tools. */
export function approvalBinaryOf(call: ToolCall): string {
  if (call.toolName !== "shell_run" && call.toolName !== "process_start") return "";
  const command = (call.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || !command.trim()) return "";
  return command.trim().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|com)$/i, "") ?? "";
}

export interface PendingItem {
  kind: "question" | "approval";
  /** The Turn that actually owns this item's toolCalls/questionCards map — a subagent
   *  lane's own id when the item lives inside one, otherwise the top-level turn's id.
   *  This is what answerApproval/answerQuestion need to resolve the right Turn object;
   *  passing the parent turn's id for a lane item would silently no-op the local update
   *  since the call actually lives on the lane's own Map. */
  turnId: string;
  toolCallId: string;
  /** Equal to turnId when this item lives inside a subagent lane (null otherwise) — used
   *  for provenance labelling and because lanes render under a "lane-{id}" DOM node, not
   *  "turn-{id}". */
  laneId: string | null;
  laneLabel: string | null;
  title: string;
  tier: string;
  unrecognized: boolean;
  binary: string;
  questions: QuestionItem[] | null;
  pendingSeq: number;
}

function pendingItemsInTurn(turn: Turn, laneId: string | null, laneLabel: string | null): PendingItem[] {
  const items: PendingItem[] = [];
  for (const card of turn.questionCards) {
    if (questionCardResolved(card)) continue;
    items.push({
      kind: "question", turnId: turn.id, toolCallId: card.toolCallId, laneId, laneLabel,
      title: card.items.length === 1 ? card.items[0]!.question : `${card.items.length} questions`,
      tier: "", unrecognized: false, binary: "",
      questions: card.items, pendingSeq: card.pendingSeq,
    });
  }
  for (const call of turn.toolCallList) {
    if (call.approvalState !== "pending" || call.toolName === "question_card") continue;
    items.push({
      kind: "approval", turnId: turn.id, toolCallId: call.id, laneId, laneLabel,
      title: call.approvalDescription || call.label || call.displayName, tier: call.approvalTier,
      unrecognized: call.approvalUnrecognized, binary: approvalBinaryOf(call),
      questions: null, pendingSeq: call.pendingSeq,
    });
  }
  return items;
}

/** Every unanswered question and pending approval across the live transcript — including
 *  inside subagent lanes, which is where they're otherwise most buried (LaneTile defaults
 *  its accordion closed) — ordered by true creation time (pendingSeq) so a multi-item queue
 *  is stable regardless of which turn or lane an item belongs to. */
export function pendingItemsOf(state: ChatState): PendingItem[] {
  const items: PendingItem[] = [];
  for (const turn of state.turns) {
    items.push(...pendingItemsInTurn(turn, null, null));
    for (const lane of turn.lanes) {
      items.push(...pendingItemsInTurn(lane, lane.id, lane.label || "Subagent"));
    }
  }
  return items.sort((a, b) => a.pendingSeq - b.pendingSeq);
}

export interface CurrentAction {
  call: ToolCall;
  /** Present when the running call is inside a delegated subagent lane. */
  laneLabel: string | null;
  laneId: string | null;
}

/** The single most-recently-started, still-running tool call across a live turn
 *  and its lanes — the "what is the agent doing right now" signal that drives the
 *  chat's live-action line. A lane's own running tool wins over the parent
 *  subagent_spawn call (it started later), so the readout follows the deepest
 *  active edge. Null when the turn isn't streaming or nothing is running. */
export function currentActionOf(turn: Turn): CurrentAction | null {
  if (turn.status !== "streaming") return null;
  let best: CurrentAction | null = null;
  let bestAt = -1;
  const consider = (call: ToolCall, laneLabel: string | null, laneId: string | null): void => {
    // A pending (awaiting-approval) call isn't "running" work — the PendingBar owns that.
    if (toolStateClass(call) !== "running") return;
    const at = call.startedAt ?? 0;
    if (at >= bestAt) { bestAt = at; best = { call, laneLabel, laneId }; }
  };
  for (const call of turn.toolCallList) consider(call, null, null);
  for (const lane of turn.lanes) {
    for (const call of lane.toolCallList) consider(call, lane.label || "Subagent", lane.id);
  }
  return best;
}

export function placeholderText(turn: Turn): string {
  if (turn.status === "error") return turn.errorMessage || "The assistant turn ended with an error.";
  const pendingQuestions = turn.toolCallList.filter((c) => c.approvalState === "pending" && c.toolName === "question_card").length;
  const pendingApprovals = turn.toolCallList.filter((c) => c.approvalState === "pending" && c.toolName !== "question_card").length;
  const runningTools = turn.toolCallList.filter((c) => toolStateClass(c) === "running").length;
  if (pendingQuestions > 0) return "Waiting for your response to continue.";
  if (pendingApprovals > 0) return "Waiting on approval to continue.";
  if (runningTools > 0) return "Running tools and gathering context.";
  if (turn.toolCallList.length > 0) return "Tool activity captured for this turn.";
  return turn.status === "streaming" ? "Drafting response…" : "No assistant text was returned for this turn.";
}

export interface TurnChrome {
  statusClass: string;
  statusText: string;
  meta: string;
}

/** True while a turn/lane is actively streaming — the signal components use to decide
 *  whether to keep a live clock ticking for it. */
export function turnIsLive(turn: Turn): boolean {
  return turn.status === "streaming";
}

/** @param now Caller-supplied clock so a component re-rendering on an interval can make
 *  the in-progress duration tick upward live; defaults to Date.now() for one-off reads. */
export function turnChrome(turn: Turn, now: number = Date.now()): TurnChrome {
  const failed = turn.toolCallList.filter((c) => toolStateClass(c) === "fail").length;
  const running = turn.toolCallList.filter((c) => toolStateClass(c) === "running").length;
  const pending = turn.toolCallList.filter((c) => toolStateClass(c) === "pending").length;

  let statusClass = "complete";
  let statusText = "Done";
  if (turn.status === "error") { statusClass = "error"; statusText = "Error"; }
  else if (turn.stopReason === "max_iterations") { statusClass = "limit"; statusText = "Limit"; }
  else if (turn.status === "streaming") {
    if (pending > 0) { statusClass = "pending"; statusText = "Wait"; }
    else { statusClass = "streaming"; statusText = "Live"; }
  }

  const metaParts: string[] = [];
  if (turn.toolCallList.length) metaParts.push(countLabel(turn.toolCallList.length, "tool call"));
  if (turn.approvalCount) metaParts.push(countLabel(turn.approvalCount, "approval"));
  if (failed) metaParts.push(`${failed} failed`);
  if (turn.iterations) metaParts.push(countLabel(turn.iterations, "iteration"));
  if (!turn.historical && turn.startedAt != null) {
    const d = liveElapsedMs(turn.startedAt, turn.endedAt, now);
    const dur = d != null ? formatDuration(d) : "";
    if (dur) metaParts.push(dur);
  }
  if (turn.stopReason) metaParts.push(stopReasonLabel(turn.stopReason));

  let summary = "Turn complete";
  if (turn.status === "error") summary = turn.errorMessage || "Turn ended with an error";
  else if (turn.stopReason === "max_iterations") summary = "Iteration limit reached";
  else if (pending > 0) summary = "Approval required";
  else if (running > 0 || turn.status === "streaming") summary = "Working through tool activity";
  else if (!turn.raw && turn.toolCallList.length > 0) summary = "Tool activity captured";
  else if (!turn.raw) summary = "No assistant text returned";

  return { statusClass, statusText, meta: metaParts.length ? `${summary} · ${metaParts.join(" · ")}` : summary };
}
