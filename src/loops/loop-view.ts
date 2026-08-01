/** Host bridge for the retained Ticket Loops workbench. */

import * as vscode from "vscode";
import { isOpenStatus, type Ticket, type TicketStore } from "../ticket-store.js";
import { renderWebviewHtml } from "../webview-html.js";
import { defaultApprovalPosture, defaultQueueSpec, type LoopRecord } from "./loop-model.js";
import { proposeLoop } from "./loop-proposal.js";
import { computeReadySet } from "./loop-scheduler.js";
import { MAX_LOOP_CONCURRENCY, type LoopStore } from "./loop-store.js";
import type { LoopSupervisor } from "./loop-supervisor.js";

export interface LoopProviderCallbacks {
  openTicket?(ticketId: string): void | Promise<void>;
  askAgent?(message: string, label: string): void | Promise<void>;
}

type LoopOperation =
  | "ready"
  | "refresh"
  | "select_loop"
  | "create_loop"
  | "start_loop"
  | "pause_loop"
  | "stop_loop"
  | "delete_loop"
  | "confirm_loop_action"
  | "cancel_loop_action"
  | "release_ticket"
  | "open_ticket"
  | "ask_agent";

interface LoopCommandTarget {
  loopId: string;
  ticketId?: string;
}

type LoopConfirmationAction = "start" | "stop" | "delete";

interface PendingLoopConfirmation {
  token: string;
  action: LoopConfirmationAction;
  loopId: string;
  title: string;
  description: string;
  details: string[];
  caution?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => text(entry, 160)).filter(Boolean))].slice(0, max);
}

function positiveNumber(value: unknown, max: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : undefined;
}

function ticketSummary(ticket: Ticket): Record<string, unknown> {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    complexity: ticket.complexity ?? "unsized",
    labels: ticket.labels,
    files: ticket.territory.files,
    areas: ticket.territory.areas,
    blockedBy: ticket.blockedBy,
    acceptanceCriteria: ticket.acceptanceCriteria,
  };
}

