import { bindWorkspaceUi } from "./workspace-ui-host.js";
import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { PauReceiptBus, PauReceiptEvent } from "./pau-receipt-bus.js";

/** Bounded the same way agent-session.ts's tool-result overflow buffer is (FIFO-capped at 30) —
 *  a long session must not let this in-memory ring buffer grow unbounded. */
const MAX_RETAINED_RECEIPTS = 200;

/** Beta PAU metrics sidebar. Follows run-provider.ts's convention: `_postState()` rebuilds and
 *  pushes the entire view rather than diffing, and a hidden view is skipped and unconditionally
 *  corrected on the next reveal via `onDidChangeVisibility` — receipts arrive at most once per
 *  turn, so the fuller debounce/change-filtering machinery run-provider.ts needs for high-churn
 *  mutations isn't warranted here. */
export class PauMetricsProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _viewSubscriptions: vscode.Disposable[] = [];
  private readonly _subscription?: vscode.Disposable;
  private readonly _receipts: PauReceiptEvent[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    receiptBus?: PauReceiptBus,
  ) {
    this._subscription = receiptBus?.onReceipt((event) => this._onReceipt(event));
  }

  dispose(): void {
    this._subscription?.dispose();
    this._disposeViewSubscriptions();
    this._view = undefined;
  }

  private _disposeViewSubscriptions(): void {
    for (const subscription of this._viewSubscriptions.splice(0)) subscription.dispose();
  }

  private _onReceipt(event: PauReceiptEvent): void {
    this._receipts.push(event);
    if (this._receipts.length > MAX_RETAINED_RECEIPTS) {
      this._receipts.splice(0, this._receipts.length - MAX_RETAINED_RECEIPTS);
    }
    // A hidden view is written to nobody — onDidChangeVisibility reposts unconditionally on
    // reveal, so nothing is lost by skipping here, only a pointless postMessage avoided.
    if (this._view?.visible !== false) this._postState();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._disposeViewSubscriptions();
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "pau.js");
    this._viewSubscriptions.push(
      bindWorkspaceUi(webviewView.webview, this._context),
      webviewView.webview.onDidReceiveMessage((msg: unknown) => this._onMessage(msg)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._postState();
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) this._view = undefined;
      }),
    );
    this._postState();
  }

  private _onMessage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const type = String((value as Record<string, unknown>)["type"] ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "clear":
        this._receipts.length = 0;
        this._postState();
        break;
      case "open_settings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "blacksite.pau.enabled");
        break;
    }
  }

  private _enabled(): boolean {
    return vscode.workspace.getConfiguration("blacksite.pau").get<boolean>("enabled", false);
  }

  private _postState(): void {
    if (!this._view) return;
    void this._view.webview.postMessage({
      type: "pau_state",
      enabled: this._enabled(),
      receipts: this._receipts,
    });
  }
}
