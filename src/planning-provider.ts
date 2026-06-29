import * as vscode from "vscode";
import { PlanningStore } from "./planning-store.js";
import { renderWebviewHtml } from "./webview-html.js";

export class PlanningProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _subscription: vscode.Disposable;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: PlanningStore,
  ) {
    this._subscription = this._store.onDidChange(() => this._postState());
  }

  dispose(): void {
    this._subscription.dispose();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "planning.js");
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
      undefined,
      this._context.subscriptions,
    );
    this._postState();
  }

  private _onMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "clear_completed":
        this._store.clearCompleted();
        break;
      case "archive_plan":
        this._store.archivePlan(String(msg.planId ?? ""));
        break;
      case "archive_todo":
        this._store.archiveTodoRun(String(msg.todoId ?? ""));
        break;
    }
  }

  private _postState(): void {
    if (!this._view) return;
    const document = this._store.read();
    const activePlans = document.plans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled").length;
    const activeTodos = document.todoRuns.filter((run) => !run.completedAt).length;
    void this._view.webview.postMessage({
      type: "planning_state",
      document,
      counts: {
        activePlans,
        activeTodos,
        totalPlans: document.plans.length,
        totalTodos: document.todoRuns.length,
      },
    });
  }
}
