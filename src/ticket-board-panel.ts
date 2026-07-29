/* The full ticket board as an editor tab, so VS Code's split-editor controls can place it
   beside source files. Modeled on notes-timeline-provider.ts.

   The sidebar queue and this board read the same TicketStore through the same
   TicketSurfaceHost; the difference is density and interaction, not data. A ticket edited in
   either surface shows up in the other on the store's next change event. */

import * as vscode from "vscode";
import { type TicketStore } from "./ticket-store.js";
import { TicketSurfaceHost } from "./ticket-surface-host.js";
import { type WorkspaceRoot } from "./graph/workspace-roots.js";
import { renderWebviewHtml } from "./webview-html.js";

export class TicketBoardPanel implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _host: TicketSurfaceHost;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    store: TicketStore,
    workspaceRoot: string,
    roots: () => WorkspaceRoot[] = () => [],
    indexedFiles: () => string[] = () => [],
    plans: () => Array<{ id: string; title: string; status?: string }> = () => [],
  ) {
    this._host = new TicketSurfaceHost({ store, workspaceRoot, roots, indexedFiles, plans });
    this._subscriptions.push(store.onDidChange(() => this._post()));
  }

  setMapRevealer(reveal: (nodeId: string) => void): void {
    this._host.setMapRevealer(reveal);
  }

  /** Re-push when plans change: a linked ticket's status is derived from its plan. */
  notifyPlansChanged(): void {
    this._post();
  }

  dispose(): void {
    this._panel?.dispose();
    for (const subscription of this._subscriptions) subscription.dispose();
  }

  /** `focusTicketId` opens the board with one ticket already selected — the sidebar's
   *  "open in board" hand-off, so the context of the click survives the jump. */
  open(focusTicketId?: string): void {
    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn, false);
      if (focusTicketId) void this._panel.webview.postMessage({ type: "focus_ticket", ticketId: focusTicketId });
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
    const receive = panel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => void (async () => {
      const handled = await this._host.handle(
        msg,
        (message) => void panel.webview.postMessage(message),
        () => this._post(),
      );
      // The board is the surface the sidebar hands off to, so it answers the hand-off itself
      // rather than bouncing back through the command that opened it.
      if (!handled && String(msg.type ?? "") === "ready" && focusTicketId) {
        void panel.webview.postMessage({ type: "focus_ticket", ticketId: focusTicketId });
      }
    })());
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
    if (focusTicketId) void panel.webview.postMessage({ type: "focus_ticket", ticketId: focusTicketId });
  }

  private _post(): void {
    if (!this._panel) return;
    void this._panel.webview.postMessage(this._host.state());
  }
}
