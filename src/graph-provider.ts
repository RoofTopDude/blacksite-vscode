/* WebviewViewProvider for the Codebase Map (view id "blacksite.map").
   Modeled on planning-provider.ts: ready-handshake pushes full state, store
   events re-push, and the host stays loosely typed on incoming messages.
   Message shapes mirror src/webview/react/lib/graph/protocol.ts — keep in sync. */

import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import { activityIntent, activityToTraces, type TraceKind } from "./graph/trace-extract.js";
import { LiveActivityTracker } from "./graph/live-activity.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";
import type { AgentActivityBus, ToolActivity } from "./agent-activity-bus.js";
import type { GraphAnnotationStore } from "./graph-annotation-store.js";
import { readGraphConfig } from "./graph/config.js";
import type { RelationshipSnapshot } from "./graph/relationship-snapshot.js";
import type { StructuralSnapshot } from "./graph/structural-snapshot.js";
import { inspectLanguageSupport, type LanguageSupportStatus } from "./graph/language-support.js";
import {
  documentSymbols,
  outgoingCalls,
  references,
  relationsForKind,
  supertypes,
  symbolEdgeKey,
  withWarmup,
  type SymbolRelation,
} from "./lsp-queries.js";

export { readGraphConfig } from "./graph/config.js";

const TRACE_FLUSH_MS = 100;
/* Symbol expansion budget: language servers may be cold or absent. Each lookup
   is a full LSP query, so relations are capped per kind to keep a "trace
   relationships" click responsive. */
const MAX_SYMBOLS_PER_FILE = 32;
const MAX_REFERENCE_LOOKUPS = 12;
const MAX_CALL_LOOKUPS = 10;
const MAX_TYPE_LOOKUPS = 8;
const MAX_EDGES_PER_SYMBOL = 8;
/* Symbol kinds worth showing as orbit nodes (vscode.SymbolKind values). */
const SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Constant,
]);

interface TraceEventOut {
  id: string;
  path: string;
  kind: string;
  at: number;
  laneId?: string;
}

