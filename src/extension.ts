import * as vscode from "vscode";
import * as path from "path";
import { LocalRuntime } from "@blacksite/local-runtime";
import { ChatProvider } from "./chat-provider.js";
import { SecretStore } from "./secret-store.js";
import { SessionStore } from "./session-store.js";
import { MemoryStore } from "./memory-store.js";
import { loadCheckpoint, hasCheckpoint } from "./checkpoint.js";
import { registerFileWatcher, getSelectionContext, getFileContext, getDiagnosticContext } from "./workspace-context.js";
import { BlacksiteCodeActionProvider } from "./code-actions.js";
import { DiagnosticsPublisher } from "./diagnostics-publisher.js";
import { McpPanel } from "./mcp-panel.js";
import { BaseContextStore } from "./base-context-store.js";
import { PlanningStore } from "./planning-store.js";
import { BaseContextProvider } from "./base-context-provider.js";
import { PlanningProvider } from "./planning-provider.js";
import { createDataWorkbench, DataProvider } from "./data-provider.js";

let chatProvider: ChatProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? vscode.workspace.getConfiguration("blacksite").get<string>("workspaceRoot")
    ?? process.cwd();

  const runtime     = new LocalRuntime(workspaceRoot);
  const secrets     = new SecretStore(context.secrets);
  const sessionStore = new SessionStore(context);
  const memory      = new MemoryStore(workspaceRoot);
  const baseContext = new BaseContextStore(workspaceRoot);
  const planning    = new PlanningStore(workspaceRoot);
  // Non-fatal: these write to workspaceRoot which may be unwritable (e.g. system
  // cwd when no folder is open). The extension still activates without storage.
  try { memory.ensureInitialized(); } catch { /* ok — memory runs read-only */ }
  try { baseContext.ensureInitialized(); } catch { /* ok */ }
  try { planning.ensureInitialized(); } catch { /* ok */ }
  context.subscriptions.push(baseContext, planning);

  const diagnostics = new DiagnosticsPublisher(workspaceRoot);
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });

  // Embedded database substrate. Bootstrapping is non-fatal: if no SQLite binding is
  // present the workbench reports an unavailable status and everything else still runs.
  const dataWorkbench = createDataWorkbench(context, workspaceRoot);
  context.subscriptions.push({ dispose: () => dataWorkbench.dispose() });

  chatProvider = new ChatProvider(context, runtime, secrets, sessionStore, workspaceRoot, memory, diagnostics, planning, dataWorkbench.surface ?? undefined);
  const baseContextProvider = new BaseContextProvider(context, workspaceRoot, baseContext);
  const planningProvider = new PlanningProvider(context, planning);
  const dataProvider = new DataProvider(context, workspaceRoot, dataWorkbench);
  context.subscriptions.push(baseContextProvider, planningProvider, dataProvider);

  // The database assistant reuses the chat provider's configured model + secrets.
  if (dataWorkbench.surface) {
    dataProvider.setAssistant(chatProvider.createDataAssistant(dataWorkbench.surface));
  }

  // ── Webview panel ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.plans", planningProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.baseContext", baseContextProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.data", dataProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Data workbench commands ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openData", () => {
      void vscode.commands.executeCommand("blacksite.data.focus");
    }),
    vscode.commands.registerCommand("blacksite.refreshData", () => {
      dataProvider.refresh();
    }),
    vscode.commands.registerCommand("blacksite.runQuery", async () => {
      const sql = await vscode.window.showInputBox({
        title: "Blacksite: Run Database Query",
        prompt: "Enter SQL to load into the Data workbench Query tab",
        placeHolder: "SELECT * FROM v_recent_agent_activity LIMIT 50",
      });
      if (!sql) return;
      await vscode.commands.executeCommand("blacksite.data.focus");
      dataProvider.loadQueryIntoEditor(sql);
    }),
    vscode.commands.registerCommand("blacksite.openSavedQuery", async () => {
      const surface = dataWorkbench.surface;
      if (!surface) {
        vscode.window.showWarningMessage("Blacksite: The database engine is unavailable.");
        return;
      }
      const saved = surface.listSavedQueries();
      if (saved.length === 0) {
        vscode.window.showInformationMessage("Blacksite: No saved queries yet.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        saved.map((q) => ({ label: q.name, description: q.sql.slice(0, 80), id: q.id })),
        { title: "Open Saved Query", placeHolder: "Select a saved query" },
      );
      if (!pick) return;
      const query = surface.getSavedQuery(pick.id);
      if (query) {
        await vscode.commands.executeCommand("blacksite.data.focus");
        dataProvider.loadQueryIntoEditor(query.sql);
      }
    }),
  );

  // ── Code action provider (Fix/Explain in the editor gutter) ─
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new BlacksiteCodeActionProvider(),
      { providedCodeActionKinds: BlacksiteCodeActionProvider.providedCodeActionKinds },
    ),
  );

  // ── Commands ───────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openChat", () => {
      void vscode.commands.executeCommand("blacksite.chat.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.clearChat", () => {
      chatProvider?.clearMessages();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.cancelRun", () => {
      chatProvider?.cancelCurrentRun();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "anthropic", value: "anthropic" },
          { label: "openrouter", value: "openrouter" },
          { label: "openai", value: "openai" },
          { label: "bedrock", value: "bedrock", description: "AWS region + access/secret keys" },
          { label: "github", value: "github" },
          { label: "gitlab", value: "gitlab" },
          { label: "jira", value: "jira" },
          { label: "confluence", value: "confluence" },
          { label: "salesforce", value: "salesforce" },
        ],
        { placeHolder: "Select provider", title: "Blacksite: Set API Key / Credentials" },
      );
      if (!provider) return;
      await secrets.promptForApiKey(provider.value);
    }),
  );

  // Explain the current editor selection in chat
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.explainSelection", () => {
      const ctx = getSelectionContext();
      if (!ctx) {
        vscode.window.showWarningMessage("Blacksite: Select some code first.");
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode.commands.executeCommand("blacksite.chat.focus");
    }),
  );

  // Ask about a file — triggered from editor or explorer context menu
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.askAboutFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage("Blacksite: No file selected.");
        return;
      }
      const ctx = getFileContext(target);
      if (!ctx) {
        vscode.window.showWarningMessage(`Blacksite: Could not read ${path.basename(target.fsPath)}.`);
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode.commands.executeCommand("blacksite.chat.focus");
    }),
  );

  // Fix a specific diagnostic — called from code action, not command palette
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "blacksite.fixDiagnostic",
      async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
        const base = getDiagnosticContext(uri, diagnostic);
        let ctx = base;
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const startLine = Math.max(0, diagnostic.range.start.line - 3);
          const endLine   = Math.min(doc.lineCount - 1, diagnostic.range.end.line + 3);
          const snippet   = doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
          ctx = { ...base, text: `${base.text}\n\n\`\`\`${doc.languageId}\n${snippet}\n\`\`\`` };
        } catch { /* use base ctx */ }
        chatProvider?.injectContext(ctx.text, ctx.label);
        void vscode.commands.executeCommand("blacksite.chat.focus");
      },
    ),
  );

  // MCP server management panel
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.manageMcp", () => {
      McpPanel.show(context);
    }),
  );

  // Clear any problems Blacksite has surfaced into the Problems panel
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.clearProblems", () => {
      diagnostics.clear();
    }),
  );

  // Close the Chromium browser window (the runner re-opens it on next use)
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.closeBrowser", async () => {
      await chatProvider?.closeBrowser();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.showLogs", () => {
      chatProvider?.showLogs();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.compactConversation", async () => {
      await chatProvider?.compactConversation();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.addFileToBaseContext", async (uri?: vscode.Uri) => {
      await baseContextProvider.promptAndAddFile(uri);
    }),
  );

  // ── File watcher (live workspace context refresh) ──────────
  const watcher = registerFileWatcher(workspaceRoot, () => {
    // Context is re-gathered on each send() call — watcher is a hook for future caching
  });
  context.subscriptions.push(watcher);

  // ── Checkpoint resume ──────────────────────────────────────
  if (hasCheckpoint(context)) {
    const cp = loadCheckpoint(context);
    if (cp) {
      // Defer until after activation so the webview has time to mount
      setTimeout(() => { void chatProvider?.offerCheckpointResume(cp); }, 1500);
    }
  }
}

export function deactivate(): void {
  chatProvider = undefined;
}
