/* WebviewViewProvider for the Codebase Map (view id "blacksite.map").
   Modeled on planning-provider.ts: ready-handshake pushes full state, store
   events re-push, and the host stays loosely typed on incoming messages.
   Message shapes mirror src/webview/react/lib/graph/protocol.ts — keep in sync. */

import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import type { GraphEdge } from "./graph/graph-model.js";
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
/** Playback requests are a bounded projection, never a request for a complete
    retained run. Hand-mirrored by MAX_RUN_PLAYBACK_WINDOW_MS in the webview. */
const MAX_RUN_PLAYBACK_WINDOW_MS = 5 * 60 * 1000;
const MAX_RUN_PLAYBACK_EVENTS = 2000;
const MAX_RUN_PLAYBACK_SUMMARIES = 100;
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

export interface MapRunSummary {
  id: string;
  title: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
}

export interface MapRunEvent {
  id: string;
  path: string;
  kind: string;
  /** Milliseconds elapsed from the run's monotonic event origin. */
  at: number;
  laneId?: string;
}

/** Structural adapter over the canonical run store. Keeping this seam small
    lets GraphProvider remain independent of run persistence/composition and
    keeps existing construction sites source-compatible. */
export interface RunPlaybackProvider {
  listRunSummaries(limit: number): readonly MapRunSummary[] | Promise<readonly MapRunSummary[]>;
  /** Random-access window in run-relative elapsed milliseconds. */
  getMapEventWindow(
    runId: string,
    fromElapsedMs: number,
    toElapsedMs: number,
    limit: number,
  ): readonly MapRunEvent[] | Promise<readonly MapRunEvent[]>;
}

const MAP_RUN_KINDS = new Set([
  "read", "write", "edit", "execute", "diagnostic", "render", "shell", "nav",
]);

function normalizeMapRunKind(kind: string): string | null {
  const normalized = ({
    edited: "edit",
    executed: "execute",
    diagnosed: "diagnostic",
    rendered: "render",
    written: "write",
  } as Record<string, string>)[kind] ?? kind;
  return MAP_RUN_KINDS.has(normalized) ? normalized : null;
}

