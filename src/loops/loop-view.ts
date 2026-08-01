/** Host bridge for the retained Ticket Loops workbench. */

import * as vscode from "vscode";
import { isOpenStatus, type Ticket, type TicketStore } from "../ticket-store.js";
import { renderWebviewHtml } from "../webview-html.js";
import { defaultApprovalPosture, defaultQueueSpec, type LoopRecord } from "./loop-model.js";
import { proposeLoop } from "./loop-proposal.js";
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
  | "release_ticket"
  | "open_ticket"
  | "ask_agent";

interface LoopCommandTarget {
  loopId: string;
  ticketId?: string;
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

  private async _onMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== "string") return;
    const operation = value.type as LoopOperation;
    try {
      switch (operation) {
        case "ready":
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
          await vscode.commands.executeCommand("blacksite.loops.start", this._target(value));
          return;
        case "pause_loop":
          await vscode.commands.executeCommand("blacksite.loops.pause", this._target(value));
          return;
        case "stop_loop":
          await vscode.commands.executeCommand("blacksite.loops.stop", this._target(value));
          return;
        case "delete_loop":
          await vscode.commands.executeCommand("blacksite.loops.delete", this._target(value));
          return;
        case "release_ticket":
          await vscode.commands.executeCommand("blacksite.loops.releasePark", this._target(value, true));
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
