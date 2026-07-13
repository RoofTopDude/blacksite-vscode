/* Host-side background symbol sweep (Phase 4 / W5). Drives the pure SymbolPass
   scheduler against the workspace's language servers to build call / reference /
   supertype edges across the whole corpus — the "all relationships" layer the
   lazy per-file expand_symbols flow can't provide. Opt-in
   (blacksite.graph.backgroundSymbols): runs on a small idle budget, pauses while
   the user edits, caps work per file, and swallows LSP failures. The scheduling
   logic lives in graph/symbol-pass.ts (unit-tested); this file is the thin,
   vscode-bound adapter that reads files and calls the LSP. */

import * as fs from "fs";
import * as vscode from "vscode";
import { importEdgeId, langOf, type EdgeKind, type GraphEdge } from "./graph-model.js";
import { SymbolPass, type AbortLike } from "./symbol-pass.js";
import { relationsForKind } from "./symbol-relations.js";
import { documentSymbols, flattenDocumentSymbols, outgoingCalls, references, supertypes } from "../lsp-queries.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./workspace-roots.js";

/** Wall-clock budget spent indexing per idle slice, and the gap between slices —
    small enough to stay off the main thread's back on a busy machine. */
const TICK_BUDGET_MS = 250;
const IDLE_GAP_MS = 1500;
/** How long to stand down after a user edit before resuming the sweep. */
const ACTIVITY_PAUSE_MS = 4000;
const MAX_SYMBOLS_PER_FILE = 30;
const MAX_EDGES_PER_SYMBOL = 8;

/** Languages with a good chance of a real LSP behind them. Others (json, css,
    markdown, …) are skipped — their relationships come from the import layer. */
const LSP_LANGS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "java", "kt", "kts", "scala", "sc", "dart", "cs", "rs", "rb", "php",
  "lua", "ex", "exs", "sh", "bash", "zsh", "ksh", "fish",
  "c", "h", "cpp", "hpp", "cc", "cxx",
]);

/** Map the pure relation names to the graph edge kind stored in the corpus. */
const RELATION_KIND: Record<"reference" | "call" | "extends", EdgeKind> = {
  reference: "reference",
  call: "call",
  extends: "supertype",
};