function summaryRange(summary: MapRunSummary): { from: number; to: number } {
  const started = summary.startedAt ? Date.parse(summary.startedAt) : Number.NaN;
  const ended = summary.endedAt ? Date.parse(summary.endedAt) : Number.NaN;
  if (Number.isFinite(started) && Number.isFinite(ended)) {
    return { from: 0, to: Math.max(0, ended - started) };
  }
  return { from: 0, to: 0 };
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
  /** Scoped to one resolved view, not to the extension — see resolveWebviewView. */
  private readonly _viewSubscriptions: vscode.Disposable[] = [];
  private _traceBuffer: TraceEventOut[] = [];
  private _traceFlush: ReturnType<typeof setTimeout> | undefined;
  private _traceSeq = 0;
  private readonly _live = new LiveActivityTracker();
  private _lspSupport: LanguageSupportStatus[] = [];
  private _lspInspecting = false;
  /** Wired by extension.ts to NotesTimelineProvider.open() — avoids a
      construction-order cycle between the two providers. */
  private _openNotesTimeline: (() => void) | null = null;
  /** Focus target queued while no Map webview is resolved yet (revealNote can
      race the sidebar view's first resolve); flushed on the next state post. */
  private _pendingFocusPath: string | null = null;
  /** Set after construction to avoid a TicketStore construction-order cycle. */
  private _fileTicket?: (input: Record<string, unknown>) => void;
  private _runSummaries: MapRunSummary[] = [];
  private _selectedRunId: string | null = null;
  private _selectedRunCursor: number | null = null;
  private _runWindowRequestSeq = 0;
  private _runSummaryRefreshSeq = 0;
  private _runSelectionSeq = 0;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexer: GraphIndexer,
    private readonly _relationships: RelationshipSnapshot,
    private readonly _structural: StructuralSnapshot,
    activityBus?: AgentActivityBus,
    private readonly _annotations?: GraphAnnotationStore,
    /** Background LSP symbol sweep's call/reference/supertype edges (SymbolIndexer.edges) —
        the one Map layer whose richness actually depends on which language servers are
        installed. Optional so tests/hosts without the sweep can omit it. */
    private readonly _symbolEdges?: () => GraphEdge[],
    /** Open-ticket weight per file, for the ticket heat lens. Optional — the Map is fully
        functional without a ticket queue, and the lens simply reports nothing to show. */
    private readonly _ticketState?: () => {
      weights: Record<string, number>;
      openCount: number;
      tickets: Array<{ id: string; title: string; status: "triage" | "backlog" | "in_progress" | "blocked" | "review" | "done" | "cancelled"; priority: "urgent" | "high" | "normal" | "low"; files: string[]; blockedBy: string[] }>;
    },
    /** Optional structural run-store adapter. Existing hosts/tests may omit it;
        the Map then remains entirely live and shows no run selector. */
    private readonly _runPlayback?: RunPlaybackProvider,
  ) {
    this._subscriptions.push(
      this._indexer.onDidChange(() => this._postState()),
      this._relationships.onDidChange(() => this._postState()),
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
    this._disposeViewSubscriptions();
    this._view = undefined;
    if (this._traceFlush) clearTimeout(this._traceFlush);
  }

  private _disposeViewSubscriptions(): void {
    for (const subscription of this._viewSubscriptions.splice(0)) subscription.dispose();
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
    // This view does not set retainContextWhenHidden, so VS Code disposes it on hide and calls
    // back here on show. Registering into context.subscriptions would strand one dead listener
    // — and the dead webview it holds — per hide/show cycle. The Map's webview is the most
    // expensive one this extension creates, which makes it the worst one to retain.
    this._disposeViewSubscriptions();
    this._view = webviewView;
    this._configureWebview(webviewView.webview);
    this._viewSubscriptions.push(
      webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => void this._onMessage(msg)),
      // Resync on every reveal: the indexer/relationships/annotations stores can change while
      // this view is gone, and those pushes went nowhere.
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._postState();
          void this._postRunPlaybackState();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) this._view = undefined;
      }),
    );
    this._postState();
    void this._postRunPlaybackState();
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
    const viewState = panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this._postState();
        void this._postRunPlaybackState();
      }
    });
    panel.onDidDispose(() => {
      receive.dispose();
      viewState.dispose();
      this._editorPanels.delete(panel);
    });
    this._postState();
    void this._postRunPlaybackState();
  }

  refresh(): void {
    void this._indexer.rebuild();
  }

  setNotesTimelineOpener(open: () => void): void {
    this._openNotesTimeline = open;
  }

  setTicketFiler(file: (input: Record<string, unknown>) => void): void {
    this._fileTicket = file;
  }

  /** Bring a Map surface forward and fly its camera to a file's star ("Show on
      map" from the Notes timeline). If no webview is live yet, the target is
      queued and flushed right after the view resolves and receives state. */
  revealNote(nodeId: string): void {
    const path = nodeId.trim();
    if (!path) return;
    const editorPanel = [...this._editorPanels][0];
    if (editorPanel) editorPanel.reveal(editorPanel.viewColumn, true);
    else void vscode.commands.executeCommand("blacksite.map.focus");
    if (this._hasWebviewTargets()) {
      this._post({ type: "focus_node", path });
    } else {
      this._pendingFocusPath = path;
    }
  }

  /** Re-push graph_state after the background symbol sweep (SymbolIndexer) adds
      edges for another file — the sweep has no corpus-shape change to trigger the
      indexer's own onDidChange, so it needs its own nudge. */
  notifySymbolEdgesChanged(): void {
    this._postState();
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        await this._postRunPlaybackState();
        break;
      case "select_run": {
        if (!this._runPlayback) break;
        const selectionGeneration = ++this._runSelectionSeq;
        await this._refreshRunSummaries();
        if (selectionGeneration !== this._runSelectionSeq) break;
        const runId = String(msg.runId ?? "");
        const summary = this._runSummaries.find((item) => item.id === runId);
        if (!summary) {
          this._selectedRunId = null;
          this._selectedRunCursor = null;
          this._runWindowRequestSeq += 1;
          this._postCurrentRunPlaybackState();
          break;
        }
        const range = summaryRange(summary);
        this._selectedRunId = runId;
        this._selectedRunCursor = range.from;
        this._runWindowRequestSeq += 1;
        this._postCurrentRunPlaybackState();
        break;
      }
      case "seek_run": {
        if (!this._runPlayback || !this._selectedRunId) break;
        const runId = String(msg.runId ?? "");
        if (runId !== this._selectedRunId) break;
        const cursorValue = msg.cursor && typeof msg.cursor === "object"
          ? Number((msg.cursor as Record<string, unknown>).at)
          : Number(msg.cursor ?? msg.cursorAt);
        if (!Number.isFinite(cursorValue)) break;
        const summary = this._runSummaries.find((item) => item.id === runId);
        if (!summary) break;
        const range = summaryRange(summary);
        this._selectedRunCursor = Math.max(range.from, Math.min(range.to, cursorValue));
        this._postCurrentRunPlaybackState();
        break;
      }
      case "request_run_window": {
        if (!this._runPlayback || !this._selectedRunId) break;
        const runId = String(msg.runId ?? "");
        if (runId !== this._selectedRunId) break;
        const rawFrom = Number(msg.from);
        const rawTo = Number(msg.to);
        if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) break;
        const from = Math.max(0, Math.min(rawFrom, rawTo));
        let to = Math.max(from, rawFrom, rawTo);
        if (to - from > MAX_RUN_PLAYBACK_WINDOW_MS) to = from + MAX_RUN_PLAYBACK_WINDOW_MS;
        const requestId = Number(msg.requestId);
        const echoedRequestId = Number.isSafeInteger(requestId) && requestId >= 0 ? requestId : undefined;
        const generation = ++this._runWindowRequestSeq;
        let rawEvents: readonly MapRunEvent[] = [];
        try {
          rawEvents = await this._runPlayback.getMapEventWindow(runId, from, to, MAX_RUN_PLAYBACK_EVENTS);
        } catch {
          /* A retained run can disappear between summary listing and window
             lookup. Return an empty bounded window instead of disturbing live
             graph state or surfacing a host exception into the webview. */
        }
        if (
          generation !== this._runWindowRequestSeq
          || this._selectedRunId !== runId
        ) {
          break;
        }
        const events: MapRunEvent[] = [];
        for (const event of rawEvents) {
          if (events.length >= MAX_RUN_PLAYBACK_EVENTS) break;
          const id = typeof event.id === "string" ? event.id : "";
          const path = typeof event.path === "string" ? event.path : "";
          const at = Number(event.at);
          const kind = normalizeMapRunKind(String(event.kind ?? ""));
          if (!id || !path || !kind || !Number.isFinite(at) || at < from || at > to) continue;
          const laneId = typeof event.laneId === "string" && event.laneId ? event.laneId : undefined;
          events.push({ id, path, kind, at, ...(laneId ? { laneId } : {}) });
        }
        events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        this._post({
          type: "run_event_window",
          runId,
          from,
          to,
          events,
          ...(echoedRequestId !== undefined ? { requestId: echoedRequestId } : {}),
        });
        break;
      }
      case "exit_run_playback":
        this._runSelectionSeq += 1;
        this._selectedRunId = null;
        this._selectedRunCursor = null;
        this._runWindowRequestSeq += 1;
        this._postCurrentRunPlaybackState();
        break;
      case "rebuild_index":
        void this._indexer.rebuild();
        break;
      case "open_full_map":
        this.openFullPage();
        break;
      case "open_notes_timeline":
        this._openNotesTimeline?.();
        break;
      case "open_tickets":
        void vscode.commands.executeCommand("blacksite.tickets.focus");
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
      case "make_ticket_from_note": {
        const id = String(msg.id ?? "").trim();
        const note = this._annotations?.read().annotations.find((entry) => entry.id === id);
        /* Todo/risk notes explicitly describe unfinished work. Other note kinds
           remain knowledge rather than becoming an accidental backlog button. */
        if (!note || (note.category !== "todo" && note.category !== "risk")) break;
        this._fileTicket?.({
          title: note.title || note.note.slice(0, 120),
          description: note.title ? note.note : undefined,
          files: [note.from, ...(note.to ? [note.to] : [])],
          priority: note.category === "risk" ? "high" : "normal",
          origin: "map_note",
          originRef: note.id,
          status: "backlog",
        });
        void vscode.commands.executeCommand("blacksite.tickets.focus");
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
    const symbolOutcome = await documentSymbols(uri);
    if (symbolOutcome.status !== "ok") {
      this._post({ type: "symbols_state", path: rel, symbols, edges, error: `Language server ${symbolOutcome.status} while reading symbols.` });
      return;
    }
    const flat = flattenSymbols(symbolOutcome.value as vscode.DocumentSymbol[]);
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
        const outcome = await references(uri, pos);
        for (const loc of outcome.status === "ok" ? outcome.value : []) {
          if (addEdge(meta.id, loc.uri, "reference") && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
      if (extras.includes("call") && callLookups < MAX_CALL_LOOKUPS) {
        callLookups += 1;
        let n = 0;
        const outcome = await outgoingCalls(uri, pos);
        for (const c of outcome.status === "ok" ? outcome.value : []) {
          if (addEdge(meta.id, c.to.uri, "call", c.to.name) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
      if (extras.includes("extends") && typeLookups < MAX_TYPE_LOOKUPS) {
        typeLookups += 1;
        let n = 0;
        const outcome = await supertypes(uri, pos);
        for (const s of outcome.status === "ok" ? outcome.value : []) {
          if (addEdge(meta.id, s.uri, "extends", s.name) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
    }
    this._post({ type: "symbols_state", path: rel, symbols, edges });
  }

  /** Called by run composition when retained summaries change. No-op when the
      optional playback provider is absent. */
  notifyRunsChanged(): void {
    void this._postRunPlaybackState();
  }

  private async _refreshRunSummaries(): Promise<void> {
    const provider = this._runPlayback;
    if (!provider) {
      this._runSummaries = [];
      return;
    }
    const generation = ++this._runSummaryRefreshSeq;
    let raw: readonly MapRunSummary[];
    try {
      raw = await provider.listRunSummaries(MAX_RUN_PLAYBACK_SUMMARIES);
    } catch {
      return;
    }
    if (generation !== this._runSummaryRefreshSeq) return;
    const summaries: MapRunSummary[] = [];
    const seen = new Set<string>();
    for (const item of raw.slice(0, MAX_RUN_PLAYBACK_SUMMARIES)) {
      const id = typeof item.id === "string" ? item.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = typeof item.title === "string" && item.title.trim() ? item.title : id;
      const status = typeof item.status === "string" && item.status.trim() ? item.status : "unknown";
      const startedAt = typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt))
        ? item.startedAt
        : undefined;
      const endedAt = typeof item.endedAt === "string" && Number.isFinite(Date.parse(item.endedAt))
        ? item.endedAt
        : undefined;
      const eventCount = Number(item.eventCount);
      summaries.push({
        id,
        title,
        status,
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(Number.isSafeInteger(eventCount) && eventCount >= 0 ? { eventCount } : {}),
      });
    }
    summaries.sort((a, b) => {
      const aAt = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bAt = b.startedAt ? Date.parse(b.startedAt) : 0;
      return bAt - aAt || a.id.localeCompare(b.id);
    });
    this._runSummaries = summaries;
    if (this._selectedRunId && !summaries.some((item) => item.id === this._selectedRunId)) {
      this._selectedRunId = null;
      this._selectedRunCursor = null;
      this._runWindowRequestSeq += 1;
    }
  }

  /** Bring the Map forward in retained-run playback mode at a run-relative cursor. */
  async revealRun(runId: string, elapsedMs = 0): Promise<void> {
    if (!this._runPlayback || !runId.trim()) return;
    const editorPanel = [...this._editorPanels][0];
    if (editorPanel) editorPanel.reveal(editorPanel.viewColumn, true);
    else void vscode.commands.executeCommand("blacksite.map.focus");
    const selectionGeneration = ++this._runSelectionSeq;
    await this._refreshRunSummaries();
    if (selectionGeneration !== this._runSelectionSeq) return;
    const summary = this._runSummaries.find((item) => item.id === runId);
    if (!summary) return;
    const range = summaryRange(summary);
    this._selectedRunId = runId;
    this._selectedRunCursor = Math.max(range.from, Math.min(range.to, elapsedMs));
    this._runWindowRequestSeq += 1;
    this._postCurrentRunPlaybackState();
  }

  private async _postRunPlaybackState(): Promise<void> {
    await this._refreshRunSummaries();
    this._postCurrentRunPlaybackState();
  }

  private _postCurrentRunPlaybackState(): void {
    const summary = this._selectedRunId
      ? this._runSummaries.find((item) => item.id === this._selectedRunId)
      : undefined;
    if (!summary || this._selectedRunCursor === null) {
      this._post({
        type: "run_playback_state",
        state: { mode: "live", summaries: this._runSummaries },
      });
      return;
    }
    const range = summaryRange(summary);
    this._selectedRunCursor = Math.max(range.from, Math.min(range.to, this._selectedRunCursor));
    this._post({
      type: "run_playback_state",
      state: {
        mode: "playback",
        summaries: this._runSummaries,
        selectedRunId: summary.id,
        cursor: { at: this._selectedRunCursor },
        range,
      },
    });
  }

  private _post(message: Record<string, unknown>): void {
    if (this._view) void this._view.webview.postMessage(message);
    for (const panel of this._editorPanels) {
      void panel.webview.postMessage(message);
    }
  }

  /** Push ticket weights to every Map surface. Called on ticket mutations by extension.ts,
   *  and alongside each full state post so a freshly-resolved webview starts correct. */
  notifyTicketsChanged(): void {
    const payload = this._ticketState?.();
    if (!payload) return;
    this._post({ type: "tickets_state", weights: payload.weights, openCount: payload.openCount, tickets: payload.tickets });
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
      symbolEdges: this._symbolEdges?.() ?? [],
      annotations: this._annotations?.read().annotations ?? [],
      config,
      indexing: this._indexer.isIndexing(),
      truncated: (snapshot?.truncated ?? false) || relationship.truncated,
      indexedTruncated: snapshot?.indexedTruncated ?? false,
      renderedTruncated: snapshot?.renderedTruncated ?? false,
      relationshipTruncated: relationship.truncated,
      relationshipIndexing: relationship.indexing,
      indexedFileCount: snapshot?.indexedFileCount ?? indexedFiles.length,
      renderedNodeCount: snapshot?.renderedNodeCount ?? snapshot?.nodes.length ?? 0,
      relationshipEdgeCount: relationship.edges.length,
      relationshipTotalEdgeCount: relationship.totalEdgeCount,
      indexedImportEdgeCount: snapshot?.indexedImportEdgeCount ?? snapshot?.edges.length ?? 0,
      renderedImportEdgeCount: snapshot?.renderedImportEdgeCount ?? snapshot?.edges.length ?? 0,
      lspSupport: this._lspSupport,
      indexedAt: snapshot?.indexedAt ?? null,
      cyclicNeighborhoodPairs: structural.cyclicNeighborhoodPairs,
      orphanNodeIds: structural.orphanNodeIds,
      pocketNodeIds: structural.pocketNodeIds,
      bridgeEdgeIds: structural.bridgeEdgeIds,
    });
    this._postLiveActivity();
    this.notifyTicketsChanged();
    if (this._pendingFocusPath) {
      this._post({ type: "focus_node", path: this._pendingFocusPath });
      this._pendingFocusPath = null;
    }
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
