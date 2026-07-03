/* WebviewViewProvider for the Codebase Map (view id "blacksite.map").
   Modeled on planning-provider.ts: ready-handshake pushes full state, store
   events re-push, and the host stays loosely typed on incoming messages.
   Message shapes mirror src/webview/react/lib/graph/protocol.ts — keep in sync. */

import * as path from "path";
import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import { activityToTraces } from "./graph/trace-extract.js";
import type { AgentActivityBus, ToolActivity } from "./agent-activity-bus.js";

const TRACE_FLUSH_MS = 100;

interface TraceEventOut {
  id: string;
  path: string;
  kind: string;
  at: number;
  laneId?: string;
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

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _workspaceRoot: string,
    private readonly _indexer: GraphIndexer,
    activityBus?: AgentActivityBus,
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
  }

  dispose(): void {
    for (const sub of this._subscriptions) sub.dispose();
    if (this._traceFlush) clearTimeout(this._traceFlush);
  }

  /** Map a tool call to trace pulses on known map nodes, batched at 100 ms. */
  private _onActivity(activity: ToolActivity): void {
    if (activity.phase !== "start" || !this._view) return;
    const traces = activityToTraces(activity.toolName, activity.input);
    if (traces.length === 0) return;
    const config = readGraphConfig();
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return;
    const known = new Set(snapshot.nodes.map((node) => node.id));
    for (const trace of traces) {
      if (trace.kind === "shell" && !config.traceShellEvents) continue;
      /* Tool payloads may carry absolute paths — reduce to workspace-relative. */
      let rel = trace.path;
      const rootFwd = this._workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      if (rel.toLowerCase().startsWith(`${rootFwd.toLowerCase()}/`)) rel = rel.slice(rootFwd.length + 1);
      if (!known.has(rel)) continue;
      this._traceSeq += 1;
      this._traceBuffer.push({
        id: `tr_${this._traceSeq}`,
        path: rel,
        kind: trace.kind,
        at: activity.at,
        laneId: activity.laneId,
      });
    }
    if (this._traceBuffer.length > 0 && !this._traceFlush) {
      this._traceFlush = setTimeout(() => this._flushTraces(), TRACE_FLUSH_MS);
    }
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
      case "open_file": {
        const rel = String(msg.path ?? "");
        if (!rel || rel.includes("..")) return;
        const absolute = path.join(this._workspaceRoot, rel);
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
      annotations: [],
      config: readGraphConfig(),
      indexing: this._indexer.isIndexing(),
      truncated: snapshot?.truncated ?? false,
      indexedAt: snapshot?.indexedAt ?? null,
    });
  }
}
