/* The full ticket board as an editor tab, so VS Code's split-editor controls can place it
   beside source files. Modeled on notes-timeline-provider.ts.

   The sidebar queue and this board read the same TicketStore and post the same message shapes;
   the difference is density and interaction, not data. A ticket edited in either surface shows
   up in the other on the store's next change event. */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { resolveTerritory, type Ticket, type TicketStore } from "./ticket-store.js";
import { fromNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";
import { renderWebviewHtml } from "./webview-html.js";

export class TicketBoardPanel implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private _revealOnMap?: (nodeId: string) => void;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: TicketStore,
    private readonly _workspaceRoot: string,
    private readonly _roots: () => WorkspaceRoot[] = () => [],
    private readonly _indexedFiles: () => string[] = () => [],
  ) {
    this._subscriptions.push(this._store.onDidChange(() => this._post()));
  }

  setMapRevealer(reveal: (nodeId: string) => void): void {
    this._revealOnMap = reveal;
  }

  dispose(): void {
    this._panel?.dispose();
    for (const subscription of this._subscriptions) subscription.dispose();
  }

  open(): void {
    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "blacksite.tickets.board",
      "Blacksite: Board",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
      },
    );
    this._panel = panel;
    panel.webview.html = renderWebviewHtml(panel.webview, this._context.extensionUri, "board.js");
    const receive = panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
    );
    // Tickets change from the sidebar, the agent, and plan transitions while this tab is
    // hidden; resync on reveal rather than trusting every intervening push was observed.
    const viewState = panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible) this._post();
    });
    panel.onDidDispose(() => {
      receive.dispose();
      viewState.dispose();
      this._panel = undefined;
    });
    this._post();
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const ctx = { sessionId: "webview" };
    switch (String(msg.type ?? "")) {
      case "ready":
      case "refresh":
        this._post();
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
        this._openFile(String(msg.path ?? ""));
        break;
      case "show_on_map":
        if (String(msg.path ?? "").trim()) this._revealOnMap?.(String(msg.path));
        break;
    }
  }

  /** Same containment guard the sidebar and Plans panel use — territory ids are model-authored. */
  private _openFile(relativePath: string): void {
    const raw = relativePath.trim();
    if (!raw) return;
    const roots = this._roots();
    const candidates = [
      ...(fromNodeId(roots, raw) ? [path.resolve(fromNodeId(roots, raw)!)] : []),
      path.resolve(this._workspaceRoot, raw),
    ];
    const bases = [this._workspaceRoot, ...roots.map((root) => root.path)].map((base) => path.resolve(base));
    for (const candidate of candidates) {
      if (!bases.some((base) => candidate === base || candidate.startsWith(base + path.sep))) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        void vscode.window.showTextDocument(vscode.Uri.file(candidate), { preview: false });
        return;
      }
    }
    void vscode.window.showWarningMessage(`Blacksite: ${raw} isn't a file in this workspace.`);
  }

  private _post(): void {
    if (!this._panel) return;
    const { document, dropped } = this._store.readWithDiagnostics();
    const indexed = this._indexedFiles();
    void this._panel.webview.postMessage({
      type: "tickets_state",
      tickets: document.tickets,
      territory: Object.fromEntries(
        document.tickets.map((ticket: Ticket) => [ticket.id, resolveTerritory(ticket.territory, indexed)]),
      ),
      dropped,
    });
  }
}