export class LoopProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private _selectedLoopId?: string;
  private _pendingIntent?: "open_composer";
  private _pendingConfirmation?: PendingLoopConfirmation;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _viewSubscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: LoopStore,
    private readonly _supervisor: LoopSupervisor,
    private readonly _tickets: TicketStore,
    private readonly _indexedFiles: () => readonly string[],
    private readonly _callbacks: LoopProviderCallbacks = {},
  ) {
    this._subscriptions.push(
      this._store.onDidChange(() => this._postState()),
      this._tickets.onDidChange(() => this._postState()),
    );
  }

  dispose(): void {
    for (const subscription of this._viewSubscriptions.splice(0)) subscription.dispose();
    for (const subscription of this._subscriptions.splice(0)) subscription.dispose();
    this._view = undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const subscription of this._viewSubscriptions.splice(0)) subscription.dispose();
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(
      webviewView.webview,
      this._context.extensionUri,
      "loops.js",
    );
    this._viewSubscriptions.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => { void this._onMessage(message); }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._postState();
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) this._view = undefined;
      }),
    );
    this._postState();
  }

  refresh(): void {
    this._postState();
  }

  /** Route commands through the retained UI instead of VS Code's native input and modal APIs. */
  async openComposer(): Promise<void> {
    this._pendingIntent = "open_composer";
    await this._focus();
    this._postPendingUi();
  }

  async requestStart(loopId: string): Promise<void> {
    await this._focus();
    this._requestStart(loopId);
  }

  async requestStop(loopId: string): Promise<void> {
    await this._focus();
    this._requestStop(loopId);
  }

  async requestDelete(loopId: string): Promise<void> {
    await this._focus();
    this._requestDelete(loopId);
  }

  pause(loopId: string): void {
    this._supervisor.pause(loopId);
    this._postState();
  }

  releasePark(loopId: string, ticketId: string): void {
    this._supervisor.releasePark(loopId, ticketId);
    this._notice("success", `${ticketId} was released from its review block and is dispatchable again.`);
    this._postState();
  }

  notify(message: string, tone: "success" | "error" | "info" = "info"): void {
    this._notice(tone, message);
    this._postState();
  }

  private async _onMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== "string") return;
    const operation = value.type as LoopOperation;
    try {
      switch (operation) {
        case "ready":
          this._postState();
          this._postPendingUi();
          return;
        case "refresh":
          this._postState();
          return;
        case "select_loop":
          this._selectedLoopId = text(value.loopId, 100) || undefined;
          this._postState();
          return;
        case "create_loop":
          this._createLoop(value);
          return;
        case "start_loop":
          this._requestStart(this._target(value).loopId);
          return;
        case "pause_loop":
          this.pause(this._target(value).loopId);
          return;
        case "stop_loop":
          this._requestStop(this._target(value).loopId);
          return;
        case "delete_loop":
          this._requestDelete(this._target(value).loopId);
          return;
        case "confirm_loop_action":
          this._confirmAction(text(value.token, 160));
          return;
        case "cancel_loop_action":
          this._cancelAction(text(value.token, 160));
          return;
        case "release_ticket":
          {
            const target = this._target(value, true);
            this.releasePark(target.loopId, target.ticketId!);
          }
          return;
        case "open_ticket": {
          const ticketId = text(value.ticketId, 80);
          if (!ticketId) throw new Error("A ticket id is required.");
          await this._callbacks.openTicket?.(ticketId);
          return;
        }
        case "ask_agent":
          await this._askAgent(text(value.loopId, 100), text(value.ticketId, 80));
          return;
        default:
          return;
      }
    } catch (error) {
      this._post({
        type: "loops_notice",
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private _target(value: Record<string, unknown>, ticketRequired = false): LoopCommandTarget {
    const loopId = text(value.loopId, 100);
    const ticketId = text(value.ticketId, 80);
    if (!loopId) throw new Error("A loop id is required.");
    if (ticketRequired && !ticketId) throw new Error("A ticket id is required.");
    return { loopId, ...(ticketId ? { ticketId } : {}) };
  }

  private async _focus(): Promise<void> {
    await vscode.commands.executeCommand("blacksite.loops.focus");
  }

  private _matchedCount(record: LoopRecord): number {
    try {
      return computeReadySet({
        tickets: this._tickets.read().tickets,
        spec: record.definition.queue,
        state: new Map(record.ticketState.map((entry) => [entry.ticketId, entry] as const)),
        inFlight: [],
        indexedFiles: this._indexedFiles(),
      }).queueSize;
    } catch {
      return 0;
    }
  }

  private _requestStart(loopId: string): void {
    const record = this._store.get(loopId);
    if (!record) throw new Error("That loop no longer exists.");
    if (this._supervisor.isRunning(loopId)) {
      this._notice("info", "That loop is already running.");
      return;
    }
    const matched = this._matchedCount(record);
    if (!matched) {
      this._notice("info", "That loop's queue does not currently match any open tickets.");
      return;
    }

    const { ceilings, workers } = record.definition;
    this._requestConfirmation({
      action: "start",
      loopId,
      title: `Start \u201c${record.definition.title}\u201d?`,
      description: "This starts an unattended execution under the limits shown below.",
      details: [
        `${matched} matched ticket${matched === 1 ? "" : "s"}`,
        `${workers.concurrency} parallel lane${workers.concurrency === 1 ? "" : "s"}`,
        ceilings.maxTickets ? `Stops after ${ceilings.maxTickets} tickets` : "No ticket ceiling",
        ceilings.maxUsd ? `Spend ceiling: $${ceilings.maxUsd.toFixed(2)}` : "No spend ceiling",
        ceilings.maxWallClockMs ? `Time ceiling: ${Math.round(ceilings.maxWallClockMs / 60_000)} minutes` : "No time ceiling",
      ],
      caution: "Continuation review handles ordinary approvals automatically. Unsafe or unclear work blocks only that ticket; completed work moves to review and is never closed automatically.",
    });
  }

  private _requestStop(loopId: string): void {
    const record = this._store.get(loopId);
    if (!record) throw new Error("That loop no longer exists.");
    const activeLaneCount = record.iterations.filter((iteration) => !iteration.endedAt).length;
    this._requestConfirmation({
      action: "stop",
      loopId,
      title: `Stop \u201c${record.definition.title}\u201d?`,
      description: "No new tickets will start. Lanes that are already running are allowed to settle safely.",
      details: [
        `${activeLaneCount} active lane${activeLaneCount === 1 ? "" : "s"}`,
        `${record.totals.dispatched} ticket${record.totals.dispatched === 1 ? "" : "s"} attempted in this loop`,
      ],
    });
  }

  private _requestDelete(loopId: string): void {
    const record = this._store.get(loopId);
    if (!record) throw new Error("That loop no longer exists.");
    if (this._supervisor.isRunning(loopId)) {
      this._notice("error", "Stop the loop before deleting it.");
      return;
    }
    this._requestConfirmation({
      action: "delete",
      loopId,
      title: `Delete \u201c${record.definition.title}\u201d?`,
      description: "This removes the loop configuration and its execution history. Tickets are not changed.",
      details: [
        `${record.executions.length} recorded execution${record.executions.length === 1 ? "" : "s"}`,
        `${record.iterations.length} recorded lane${record.iterations.length === 1 ? "" : "s"}`,
      ],
    });
  }

  private _requestConfirmation(input: Omit<PendingLoopConfirmation, "token">): void {
    this._pendingConfirmation = {
      ...input,
      token: `loop-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    };
    this._postPendingUi();
  }

  private _confirmAction(token: string): void {
    const pending = this._pendingConfirmation;
    if (!pending || !token || pending.token !== token) return;
    this._pendingConfirmation = undefined;
    const record = this._store.get(pending.loopId);
    if (!record) throw new Error("That loop no longer exists.");

    if (pending.action === "start") {
      if (!this._matchedCount(record)) {
        this._notice("info", "That loop's queue no longer matches an open ticket.");
        this._postState();
        return;
      }
      this._supervisor.start(pending.loopId);
      this._notice("success", `Started \u201c${record.definition.title}\u201d.`);
    } else if (pending.action === "stop") {
      this._supervisor.stop(pending.loopId, "Stopped by the user.");
      this._notice("info", `Stopping \u201c${record.definition.title}\u201d after active lanes settle.`);
    } else if (this._supervisor.isRunning(pending.loopId)) {
      this._notice("error", "Stop the loop before deleting it.");
    } else {
      this._store.delete(pending.loopId);
      if (this._selectedLoopId === pending.loopId) this._selectedLoopId = undefined;
      this._notice("success", `Deleted \u201c${record.definition.title}\u201d.`);
    }
    this._postState();
  }

  private _cancelAction(token: string): void {
    if (this._pendingConfirmation?.token === token) this._pendingConfirmation = undefined;
  }

  private _createLoop(value: Record<string, unknown>): void {
    const title = text(value.title, 200);
    if (!title) throw new Error("Give the loop a name.");
    const allTickets = this._tickets.read().tickets;
    const known = new Set(allTickets.map((ticket) => ticket.id));
    const ids = stringList(value.ticketIds).filter((id) => known.has(id));
    const requestedStatuses = stringList(value.statuses, 10).filter((status) => (
      ["triage", "backlog", "in_progress", "blocked", "review"].includes(status)
    )) as Ticket["status"][];
    const queue = {
      ...defaultQueueSpec(),
      ...(ids.length ? { ids } : {}),
      ...(!ids.length && requestedStatuses.length ? { statuses: requestedStatuses } : {}),
    };
    const concurrency = Math.max(1, Math.min(
      MAX_LOOP_CONCURRENCY,
      Math.floor(positiveNumber(value.concurrency, MAX_LOOP_CONCURRENCY) ?? 1),
    ));
    const maxTickets = positiveNumber(value.maxTickets, 10_000);
    const maxUsd = positiveNumber(value.maxUsd, 100_000);
    const maxWallClockMinutes = positiveNumber(value.maxWallClockMinutes, 7 * 24 * 60);
    const maxConsecutiveFailures = Math.floor(positiveNumber(value.maxConsecutiveFailures, 50) ?? 3);
    const created = this._store.create({
      title,
      queue,
      workers: { concurrency },
      approvals: defaultApprovalPosture(),
      ceilings: {
        ...(maxTickets ? { maxTickets } : {}),
        ...(maxUsd ? { maxUsd } : {}),
        ...(maxWallClockMinutes ? { maxWallClockMs: maxWallClockMinutes * 60_000 } : {}),
        maxConsecutiveFailures,
      },
    });
    this._selectedLoopId = created.definition.id;
    this._post({ type: "loops_notice", tone: "success", message: `Created “${created.definition.title}” as a draft.` });
    this._postState();
  }

  private async _askAgent(loopId: string, ticketId: string): Promise<void> {
    const record = this._store.get(loopId);
    if (!record) throw new Error("That loop no longer exists.");
    const iteration = ticketId
      ? record.iterations.slice().reverse().find((entry) => entry.ticketId === ticketId)
      : undefined;
    const target = ticketId ? `ticket ${ticketId}` : `loop “${record.definition.title}”`;
    const message = [
      `Help me inspect and act on ${target}.`,
      `Loop id: ${record.definition.id}`,
      `Status: ${record.definition.status}`,
      `Attempted ${record.totals.dispatched}; review ${record.totals.succeeded}; failed ${record.totals.failed}; review-blocked ${record.totals.parked}.`,
      iteration ? `Latest lane outcome: ${iteration.outcome}\n${iteration.detail}` : "",
      "Use loop_control to inspect current state before recommending or taking any allowed control action.",
    ].filter(Boolean).join("\n");
    await this._callbacks.askAgent?.(message, ticketId ? `${ticketId} loop lane` : record.definition.title);
  }

  private _postState(): void {
    const records = this._store.read().loops;
    if (this._selectedLoopId && !records.some((record) => record.definition.id === this._selectedLoopId)) {
      this._selectedLoopId = undefined;
    }
    if (!this._selectedLoopId) {
      this._selectedLoopId = records.find((record) => record.definition.status === "running")?.definition.id
        ?? records[0]?.definition.id;
    }
    const tickets = this._tickets.read().tickets;
    const indexedFiles = this._indexedFiles();
    const loops = records.map((record) => this._loopState(record, tickets, indexedFiles));
    this._post({
      type: "loops_state",
      loops,
      selectedLoopId: this._selectedLoopId,
      availableTickets: tickets.filter((ticket) => isOpenStatus(ticket.status)).map(ticketSummary),
      maxConcurrency: MAX_LOOP_CONCURRENCY,
      reviewer: {
        mode: "continuation_review",
        label: "Continuation review",
        detail: "A separate no-tools reviewer resolves ordinary approvals and blocks only unsafe tickets.",
      },
    });
  }

  private _postPendingUi(): void {
    if (!this._view) return;
    if (this._pendingIntent) {
      this._post({ type: "loops_intent", intent: this._pendingIntent });
      this._pendingIntent = undefined;
    }
    if (this._pendingConfirmation) this._post({ type: "loops_confirm", ...this._pendingConfirmation });
  }

  private _notice(tone: "success" | "error" | "info", message: string): void {
    this._post({ type: "loops_notice", tone, message });
  }

  private _loopState(
    record: LoopRecord,
    tickets: readonly Ticket[],
    indexedFiles: readonly string[],
  ): Record<string, unknown> {
    let proposal: ReturnType<typeof proposeLoop> | undefined;
    try {
      proposal = proposeLoop(tickets, record.definition.queue, indexedFiles);
    } catch {
      proposal = undefined;
    }
    const relevantIds = new Set([
      ...(proposal?.matchedTicketIds ?? []),
      ...record.iterations.map((iteration) => iteration.ticketId),
      ...record.ticketState.map((state) => state.ticketId),
    ]);
    return {
      ...record,
      proposal,
      tickets: tickets.filter((ticket) => relevantIds.has(ticket.id)).map(ticketSummary),
      activeLanes: record.iterations.filter((iteration) => !iteration.endedAt),
      supervisorRunning: this._supervisor.isRunning(record.definition.id),
    };
  }

  private _post(message: Record<string, unknown>): void {
    void this._view?.webview.postMessage(message);
  }
}

/** Resolve a loop command target from either the webview or a legacy tree invocation. */
export function loopIdOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const direct = text(value.loopId, 100);
  if (direct) return direct;
  const record = value.record;
  if (isRecord(record) && isRecord(record.definition)) return text(record.definition.id, 100) || undefined;
  return undefined;
}

export function parkedTicketOf(value: unknown): { loopId: string; ticketId: string } | undefined {
  if (!isRecord(value)) return undefined;
  const loopId = loopIdOf(value);
  const ticketId = text(value.ticketId, 80);
  return loopId && ticketId ? { loopId, ticketId } : undefined;
}
