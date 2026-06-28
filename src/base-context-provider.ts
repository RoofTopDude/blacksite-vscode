import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BaseContextStore } from "./base-context-store.js";

export class BaseContextProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _subscription: vscode.Disposable;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _workspaceRoot: string,
    private readonly _store: BaseContextStore,
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
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "src")],
    };
    webviewView.webview.html = this._loadHtml("base-context.html");
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
      undefined,
      this._context.subscriptions,
    );
    this._postState();
  }

  async promptAndAddFile(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== "file") {
      vscode.window.showWarningMessage("Blacksite: No workspace file is available to add to Base Context.");
      return;
    }

    const relative = path.relative(this._workspaceRoot, target.fsPath).replace(/\\/g, "/");
    if (!relative || relative.startsWith("..")) {
      vscode.window.showWarningMessage("Blacksite: Only files inside the current workspace can be added to Base Context.");
      return;
    }

    const document = this._store.read();
    const picks = document.topics.map((topic) => ({
      label: topic.title,
      description: topic.enabled ? "Included" : "Excluded",
      id: topic.id,
    }));
    picks.unshift({ label: "+ New topic", description: "Create a new Base Context topic", id: "__new__" });

    const pick = await vscode.window.showQuickPick(picks, {
      title: "Add File To Base Context",
      placeHolder: `Choose a topic for ${relative}`,
    });
    if (!pick) return;

    let topicId = pick.id;
    if (topicId === "__new__") {
      const title = await vscode.window.showInputBox({
        title: "New Base Context Topic",
        prompt: "Enter a topic title",
        value: path.basename(target.fsPath),
      });
      if (!title) return;
      topicId = this._store.createTopic(title).id;
    }

    try {
      this._store.addFile(topicId, target.fsPath);
      vscode.window.showInformationMessage(`Blacksite: Added ${relative} to Base Context.`);
      this._postState();
    } catch (err) {
      vscode.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "create_topic":
        this._store.createTopic(typeof msg.title === "string" ? msg.title : "New topic");
        break;
      case "update_topic":
        this._store.updateTopic(String(msg.topicId ?? ""), {
          title: typeof msg.title === "string" ? msg.title : undefined,
          notes: typeof msg.notes === "string" ? msg.notes : undefined,
          enabled: typeof msg.enabled === "boolean" ? msg.enabled : undefined,
          pinned: typeof msg.pinned === "boolean" ? msg.pinned : undefined,
        });
        break;
      case "delete_topic":
        this._store.deleteTopic(String(msg.topicId ?? ""));
        break;
      case "add_active_file":
        await this.promptAndAddFile(vscode.window.activeTextEditor?.document.uri);
        break;
      case "add_file_to_topic": {
        const target = vscode.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== "file") {
          vscode.window.showWarningMessage("Blacksite: Open a workspace file first.");
          break;
        }
        try {
          this._store.addFile(String(msg.topicId ?? ""), target.fsPath);
          this._postState();
        } catch (err) {
          vscode.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "remove_file":
        this._store.removeFile(String(msg.topicId ?? ""), String(msg.fileId ?? ""));
        break;
      case "open_file":
        await this._openFile(String(msg.path ?? ""));
        break;
    }
  }

  private async _openFile(relativePath: string): Promise<void> {
    if (!relativePath) return;
    const absolute = path.join(this._workspaceRoot, relativePath);
    if (!fs.existsSync(absolute)) {
      vscode.window.showWarningMessage(`Blacksite: ${relativePath} no longer exists in this workspace.`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(absolute);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private _postState(): void {
    if (!this._view) return;
    void this._view.webview.postMessage({
      type: "base_context_state",
      document: this._store.read(),
      activeFile: this._activeEditorRelativePath(),
    });
  }

  private _activeEditorRelativePath(): string | null {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "file") return null;
    const relative = path.relative(this._workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    return relative && !relative.startsWith("..") ? relative : null;
  }

  private _loadHtml(fileName: string): string {
    const htmlPath = path.join(this._context.extensionUri.fsPath, "src", "webview", fileName);
    try {
      return fs.readFileSync(htmlPath, "utf8");
    } catch {
      return "<h1>Blacksite — Base Context view not found</h1>";
    }
  }
}
