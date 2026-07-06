import * as vscode from "vscode";
import * as path from "path";
import { LocalRuntime, type CommandPolicy } from "@blacksite/local-runtime";
import { ChatProvider } from "./chat-provider.js";
import { SecretStore } from "./secret-store.js";
import { SessionStore } from "./session-store.js";
import { MemoryStore } from "./memory-store.js";
import { ReferenceStore } from "./reference-store.js";
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
import { ExtensionUpdater } from "./update-service.js";
import { GraphIndexer } from "./graph/graph-indexer.js";
import { GraphProvider, readGraphConfig } from "./graph-provider.js";
import { AgentActivityBus } from "./agent-activity-bus.js";
import { GraphAnnotationStore } from "./graph-annotation-store.js";
import { GraphAgentGateway } from "./graph-agent-gateway.js";
import { RelationshipSnapshot } from "./graph/relationship-snapshot.js";
import { SymbolIndexer } from "./graph/symbol-indexer.js";
import { buildWorkspaceRoots } from "./graph/workspace-roots.js";

let chatProvider: ChatProvider | undefined;

/** Build the runtime command-permission policy from the user's `blacksite.permissions.*` settings. */
function readCommandPolicy(): CommandPolicy {
  const cfg = vscode.workspace.getConfiguration("blacksite.permissions");
  const list = (key: string): string[] => {
    const value = cfg.get<unknown>(key, []);
    return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
  };
  return {
    allowedCommands: list("allowedCommands"),
    deniedCommands: list("deniedCommands"),
    autoApprove: list("autoApprove"),
    allowEvalFlags: cfg.get<boolean>("allowEvalFlags", false),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? vscode.workspace.getConfiguration("blacksite").get<string>("workspaceRoot")
    ?? process.cwd();

  /* The Codebase Map indexes every open workspace folder (not just the
     first), so it needs the live folder list rather than the single root
     the rest of the extension uses. Recomputed on each call so it stays
     current if folders are added/removed. */
  const getGraphRoots = () => {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return buildWorkspaceRoots(folders.map((f) => ({ name: f.name, path: f.uri.fsPath })));
    }
    return buildWorkspaceRoots([{ name: "workspace", path: workspaceRoot }]);
  };

  const runtime     = new LocalRuntime(workspaceRoot, readCommandPolicy());
  // Keep the runtime's command-permission policy in sync with user settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blacksite.permissions")) runtime.setPolicy(readCommandPolicy());
    }),
  );
  const secrets     = new SecretStore(context.secrets);
  const sessionStore = new SessionStore(context);
  const memory      = new MemoryStore(workspaceRoot);
  const baseContext = new BaseContextStore(workspaceRoot);
  const planning    = new PlanningStore(workspaceRoot);
  const reference   = new ReferenceStore(workspaceRoot);
  // Non-fatal: these write to workspaceRoot which may be unwritable (e.g. system
  // cwd when no folder is open). The extension still activates without storage.
  try { memory.ensureInitialized(); } catch { /* ok — memory runs read-only */ }
  try { baseContext.ensureInitialized(); } catch { /* ok */ }
  try { planning.ensureInitialized(); } catch { /* ok */ }
  try { reference.ensureInitialized(); } catch { /* ok — reference attachments run read-only */ }
  context.subscriptions.push(baseContext, planning);

  const diagnostics = new DiagnosticsPublisher(workspaceRoot);
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });

  // Embedded database substrate. Bootstrapping is non-fatal: if no SQLite binding is
  // present the workbench reports an unavailable status and everything else still runs.
  const dataWorkbench = createDataWorkbench(context, workspaceRoot);
  context.subscriptions.push({ dispose: () => dataWorkbench.dispose() });

  const activityBus = new AgentActivityBus();
  const graphAnnotations = new GraphAnnotationStore(getGraphRoots);
  try { graphAnnotations.ensureInitialized(); } catch { /* ok — map annotations run read-only */ }
  const graphIndexer = new GraphIndexer(getGraphRoots, () => readGraphConfig());
  /* Validate note endpoints against the full *indexed* set, not just the
     rendered stars — on a large workspace a real .cs file can be indexed but
     beyond the render cap, and a relationship note on it must still persist. */
  graphAnnotations.setNodeLookup(() => {
    const files = graphIndexer.indexedFiles();
    return files.length > 0 ? new Set(files) : null;
  });
  /* One shared relationship snapshot feeds both the map webview (Services lens)
     and the agent's map_relationships tool, so the expensive scan runs once per
     index generation regardless of who asks. */
  const relationshipSnapshot = new RelationshipSnapshot(getGraphRoots, graphIndexer, () => readGraphConfig());
  /* Opt-in background symbol sweep (call/reference/supertype edges over the whole
     corpus). Off by default; re-pointed at the corpus after each rebuild and
     paused while the user edits. */
  const symbolIndexer = new SymbolIndexer(getGraphRoots, () => readGraphConfig().backgroundSymbols);
  graphIndexer.onDidChange(() => symbolIndexer.update(graphIndexer.corpusFiles()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => symbolIndexer.pause()),
    vscode.window.onDidChangeActiveTextEditor(() => symbolIndexer.pause()),
  );
  /* Gateway lets agent-session dispatch every graph.* op to one object: notes go
     to the durable store, map_relationships to the live index + snapshot. */
  const graphGateway = new GraphAgentGateway(graphAnnotations, graphIndexer, relationshipSnapshot, getGraphRoots, () => symbolIndexer.edges());
  context.subscriptions.push(activityBus, graphAnnotations, symbolIndexer);

  chatProvider = new ChatProvider(context, runtime, secrets, sessionStore, workspaceRoot, memory, diagnostics, planning, dataWorkbench.surface ?? undefined, dataWorkbench.manager, reference, activityBus, graphGateway);
  const baseContextProvider = new BaseContextProvider(context, workspaceRoot, baseContext);
  const planningProvider = new PlanningProvider(context, planning);
  const dataProvider = new DataProvider(context, workspaceRoot, dataWorkbench);
  const updater = new ExtensionUpdater(context, secrets);
  const graphProvider = new GraphProvider(context, getGraphRoots, graphIndexer, relationshipSnapshot, activityBus, graphAnnotations);
  graphIndexer.start();
  context.subscriptions.push(baseContextProvider, planningProvider, dataProvider, graphIndexer, graphProvider);

  // The database assistant reuses the chat provider's configured model + secrets.
  if (dataWorkbench.surface) {
    dataProvider.setAssistant(chatProvider.createDataAssistant(dataWorkbench.surface));
  }
  // The Data workbench's vector search reuses the unified embedding-model setting.
  dataProvider.setEmbedder(chatProvider.createEmbedder());

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
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("blacksite.map", graphProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Codebase Map commands ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.openMap", () => {
      void vscode.commands.executeCommand("blacksite.map.focus");
    }),
    vscode.commands.registerCommand("blacksite.rebuildMap", () => {
      graphProvider.refresh();
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

  // Attach a file to the current chat conversation — triggered from editor or explorer context menu
  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.attachFileToChat", async (uri?: vscode.Uri) => {
      await vscode.commands.executeCommand("blacksite.chat.focus");
      await chatProvider?.attachFileFromCommand(uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blacksite.checkForUpdates", async () => {
      await updater.checkForUpdates({ manual: true });
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

  setTimeout(() => {
    void updater.maybeCheckForUpdatesOnStartup();
  }, 2500);
}

export function deactivate(): void {
  chatProvider = undefined;
}
