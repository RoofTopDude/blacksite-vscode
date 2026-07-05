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
  kind?: "file" | "cluster" | "service";
  /** Number of files a collapsed cluster super-node stands in for. */
  fileCount?: number;
  /** Commits in the recent git window touching this file (git heat layer);
      a collapsed cluster super-node carries the sum across its members. */
  churn?: number;
  /** Epoch seconds of the most recent commit; a super-node carries the max. */
  lastCommitAt?: number;
}

export type EdgeKind = "import" | "ai" | "user" | "api" | "event" | "data" | "config";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  author?: "agent" | "user";
  note?: string;
  createdAt?: string;
  sessionId?: string;
  sourcePath?: string;
  targetPath?: string;
  serviceFrom?: string;
  serviceTo?: string;
  label?: string;
  detail?: string;
  confidence?: number;
  evidence?: string[];
}

/** A prior note's text, displaced by a map_note_update merge — bounded trail
    kept so the map can show "revised N×" without unbounded growth. */
export interface GraphAnnotationRevision {
  note: string;
  sessionId?: string;
  updatedAt: string;
}

export interface GraphAnnotation {
  id: string;
  /** "edge" links two files (`to` present); "node" is a single-file note.
      Absent = "edge" (schema v1 back-compat — every v1 row has both from/to). */
  scope?: "edge" | "node";
  from: string;
  /** Required when scope is "edge"; absent for node-scoped notes. */
  to?: string;
  kind: "ai" | "user";
  author: "agent" | "user";
  note: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  /** Prior note text, most recent first, capped at 5 — see GraphAnnotationRevision. */
  history?: GraphAnnotationRevision[];
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
  /** Present when this in-flight tool call belongs to a delegated subagent lane. */
  laneId?: string;
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

export type SymbolRelation = "reference" | "call" | "implements" | "extends";

export interface SymbolEdge {
  from: string; // symbol id
  /** Target: symbol id when resolvable, else a file path the symbol references. */
  toPath: string;
  toSymbol?: string;
  /** How `from` relates to the target. Absent = "reference" (back-compat).
      "call" = from calls into the target; "extends"/"implements" = inheritance. */
  relation?: SymbolRelation;
}

export interface GraphConfig {
  traceFadeSeconds: number;
  maxNodes?: number;
  performanceProfile?: "safe" | "balanced" | "large" | "extreme" | "custom";
  maxIndexedFiles?: number;
  maxRenderedStars?: number;
  maxRelationshipEdges?: number;
  traceShellEvents: boolean;
}

export interface LanguageSupportStatus {
  lang: string;
  fileCount: number;
  status: "available" | "limited" | "missing" | "unknown";
  recommendation?: string;
  detail: string;
}

export type GraphHostMessage =
  | {
      type: "graph_state";
      nodes: GraphNode[];
      edges: GraphEdge[];
      relationshipEdges?: GraphEdge[];
      annotations: GraphAnnotation[];
      config: GraphConfig;
      indexing: boolean;
      truncated: boolean;
      indexedTruncated?: boolean;
      renderedTruncated?: boolean;
      relationshipTruncated?: boolean;
      indexedFileCount?: number;
      renderedNodeCount?: number;
      relationshipEdgeCount?: number;
      lspSupport?: LanguageSupportStatus[];
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
  | { type: "collapse_symbols"; path: string }
  /** Reveal a language-server extension in the Extensions view so the user can
      install it with one click (from the LSP onboarding panel). */
  | { type: "install_extension"; extensionId: string };

export function isGraphHostMessage(value: unknown): value is GraphHostMessage {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