interface SymbolNodeOut {
  id: string;
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

interface SymbolEdgeOut {
  from: string;
  toPath: string;
  toSymbol?: string;
  relation?: SymbolRelation;
}

/** Top-level symbols plus one nested level (class members), filtered + capped. */
function flattenSymbols(symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const out: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (SYMBOL_KINDS.has(symbol.kind)) out.push(symbol);
    for (const child of symbol.children ?? []) {
      if (SYMBOL_KINDS.has(child.kind)) out.push(child);
    }
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out.slice(0, MAX_SYMBOLS_PER_FILE);
}

export class GraphProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  /** The sidebar Map and editor-tab Map share one host-side graph stream. */
  private readonly _editorPanels = new Set<vscode.WebviewPanel>();
  private readonly _subscriptions: vscode.Disposable[] = [];
  private _traceBuffer: TraceEventOut[] = [];
  private _traceFlush: ReturnType<typeof setTimeout> | undefined;
  private _traceSeq = 0;
  private readonly _live = new LiveActivityTracker();
  private _lspSupport: LanguageSupportStatus[] = [];
  private _lspInspecting = false;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexer: GraphIndexer,
    private readonly _relationships: RelationshipSnapshot,
    private readonly _structural: StructuralSnapshot,
    activityBus?: AgentActivityBus,
    private readonly _annotations?: GraphAnnotationStore,
  ) {
    this._subscriptions.push(
      this._indexer.onDidChange(() => this._postState()),
      this._indexer.onIndexingChanged((indexing) => {
        this._post({ type: "graph_indexing", indexing });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("blacksite.graph")) {
          this._post({ type: "graph_config", config: readGraphConfig() });
          void this._indexer.rebuild();
        }
      }),
    );
    if (activityBus) {
      this._subscriptions.push(activityBus.onActivity((activity) => this._onActivity(activity)));
    }
    if (this._annotations) {
      this._subscriptions.push(this._annotations.onDidChange((document) => {
        this._post({ type: "annotations_changed", annotations: document.annotations });
      }));
    }
  }

  dispose(): void {
    for (const panel of [...this._editorPanels]) panel.dispose();
    for (const sub of this._subscriptions) sub.dispose();
    if (this._traceFlush) clearTimeout(this._traceFlush);
  }

  /** Map a tool call to trace pulses on known map nodes (fading trail, batched
      at 100 ms) and to live in-flight markers (start → shows, result →
      clears), so the map reflects what the agent is doing right now as well as
      where it has been. */
  private _onActivity(activity: ToolActivity): void {
    if (!this._hasWebviewTargets()) return;
    const opKey = activity.laneId ? `${activity.laneId}:${activity.toolCallId}` : activity.toolCallId;
    if (activity.phase === "result") {
      this._live.result(opKey);
      this._postLiveActivity();
      return;
    }
    const traces = activityToTraces(activity.toolName, activity.input);
    if (traces.length === 0) return;
    const config = readGraphConfig();
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return;
    const known = new Set(snapshot.nodes.map((node) => node.id));
    const liveTargets: string[] = [];
    let liveKind: TraceKind | undefined;
    for (const trace of traces) {
      if (trace.kind === "shell" && !config.traceShellEvents) continue;
      /* Tool payloads may carry an absolute path (any open folder) or an id
         already shaped like one (single-root plain, or folder-qualified). */
      const rel = toNodeId(this._roots(), trace.path) ?? trace.path;
      if (!known.has(rel)) continue;
      this._traceSeq += 1;
      this._traceBuffer.push({
        id: `tr_${this._traceSeq}`,
        path: rel,
        kind: trace.kind,
        at: activity.at,
        laneId: activity.laneId,
      });
      liveTargets.push(rel);
      if (liveKind === undefined) liveKind = trace.kind;
    }
    if (liveTargets.length > 0 && liveKind) {
      this._live.start(opKey, liveTargets, liveKind, activity.at, activity.laneId, activityIntent(activity.toolName, activity.input));
      this._postLiveActivity();
    }
    if (this._traceBuffer.length > 0 && !this._traceFlush) {
      this._traceFlush = setTimeout(() => this._flushTraces(), TRACE_FLUSH_MS);
    }
  }

  private _postLiveActivity(): void {
    if (!this._hasWebviewTargets()) return;
    this._post({ type: "live_activity", active: this._live.snapshot(Date.now()) });
  }

  private _flushTraces(): void {
    this._traceFlush = undefined;
    if (this._traceBuffer.length === 0) return;
    const events = this._traceBuffer;
    this._traceBuffer = [];
    /* No view (hidden/never opened): drop — heat is ephemeral by design. */
    if (!this._hasWebviewTargets()) return;
    this._post({ type: "trace_batch", events });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this._configureWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
      undefined,
      this._context.subscriptions,
    );
    this._postState();
  }

  /**
   * Open the Map in VS Code's editor area. It intentionally uses a regular
   * WebviewPanel rather than replacing the activity-bar view, so users can use
   * the native split-editor controls to keep code and the live Map side by side.
   */
  openFullPage(): void {
    const existing = [...this._editorPanels][0];
    if (existing) {
      existing.reveal(existing.viewColumn, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "blacksite.map.editor",
      "Blacksite: Codebase Map",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
      },
    );
    this._editorPanels.add(panel);
    this._configureWebview(panel.webview);

    const receive = panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
    );
    panel.onDidDispose(() => {
      receive.dispose();
      this._editorPanels.delete(panel);
    });
    this._postState();
  }

  refresh(): void {
    void this._indexer.rebuild();
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "rebuild_index":
        void this._indexer.rebuild();
        break;
      case "open_full_map":
        this.openFullPage();
        break;
      case "set_neighborhoods": {
        /* Persist the territory mode as config; the config-change listener above
           re-posts the config (so the toggle reflects it) and rebuilds the map
           with the new layout. */
        const mode = String(msg.mode ?? "");
        if (mode === "auto" || mode === "on" || mode === "off") {
          try {
            await vscode.workspace.getConfiguration("blacksite.graph").update("neighborhoods", mode, vscode.ConfigurationTarget.Workspace);
          } catch {
            /* No workspace folder to persist to — mode stays at its default. */
          }
        }
        break;
      }
      case "set_background_symbols": {
        try {
          await vscode.workspace.getConfiguration("blacksite.graph").update("backgroundSymbols", msg.enabled === true, vscode.ConfigurationTarget.Workspace);
        } catch {
          /* No workspace folder to persist to — setting stays at its default. */
        }
        break;
      }
      case "remove_annotation": {
        const id = String(msg.id ?? "").trim();
        if (id) this._annotations?.remove(id);
        break;
      }
      case "expand_symbols": {
        const rel = String(msg.path ?? "");
        if (rel && !rel.includes("..")) await this._expandSymbols(rel);
        break;
      }
      case "collapse_symbols":
        /* Collapse is webview-local; nothing to do host-side. */
        break;
      case "install_extension": {
        const id = String(msg.extensionId ?? "").trim();
        /* Marketplace ids are `publisher.name`; reject anything else so a
           crafted message can't drive an arbitrary command argument. */
        if (!/^[\w-]+\.[\w-]+$/.test(id)) break;
        try {
          /* Reveal the extension so the user reads its page and clicks Install
             themselves — friendlier and safer than a silent auto-install. */
          await vscode.commands.executeCommand("extension.open", id);
        } catch {
          try {
            await vscode.commands.executeCommand("workbench.extensions.search", `@id:${id}`);
          } catch {
            void vscode.env.openExternal(
              vscode.Uri.parse(`https://marketplace.visualstudio.com/items?itemName=${id}`),
            );
          }
        }
        break;
      }
      case "open_file": {
        const rel = String(msg.path ?? "");
        const absolute = rel ? fromNodeId(this._roots(), rel) : null;
        if (!absolute) return;
        try {
          const doc = await vscode.workspace.openTextDocument(absolute);
          const line = Number(msg.line);
          const options: vscode.TextDocumentShowOptions = { preview: true };
          if (Number.isFinite(line) && line >= 0) {
            options.selection = new vscode.Range(line, 0, line, 0);
          }
          await vscode.window.showTextDocument(doc, options);
        } catch {
          vscode.window.showWarningMessage(`Blacksite: Could not open ${rel}.`);
        }
        break;
      }
    }
  }

  private async _refreshLanguageSupport(indexedFiles: readonly string[]): Promise<void> {
    if (this._lspInspecting || indexedFiles.length === 0) return;
    this._lspInspecting = true;
    try {
      const support = await inspectLanguageSupport(this._roots(), indexedFiles);
      this._lspSupport = support;
      await this._maybePromptForLsp(support);
      this._postState();
    } finally {
      this._lspInspecting = false;
    }
  }

  private async _maybePromptForLsp(support: readonly LanguageSupportStatus[]): Promise<void> {
    const candidate = support.find((item) => (item.status === "missing" || item.status === "limited") && item.recommendation);
    if (!candidate?.recommendation) return;
    const key = `blacksite.map.lspPrompt.${candidate.lang}`;
    if (this._context.workspaceState.get<boolean>(key)) return;
    const action = await vscode.window.showInformationMessage(
      `Blacksite Map can find more ${candidate.lang} relationships if the ${candidate.recommendation} language extension is installed.`,
      "Open Extensions",
      "Don't ask again",
    );
    if (action === "Don't ask again") {
      await this._context.workspaceState.update(key, true);
    } else if (action === "Open Extensions") {
      await vscode.commands.executeCommand("workbench.extensions.search", candidate.recommendation);
    }
  }

  /** Symbol layer: lazily resolve one file's symbols and the relationships each
      one has to other files — references (who uses it), calls (call hierarchy),
      and inheritance (type hierarchy) — via the shared LSP layer, then ship
      them to the webview. All queries share the agent's LSP primitives
      (lsp-queries.ts) so cold-server warmup and timeouts behave identically.
      Degrades to an error string when no language server answers. */
  private async _expandSymbols(rel: string): Promise<void> {
    const roots = this._roots();
    const absolute = fromNodeId(roots, rel);
    let symbols: SymbolNodeOut[] = [];
    const edges: SymbolEdgeOut[] = [];
    if (!absolute) {
      this._post({ type: "symbols_state", path: rel, symbols, edges, error: "Not a file on the Codebase Map." });
      return;
    }
    const uri = vscode.Uri.file(absolute);
    // Open the document so its language extension activates (onLanguage:*) before we probe —
    // a server that hasn't yet seen a file of this language won't have registered its symbol
    // provider, which otherwise reads as "no language server" for an installed-but-cold LSP.
    try { await vscode.workspace.openTextDocument(uri); } catch { /* unreadable — the query below comes back empty */ }
    const raw = await withWarmup(() => documentSymbols(uri), (r) => !r || r.length === 0);
    if (raw === undefined) {
      this._post({ type: "symbols_state", path: rel, symbols, edges, error: "No language server answered for this file (it may be starting up, or none is installed for this language)." });
      return;
    }
    const flat = flattenSymbols((raw as vscode.DocumentSymbol[]) ?? []);
    symbols = flat.map((symbol) => ({
      id: `${rel}#${symbol.name}@${symbol.selectionRange.start.line}`,
      path: rel,
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? "symbol",
      startLine: symbol.selectionRange.start.line,
      endLine: symbol.range.end.line,
    }));

    const known = new Set(this._indexer.snapshot()?.nodes.map((node) => node.id) ?? []);
    const seen = new Set<string>();
    const addEdge = (fromId: string, targetUri: vscode.Uri, relation: SymbolRelation, toSymbol?: string): boolean => {
      const toPath = toNodeId(roots, targetUri.fsPath);
      if (!toPath || toPath === rel || !known.has(toPath)) return false;
      const key = symbolEdgeKey(fromId, toPath, relation, toSymbol);
      if (seen.has(key)) return false;
      seen.add(key);
      edges.push({ from: fromId, toPath, toSymbol, relation });
      return true;
    };

    /* Each relation kind is budgeted separately so one query family can't
       starve another, and a hub file's "trace" stays snappy. */
    let refLookups = 0;
    let callLookups = 0;
    let typeLookups = 0;
    for (let i = 0; i < flat.length; i += 1) {
      const symbol = flat[i];
      const meta = symbols[i];
      if (!symbol || !meta) continue;
      const pos = symbol.selectionRange.start;
      const extras = relationsForKind(meta.kind);

      if (refLookups < MAX_REFERENCE_LOOKUPS) {
        refLookups += 1;
        let n = 0;
        for (const loc of await references(uri, pos)) {
          if (addEdge(meta.id, loc.uri, "reference") && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
      if (extras.includes("call") && callLookups < MAX_CALL_LOOKUPS) {
        callLookups += 1;
        let n = 0;
        for (const c of await outgoingCalls(uri, pos)) {
          if (addEdge(meta.id, c.to.uri, "call", c.to.name) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
      if (extras.includes("extends") && typeLookups < MAX_TYPE_LOOKUPS) {
        typeLookups += 1;
        let n = 0;
        for (const s of await supertypes(uri, pos)) {
          if (addEdge(meta.id, s.uri, "extends", s.name) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
    }
    this._post({ type: "symbols_state", path: rel, symbols, edges });
  }

  private _post(message: Record<string, unknown>): void {
    if (this._view) void this._view.webview.postMessage(message);
    for (const panel of this._editorPanels) {
      void panel.webview.postMessage(message);
    }
  }

  private _postState(): void {
    if (!this._hasWebviewTargets()) return;
    const snapshot = this._indexer.snapshot();
    const config = readGraphConfig();
    const indexedFiles = this._indexer.indexedFiles();
    const relationship = this._relationships.get();
    const structural = this._structural.get();
    void this._refreshLanguageSupport(indexedFiles);
    this._post({
      type: "graph_state",
      nodes: snapshot?.nodes ?? [],
      edges: snapshot?.edges ?? [],
      relationshipEdges: relationship.edges,
      annotations: this._annotations?.read().annotations ?? [],
      config,
      indexing: this._indexer.isIndexing(),
      truncated: (snapshot?.truncated ?? false) || relationship.truncated,
      indexedTruncated: snapshot?.indexedTruncated ?? false,
      renderedTruncated: snapshot?.renderedTruncated ?? false,
      relationshipTruncated: relationship.truncated,
      indexedFileCount: snapshot?.indexedFileCount ?? indexedFiles.length,
      renderedNodeCount: snapshot?.renderedNodeCount ?? snapshot?.nodes.length ?? 0,
      relationshipEdgeCount: relationship.edges.length,
      lspSupport: this._lspSupport,
      indexedAt: snapshot?.indexedAt ?? null,
      cyclicNeighborhoodPairs: structural.cyclicNeighborhoodPairs,
      orphanNodeIds: structural.orphanNodeIds,
      pocketNodeIds: structural.pocketNodeIds,
      bridgeEdgeIds: structural.bridgeEdgeIds,
    });
    this._postLiveActivity();
  }

  private _hasWebviewTargets(): boolean {
    return Boolean(this._view) || this._editorPanels.size > 0;
  }

  private _configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webview.html = renderWebviewHtml(webview, this._context.extensionUri, "graph.js");
  }
}
