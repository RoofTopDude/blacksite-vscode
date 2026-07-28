/* Sidebar webview for the ticket queue. Mirrors planning-provider.ts: pushes the whole
   document on change, coerces incoming webview messages, and cross-wires to the Map so a
   ticket's territory is navigable rather than merely readable. */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { TicketStore, resolveTerritory, type Ticket } from "./ticket-store.js";
import { fromNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";
import { renderWebviewHtml } from "./webview-html.js";

export class TicketProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private _revealOnMap?: (nodeId: string) => void;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: TicketStore,
    private readonly _workspaceRoot: string,
    private readonly _graphRoots: () => WorkspaceRoot[] = () => [],
    private readonly _indexedFiles: () => string[] = () => [],
  ) {
    this._subscriptions.push(this._store.onDidChange(() => this._postState()));
  }

  /** Wired to GraphProvider.revealNote after construction, as PlanningProvider is. */
  setMapRevealer(reveal: (nodeId: string) => void): void {
    this._revealOnMap = reveal;
  }

  /** Re-push when plans change, since a ticket's status can be derived from one. */
  notifyPlansChanged(): void {
    this._postState();
  }

  dispose(): void {
    for (const subscription of this._subscriptions) subscription.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "tickets.js");
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
      undefined,
      this._context.subscriptions,
    );
    // Same self-healing resync as the Plans panel: a push made while this view was hidden is
    // never more than one tab-switch away from being corrected.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._postState();
    }, undefined, this._context.subscriptions);
    this._postState();
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    const ctx = { sessionId: "webview" };
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "file_ticket":
        this._store.fileTicket(msg, ctx);
        break;
      case "update_ticket":
        this._store.updateTicket(msg, ctx);
        break;
      case "comment_ticket":
        this._store.commentOnTicket(msg, ctx);
        break;
      case "delete_ticket":
        this._store.deleteTicket(String(msg.ticketId ?? ""));
        break;
      case "reorder_ticket":
        this._store.reorderTicket(String(msg.ticketId ?? ""), Number(msg.toIndex) || 0);
        break;
      case "open_file":
        this._openWorkspaceFile(String(msg.path ?? ""));
        break;
      case "show_on_map": {
        const nodeId = String(msg.path ?? "").trim();
        if (nodeId) this._revealOnMap?.(nodeId);
        break;
      }
      case "open_plan":
        await vscode.commands.executeCommand("blacksite.plans.focus");
        break;
    }
  }

  /**
   * Opens a ticket's declared territory file. The stored ids are workspace-relative by
   * construction but were authored by a model, so the resolved path is re-checked against the
   * workspace roots before opening — a "../../" id must not turn the queue into an arbitrary
   * file reader. Mirrors PlanningProvider._resolvePhaseFile exactly.
   */
  private _openWorkspaceFile(relativePath: string): void {
    const raw = relativePath.trim();
    if (!raw) return;
    const roots = this._graphRoots();
    const candidates: string[] = [];
    const viaMapId = fromNodeId(roots, raw);
    if (viaMapId) candidates.push(path.resolve(viaMapId));
    candidates.push(path.resolve(this._workspaceRoot, raw));

    const bases = [this._workspaceRoot, ...roots.map((root) => root.path)].map((base) => path.resolve(base));
    for (const candidate of candidates) {
      const contained = bases.some((base) => candidate === base || candidate.startsWith(base + path.sep));
      if (!contained) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        void vscode.window.showTextDocument(vscode.Uri.file(candidate), { preview: false });
        return;
      }
    }
    void vscode.window.showWarningMessage(`Blacksite: ${raw} isn't a file in this workspace.`);
  }

  private _postState(): void {
    if (!this._view) return;
    const { document, dropped } = this._store.readWithDiagnostics();
    const indexed = this._indexedFiles();
    void this._view.webview.postMessage({
      type: "tickets_state",
      tickets: document.tickets,
      // Territory resolution is derived per read, so the webview never has to guess which
      // declared files still exist.
      territory: Object.fromEntries(
        document.tickets.map((ticket: Ticket) => [ticket.id, resolveTerritory(ticket.territory, indexed)]),
      ),
      dropped,
      labels: this._labelFrequency(document.tickets),
    });
  }

  /** Workspace label vocabulary, derived from usage rather than configured — this is what
   *  stops `auth` / `authentication` / `Auth` from coexisting, with no registry to maintain. */
  private _labelFrequency(tickets: Ticket[]): Array<{ label: string; count: number }> {
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      for (const label of ticket.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }
}
