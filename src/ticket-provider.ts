/* Sidebar webview for the ticket queue. Mirrors planning-provider.ts: pushes the whole
   document on change and re-pushes on reveal. Message handling, territory resolution, and
   autocomplete live in TicketSurfaceHost, shared with the board tab so the two surfaces
   cannot drift apart in what they can do. */

import * as vscode from "vscode";
import { TicketStore } from "./ticket-store.js";
import { TicketSurfaceHost } from "./ticket-surface-host.js";
import { type WorkspaceRoot } from "./graph/workspace-roots.js";
import { renderWebviewHtml } from "./webview-html.js";

export class TicketProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _subscriptions: vscode.Disposable[] = [];
  /** Scoped to one resolved view, not to the extension — see resolveWebviewView. */
  private readonly _viewSubscriptions: vscode.Disposable[] = [];
  private readonly _host: TicketSurfaceHost;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    store: TicketStore,
    workspaceRoot: string,
    graphRoots: () => WorkspaceRoot[] = () => [],
    indexedFiles: () => string[] = () => [],
    plans: () => Array<{ id: string; title: string; status?: string }> = () => [],
  ) {
    this._host = new TicketSurfaceHost({ store, workspaceRoot, roots: graphRoots, indexedFiles, plans });
    this._subscriptions.push(store.onDidChange(() => this._postState()));
  }

  /** Wired to GraphProvider.revealNote after construction, as PlanningProvider is. */
  setMapRevealer(reveal: (nodeId: string) => void): void {
    this._host.setMapRevealer(reveal);
  }

  /** Re-push when plans change, since a ticket's status can be derived from one. */
  notifyPlansChanged(): void {
    this._postState();
  }

  async reveal(ticketId: string): Promise<void> {
    await vscode.commands.executeCommand("blacksite.tickets.focus");
    this._postState();
    void this._view?.webview.postMessage({ type: "focus_ticket", ticketId });
  }

  dispose(): void {
    for (const subscription of this._subscriptions) subscription.dispose();
    this._disposeViewSubscriptions();
    this._view = undefined;
  }

  private _disposeViewSubscriptions(): void {
    for (const subscription of this._viewSubscriptions.splice(0)) subscription.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // This view does not set retainContextWhenHidden, so VS Code disposes it on hide and calls
    // back here on show. Registering into context.subscriptions would strand one dead listener
    // — and the dead webview it holds — per hide/show cycle.
    this._disposeViewSubscriptions();
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "tickets.js");
    this._viewSubscriptions.push(
      webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => void this._host.handle(
        msg,
        (message) => void webviewView.webview.postMessage(message),
        () => this._postState(),
      )),
      // Same self-healing resync as the Plans panel: a push made while this view was gone is
      // never more than one tab-switch away from being corrected.
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._postState();
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) this._view = undefined;
      }),
    );
    this._postState();
  }

  private _postState(): void {
    if (!this._view) return;
    void this._view.webview.postMessage(this._host.state());
  }
}
