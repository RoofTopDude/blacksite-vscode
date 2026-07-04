/* WebviewViewProvider for the Codebase Map (view id "blacksite.map").
   Modeled on planning-provider.ts: ready-handshake pushes full state, store
   events re-push, and the host stays loosely typed on incoming messages.
   Message shapes mirror src/webview/react/lib/graph/protocol.ts — keep in sync. */

import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import { activityToTraces, type TraceKind } from "./graph/trace-extract.js";
import { LiveActivityTracker } from "./graph/live-activity.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";
import type { AgentActivityBus, ToolActivity } from "./agent-activity-bus.js";
import type { GraphAnnotationStore } from "./graph-annotation-store.js";

const TRACE_FLUSH_MS = 100;
/* Symbol expansion budget: language servers may be cold or absent. */
const SYMBOLS_TIMEOUT_MS = 6000;
const MAX_SYMBOLS_PER_FILE = 32;
const MAX_REFERENCE_LOOKUPS = 12;
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
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Language server timed out.")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
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

interface GraphConfig {
  traceFadeSeconds: number;
  maxNodes: number;
  traceShellEvents: boolean;
}

export function readGraphConfig(): GraphConfig {
  const cfg = vscode.workspace.getConfiguration("blacksite.graph");
  const clamp = (value: number, min: number, max: number, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  return {
    traceFadeSeconds: clamp(cfg.get<number>("traceFadeSeconds", 45), 2, 3600, 45),
    maxNodes: clamp(cfg.get<number>("maxNodes", 4000), 100, 20000, 4000),
    traceShellEvents: cfg.get<boolean>("traceShellEvents", true),
  };
}

export class GraphProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private _traceBuffer: TraceEventOut[] = [];
  private _traceFlush: ReturnType<typeof setTimeout> | undefined;
  private _traceSeq = 0;
  private readonly _live = new LiveActivityTracker();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexer: GraphIndexer,
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
    for (const sub of this._subscriptions) sub.dispose();
    if (this._traceFlush) clearTimeout(this._traceFlush);
  }

  /** Map a tool call to trace pulses on known map nodes (fading trail, batched
      at 100 ms) and to live in-flight markers (start → shows, result →
      clears), so the map reflects what the agent is doing right now as well as
      where it has been. */
  private _onActivity(activity: ToolActivity): void {
    if (!this._view) return;
    if (activity.phase === "result") {
      this._live.result(activity.toolCallId);
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
      this._live.start(activity.toolCallId, liveTargets, liveKind, activity.at);
      this._postLiveActivity();
    }
    if (this._traceBuffer.length > 0 && !this._traceFlush) {
      this._traceFlush = setTimeout(() => this._flushTraces(), TRACE_FLUSH_MS);
    }
  }

  private _postLiveActivity(): void {
    if (!this._view) return;
    this._post({ type: "live_activity", active: this._live.snapshot(Date.now()) });
  }

  private _flushTraces(): void {
    this._traceFlush = undefined;
    if (this._traceBuffer.length === 0) return;
    const events = this._traceBuffer;
    this._traceBuffer = [];
    /* No view (hidden/never opened): drop — heat is ephemeral by design. */
    if (!this._view) return;
    this._post({ type: "trace_batch", events });
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
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "graph.js");
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
      undefined,
      this._context.subscriptions,
    );
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

  /** Symbol layer: lazily resolve one file's symbols + reference edges via the
      language server and ship them to the webview. Degrades to an error string
      when no language server is warm for the file. */
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
    try {
      const raw = await withTimeout(
        vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>("vscode.executeDocumentSymbolProvider", uri),
        SYMBOLS_TIMEOUT_MS,
      );
      const flat = flattenSymbols(raw ?? []);
      symbols = flat.map((symbol) => ({
        id: `${rel}#${symbol.name}@${symbol.selectionRange.start.line}`,
        path: rel,
        name: symbol.name,
        kind: vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? "symbol",
        startLine: symbol.selectionRange.start.line,
        endLine: symbol.range.end.line,
      }));

      /* Reference edges: which other map files use each symbol. Capped hard —
         each lookup is a full language-server query. */
      const known = new Set(this._indexer.snapshot()?.nodes.map((node) => node.id) ?? []);
      for (let i = 0; i < Math.min(flat.length, MAX_REFERENCE_LOOKUPS); i += 1) {
        const symbol = flat[i];
        const meta = symbols[i];
        if (!symbol || !meta) continue;
        let locations: vscode.Location[] = [];
        try {
          locations = (await withTimeout(
            vscode.commands.executeCommand<vscode.Location[] | undefined>(
              "vscode.executeReferenceProvider",
              uri,
              symbol.selectionRange.start,
            ),
            SYMBOLS_TIMEOUT_MS,
          )) ?? [];
        } catch {
          continue; /* per-symbol failure is fine — keep the rest */
        }
        const seen = new Set<string>();
        for (const location of locations) {
          const locRel = toNodeId(roots, location.uri.fsPath);
          if (!locRel || locRel === rel || seen.has(locRel) || !known.has(locRel)) continue;
          seen.add(locRel);
          edges.push({ from: meta.id, toPath: locRel });
          if (seen.size >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
      this._post({ type: "symbols_state", path: rel, symbols, edges });
    } catch (err) {
      this._post({
        type: "symbols_state",
        path: rel,
        symbols,
        edges,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _post(message: Record<string, unknown>): void {
    if (!this._view) return;
    void this._view.webview.postMessage(message);
  }

  private _postState(): void {
    if (!this._view) return;
    const snapshot = this._indexer.snapshot();
    this._post({
      type: "graph_state",
      nodes: snapshot?.nodes ?? [],
      edges: snapshot?.edges ?? [],
      annotations: this._annotations?.read().annotations ?? [],
      config: readGraphConfig(),
      indexing: this._indexer.isIndexing(),
      truncated: snapshot?.truncated ?? false,
      indexedAt: snapshot?.indexedAt ?? null,
    });
    this._postLiveActivity();
  }
}