export class SymbolIndexer implements vscode.Disposable {
  private readonly _pass: SymbolPass;
  /** path → its symbol edges (kept per-file so a changed/removed file's edges
      can be replaced or dropped wholesale). */
  private readonly _edgesByFile = new Map<string, GraphEdge[]>();
  private readonly _abort: { aborted: boolean } = { aborted: false };
  private _known = new Set<string>();
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _running = false;
  private _disposed = false;
  /** Set when a tick actually changes _edgesByFile; drained (and fires onDidChange)
      once per _drain() call rather than per-file, so a tick that sweeps several
      files only triggers one graph_state re-push. */
  private _dirty = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever a sweep tick adds/replaces a file's edges — the Map's
      GraphProvider has no other signal that this background layer has new
      data, since it doesn't change the corpus shape the indexer watches. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _enabled: () => boolean,
  ) {
    this._pass = new SymbolPass(
      {
        now: () => Date.now(),
        signatureOf: (path) => this._signature(path),
        indexFile: (path) => this._indexFile(path),
        signal: this._abort as AbortLike,
      },
      { budgetMs: TICK_BUDGET_MS },
    );
  }

  /** Point the sweep at the current corpus (call after each rebuild). Off ⇒ the
      layer clears and stays dormant, so flipping the setting is free. */
  update(corpusFiles: readonly string[]): void {
    if (this._disposed) return;
    if (!this._enabled()) {
      this._reset();
      return;
    }
    this._known = new Set(corpusFiles);
    const eligible = corpusFiles.filter((path) => LSP_LANGS.has(langOf(path)));
    for (const path of this._pass.setFiles(eligible)) this._edgesByFile.delete(path);
    this._schedule(IDLE_GAP_MS);
  }

  /** Stand down briefly after user activity — never contend with a live edit. */
  pause(): void {
    this._abort.aborted = true;
    this._schedule(ACTIVITY_PAUSE_MS);
  }

  /** Every symbol edge discovered so far — the agent's call/reference/supertype
      view (empty while the feature is off). */
  edges(): GraphEdge[] {
    const out: GraphEdge[] = [];
    for (const list of this._edgesByFile.values()) out.push(...list);
    return out;
  }

  dispose(): void {
    this._disposed = true;
    this._abort.aborted = true;
    if (this._timer) clearTimeout(this._timer);
    this._onDidChange.dispose();
  }

  private _reset(): void {
    this._edgesByFile.clear();
    this._pass.setFiles([]);
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
  }

  private _schedule(delayMs: number): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
    if (this._disposed || !this._enabled() || !this._pass.hasWork()) return;
    this._timer = setTimeout(() => void this._drain(), delayMs);
  }

  private async _drain(): Promise<void> {
    if (this._running || this._disposed || !this._enabled()) return;
    this._running = true;
    this._abort.aborted = false;
    try {
      await this._pass.runTick();
    } catch {
      /* one bad tick shouldn't kill the sweep */
    } finally {
      this._running = false;
    }
    if (this._dirty) {
      this._dirty = false;
      this._onDidChange.fire();
    }
    this._schedule(IDLE_GAP_MS);
  }

  /** Cheap change signature: size + mtime. No content read, so pointing the
      sweep at a large corpus is fast; a real edit changes mtime and re-queues. */
  private _signature(path: string): string | undefined {
    const absolute = fromNodeId(this._roots(), path);
    if (!absolute) return undefined;
    try {
      const stat = fs.statSync(absolute);
      return stat.isFile() ? `${stat.size}:${Math.floor(stat.mtimeMs)}` : undefined;
    } catch {
      return undefined;
    }
  }

  private async _indexFile(path: string): Promise<boolean> {
    const roots = this._roots();
    const absolute = fromNodeId(roots, path);
    if (!absolute) return false;
    const uri = vscode.Uri.file(absolute);
    /* One warmup try only — the background sweep must not block on a cold server;
       the file simply gets retried on a later pass once the server is up. */
    const symbolOutcome = await documentSymbols(uri, { maxAttempts: 2 });
    if (symbolOutcome.status !== "ok" || symbolOutcome.value.length === 0) return false;
    const flat = flattenDocumentSymbols(symbolOutcome.value, uri).slice(0, MAX_SYMBOLS_PER_FILE);

    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const add = (kind: EdgeKind, targetUri: vscode.Uri, label?: string): boolean => {
      const to = toNodeId(roots, targetUri.fsPath);
      if (!to || to === path || !this._known.has(to)) return false;
      const key = `${kind}|${to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      edges.push({ id: `sym:${kind}:${importEdgeId(path, to)}`, from: path, to, kind, provenance: "symbol", label });
      return true;
    };

    for (const symbol of flat) {
      if (this._abort.aborted) return false; // aborted mid-file — leave its edges untouched
      const pos = symbol.selection;
      const kindName = vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? "";
      let n = 0;
      const referenceOutcome = await references(uri, pos);
      for (const loc of referenceOutcome.status === "ok" ? referenceOutcome.value : []) {
        if (add(RELATION_KIND.reference, loc.uri) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
      }
      const extras = relationsForKind(kindName);
      if (extras.includes("call")) {
        n = 0;
        const callOutcome = await outgoingCalls(uri, pos);
        for (const c of callOutcome.status === "ok" ? callOutcome.value : []) {
          if (add(RELATION_KIND.call, c.to.uri, c.to.name) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
      if (extras.includes("extends")) {
        n = 0;
        const typeOutcome = await supertypes(uri, pos);
        for (const s of typeOutcome.status === "ok" ? typeOutcome.value : []) {
          if (add(RELATION_KIND.extends, s.uri, s.name) && (n += 1) >= MAX_EDGES_PER_SYMBOL) break;
        }
      }
    }
    this._edgesByFile.set(path, edges);
    this._dirty = true;
    return true;
  }
}
