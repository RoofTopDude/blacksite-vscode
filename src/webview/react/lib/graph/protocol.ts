/* Message contract between GraphProvider (src/graph-provider.ts) and the Map
   webview. Hand-mirrored per repo convention: the host types incoming messages
   loosely and coerces; this union is the single source of truth for shapes.
   Keep in sync with src/graph-provider.ts. */

export interface GraphNode {
  id: string;
  dir: string;
  lang: string;
  sizeBytes: number;
  inDegree: number;
  outDegree: number;
  x: number;
  y: number;
  z: number;
  /** Set to "cluster" for a synthetic folder super-node (a collapsed cluster);
      absent/"file" for a real workspace file. Never sent by the host — derived
      in the webview by deriveDisplayGraph when a cluster is collapsed. */
  kind?: "file" | "cluster";
  /** Number of files a collapsed cluster super-node stands in for. */
  fileCount?: number;
  /** Commits in the recent git window touching this file (git heat layer);
      a collapsed cluster super-node carries the sum across its members. */
  churn?: number;
  /** Epoch seconds of the most recent commit; a super-node carries the max. */
  lastCommitAt?: number;
}

export type EdgeKind = "import" | "ai" | "user";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  author?: "agent" | "user";
  note?: string;
  createdAt?: string;
  sessionId?: string;
}

export interface GraphAnnotation {
  id: string;
  from: string;
  to: string;
  kind: "ai" | "user";
  author: "agent" | "user";
  note: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
}

export type TraceKind = "read" | "write" | "edit" | "shell" | "nav";

export interface TraceEvent {
  id: string;
  path: string;
  kind: TraceKind;
  /** Host receipt time (Date.now()) — agent events carry no wall clock. */
  at: number;
  laneId?: string;
}

/** A node the agent is operating on *right now* (between tool start and
    result), for the live layer — distinct from the fading TraceEvent trail. */
export interface LiveActivity {
  path: string;
  kind: TraceKind;
  at: number;
}

/* Symbol layer (toggleable; fetched lazily per file via LSP). */
export interface SymbolNode {
  /** `${filePath}#${name}@${startLine}` */
  id: string;
  path: string;
  name: string;
  /** vscode.SymbolKind name, lowercased (e.g. "function", "class"). */
  kind: string;
  startLine: number;
  endLine: number;
}

export interface SymbolEdge {
  from: string; // symbol id
  /** Target: symbol id when resolvable, else a file path the symbol references. */
  toPath: string;
  toSymbol?: string;
}

export interface GraphConfig {
  traceFadeSeconds: number;
  maxNodes: number;
  traceShellEvents: boolean;
}

export type GraphHostMessage =
  | {
      type: "graph_state";
      nodes: GraphNode[];
      edges: GraphEdge[];
      annotations: GraphAnnotation[];
      config: GraphConfig;
      indexing: boolean;
      truncated: boolean;
      indexedAt: string | null;
    }
  | { type: "graph_indexing"; indexing: boolean }
  | { type: "annotations_changed"; annotations: GraphAnnotation[] }
  | { type: "trace_batch"; events: TraceEvent[] }
  | { type: "live_activity"; active: LiveActivity[] }
  | { type: "graph_config"; config: GraphConfig }
  | { type: "symbols_state"; path: string; symbols: SymbolNode[]; edges: SymbolEdge[]; error?: string };

export type GraphWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "rebuild_index" }
  | { type: "open_file"; path: string; line?: number }
  | { type: "remove_annotation"; id: string }
  | { type: "expand_symbols"; path: string }
  | { type: "collapse_symbols"; path: string };

export function isGraphHostMessage(value: unknown): value is GraphHostMessage {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
