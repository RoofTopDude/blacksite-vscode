/**
 * The Loops view.
 *
 * A tree, not a webview, and deliberately so: a loop is a short row of facts — status, how far
 * through, what is waiting on you, what it has cost — and a tree renders those natively, sorts
 * with the rest of the sidebar, and needs no protocol of its own.
 *
 * The one thing this surface must never do is overstate what a loop achieved. Under
 * `user_review` closure a drained loop has produced a review pile, not finished work, and the
 * labels here say exactly that.
 */

import * as vscode from "vscode";
import type { LoopRecord, LoopStatus } from "./loop-model.js";
import type { LoopStore } from "./loop-store.js";
import type { LoopSupervisor } from "./loop-supervisor.js";

type LoopNode =
  | { kind: "loop"; record: LoopRecord }
  | { kind: "detail"; loopId: string; label: string; description: string; icon: string }
  | { kind: "parked"; loopId: string; ticketId: string; gate: string };

const STATUS_ICON: Record<LoopStatus, string> = {
  draft: "circle-outline",
  running: "sync~spin",
  paused: "debug-pause",
  blocked: "warning",
  drained: "check-all",
  stopped: "circle-slash",
  failed: "error",
};

/** Deliberately not "complete": under user_review closure a drained loop has produced a review
 *  pile. Calling that "12/12 complete" over a stack of unreviewed work would be a lie. */
const STATUS_LABEL: Record<LoopStatus, string> = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  blocked: "Nothing dispatchable",
  drained: "All attempted — awaiting review",
  stopped: "Stopped",
  failed: "Failed",
};

export class LoopTreeProvider implements vscode.TreeDataProvider<LoopNode>, vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<LoopNode | undefined>();
  readonly onDidChangeTreeData = this._emitter.event;
  private readonly _subscription: vscode.Disposable;

  constructor(
    private readonly _store: LoopStore,
    private readonly _supervisor: LoopSupervisor,
  ) {
    this._subscription = this._store.onDidChange(() => this._emitter.fire(undefined));
  }

  dispose(): void {
    this._subscription.dispose();
    this._emitter.dispose();
  }

  refresh(): void {
    this._emitter.fire(undefined);
  }

  getTreeItem(node: LoopNode): vscode.TreeItem {
    if (node.kind === "detail") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }

    if (node.kind === "parked") {
      const item = new vscode.TreeItem(node.ticketId, vscode.TreeItemCollapsibleState.None);
      item.description = `waiting on ${node.gate}`;
      item.iconPath = new vscode.ThemeIcon("key");
      item.contextValue = "blacksiteLoopParked";
      item.tooltip = "This ticket stopped on an approval the loop was not configured to grant. "
        + "Release it once you have decided.";
      return item;
    }

    const { definition, totals } = node.record;
    const item = new vscode.TreeItem(definition.title, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = definition.id;
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON[definition.status]);
    item.description = STATUS_LABEL[definition.status];
    item.contextValue = `blacksiteLoop:${definition.status}`;

    const lines = [
      `**${definition.title}** — ${STATUS_LABEL[definition.status]}`,
      "",
      `Attempted: ${totals.dispatched}`,
      `Sent to review: ${totals.succeeded}`,
      `Failed: ${totals.failed}`,
      `Parked on approvals: ${totals.parked}`,
      `Workers: ${definition.workers.concurrency}`,
    ];
    if (totals.usd > 0) lines.push(`Spent: $${totals.usd.toFixed(2)}`);
    if (definition.endedReason) lines.push("", `_${definition.endedReason}_`);
    if (definition.status === "drained") {
      lines.push("", "_Every ticket was attempted. None were closed — they are waiting for your review._");
    }
    item.tooltip = new vscode.MarkdownString(lines.join("\n"));
    return item;
  }

  getChildren(node?: LoopNode): LoopNode[] {
    if (!node) {
      return this._store.read().loops.map((record) => ({ kind: "loop" as const, record }));
    }
    if (node.kind !== "loop") return [];

    const { definition, totals, ticketState } = node.record;
    const children: LoopNode[] = [
      {
        kind: "detail",
        loopId: definition.id,
        label: "Attempted",
        description: `${totals.dispatched}${definition.ceilings.maxTickets ? ` of max ${definition.ceilings.maxTickets}` : ""}`,
        icon: "checklist",
      },
      {
        kind: "detail",
        loopId: definition.id,
        label: "Awaiting your review",
        description: String(totals.succeeded),
        icon: "eye",
      },
    ];

    if (totals.failed) {
      children.push({
        kind: "detail", loopId: definition.id, label: "Failed",
        description: String(totals.failed), icon: "error",
      });
    }
    if (totals.usd > 0) {
      children.push({
        kind: "detail", loopId: definition.id, label: "Spent",
        description: `$${totals.usd.toFixed(2)}`, icon: "credit-card",
      });
    }

    for (const state of ticketState) {
      if (!state.parkedOnGate) continue;
      children.push({ kind: "parked", loopId: definition.id, ticketId: state.ticketId, gate: state.parkedOnGate });
    }

    return children;
  }

  /** The supervisor is reached through the view for the tree's own commands. */
  supervisor(): LoopSupervisor {
    return this._supervisor;
  }
}

/** Resolve the loop a tree command was invoked on. */
export function loopIdOf(node: unknown): string | undefined {
  const candidate = node as LoopNode | undefined;
  if (!candidate) return undefined;
  if (candidate.kind === "loop") return candidate.record.definition.id;
  return candidate.loopId;
}

export function parkedTicketOf(node: unknown): { loopId: string; ticketId: string } | undefined {
  const candidate = node as LoopNode | undefined;
  if (candidate?.kind !== "parked") return undefined;
  return { loopId: candidate.loopId, ticketId: candidate.ticketId };
}
