import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PlanningStore, normalizePlanStatus } from "./planning-store.js";
import { renderWebviewHtml } from "./webview-html.js";

export class PlanningProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _subscription: vscode.Disposable;
  /** Cross-wired to GraphProvider.revealNote after construction (same pattern the
      Notes timeline uses) so a phase's declared map territory is clickable
      through to the Map, not just readable. */
  private _revealOnMap?: (nodeId: string) => void;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: PlanningStore,
    private readonly _workspaceRoot: string,
  ) {
    this._subscription = this._store.onDidChange(() => this._postState());
  }

  setMapRevealer(reveal: (nodeId: string) => void): void {
    this._revealOnMap = reveal;
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
    // Self-healing resync: this view stays alive while hidden (retainContextWhenHidden), so
    // onDidChange pushes made while it's off-screen should already land — but VS Code's postMessage
    // delivery to a backgrounded webview isn't guaranteed to be observed the instant it happens.
    // Re-pushing on every reveal means a plan the agent updated while this panel was hidden (or a
    // missed push for any other reason) is never more than one tab-switch away from correct,
    // instead of requiring the user to notice it's stale and hit Refresh themselves.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._postState();
    }, undefined, this._context.subscriptions);
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
      // Permanent, irreversible removal — the plan and everything documented under it. Archiving
      // (below, via set_plan_status) is the non-destructive default; this is a separate, explicit
      // action the webview only offers after a confirm step, for a plan the user is truly done with.
      case "delete_plan":
        this._store.deletePlan(String(msg.planId ?? ""));
        break;
      case "set_plan_status": {
        const planId = String(msg.planId ?? "");
        const status = normalizePlanStatus(msg.status);
        if (planId && status) this._store.setPlanStatus(planId, status);
        break;
      }
      case "archive_todo":
        this._store.archiveTodoRun(String(msg.todoId ?? ""));
        break;
      case "set_plan_archive_permission": {
        const planId = String(msg.planId ?? "");
        if (planId) this._store.setAgentCanArchive(planId, msg.allow === true);
        break;
      }
      case "set_plan_execution_approval": {
        const planId = String(msg.planId ?? "");
        if (planId) this._store.setExecutionApproved(planId, msg.approved === true);
        break;
      }
      case "new_plan_doc": {
        const planId = String(msg.planId ?? "");
        const phaseId = msg.phaseId ? String(msg.phaseId) : undefined;
        const title = String(msg.title ?? "Untitled doc");
        const res = this._store.createDoc(planId, phaseId, msg.kind, title);
        if ((res as { ok?: boolean; doc?: { id: string } }).ok) {
          this._openDoc(planId, (res as { doc: { id: string } }).doc.id);
        }
        break;
      }
      case "add_plan_doc_file":
        void this._addDocFile(String(msg.planId ?? ""), msg.phaseId ? String(msg.phaseId) : undefined);
        break;
      case "delete_plan_doc": {
        const planId = String(msg.planId ?? "");
        const docId = String(msg.docId ?? "");
        if (planId && docId) this._store.deleteDoc(planId, docId);
        break;
      }
      case "open_plan_doc": {
        const planId = String(msg.planId ?? "");
        const docId = String(msg.docId ?? "");
        if (planId && docId) this._openDoc(planId, docId);
        break;
      }
      case "open_phase_file": {
        this._openWorkspaceFile(String(msg.path ?? ""));
        break;
      }
      case "show_phase_file_on_map": {
        const nodeId = String(msg.path ?? "").trim();
        if (nodeId) this._revealOnMap?.(nodeId);
        break;
      }
      case "read_plan_doc": {
        const planId = String(msg.planId ?? "");
        const docId = String(msg.docId ?? "");
        if (!planId || !docId) break;
        const res = this._store.dispatch("docRead", { planId, docId }, { sessionId: "webview" });
        void res.then((result) => {
          void this._view?.webview.postMessage({ type: "plan_doc_content", planId, docId, ...result });
        });
        break;
      }
    }
  }

  /** Opens one of a phase's declared map-territory files in an editor tab.
   *  The stored ids are workspace-relative by construction, but they were authored by a
   *  model, so the resolved path is re-checked against the workspace root before opening —
   *  a "../../" id must not turn a plan into an arbitrary-file reader. */
  private _openWorkspaceFile(relativePath: string): void {
    const raw = relativePath.trim();
    if (!raw) return;
    const resolved = path.resolve(this._workspaceRoot, raw);
    const root = path.resolve(this._workspaceRoot);
    const withinWorkspace = resolved === root || resolved.startsWith(root + path.sep);
    if (!withinWorkspace || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      void vscode.window.showWarningMessage(`Blacksite: ${raw} isn't a file in this workspace.`);
      return;
    }
    void vscode.window.showTextDocument(vscode.Uri.file(resolved), { preview: false });
  }

  /** Opens a doc's underlying file in a real VSCode editor tab (markdown docs) or reveals it
   *  in the OS file browser (file attachments, which can be any type — no in-editor viewer for
   *  arbitrary binaries). Mirrors chat-provider.ts's "open_file" message handling. */
  private _openDoc(planId: string, docId: string): void {
    const resolved = this._store.resolveDocPath(planId, docId);
    if (!resolved || !fs.existsSync(resolved.path)) {
      void vscode.window.showWarningMessage("Blacksite: that doc's file no longer exists on disk.");
      return;
    }
    const uri = vscode.Uri.file(resolved.path);
    if (resolved.isAttachment) {
      void vscode.commands.executeCommand("revealFileInOS", uri);
    } else {
      void vscode.window.showTextDocument(uri, { preview: false });
    }
  }

  private async _addDocFile(planId: string, phaseId: string | undefined): Promise<void> {
    if (!planId) return;
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Attach to plan" });
    const file = picked?.[0];
    if (!file) return;
    const res = this._store.attachDocFile(planId, phaseId, file.fsPath);
    if (!(res as { ok?: boolean }).ok) {
      void vscode.window.showWarningMessage(`Blacksite: ${(res as { error?: string }).error ?? "Could not attach that file."}`);
    }
  }

  private _postState(): void {
    if (!this._view) return;
    const document = this._store.read();
    const activePlans = document.plans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled" && plan.status !== "archived").length;
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
