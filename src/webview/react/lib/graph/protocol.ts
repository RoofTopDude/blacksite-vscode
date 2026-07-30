/* Message contract between GraphProvider (src/graph-provider.ts) and the Map
   webview. Hand-mirrored per repo convention: the host types incoming messages
   loosely and coerces; this union is the single source of truth for shapes.
   Keep in sync with src/graph-provider.ts. */

export interface GraphNode {
  id: string;
  dir: string;
  /** Codebase-territory key (a project/solution/workspace root, else a top path
      segment). Present only when the host laid the map out as neighborhoods;
      drives territory hulls/labels. Absent on a flat layout. */
  neighborhood?: string;
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
  kind?: "file" | "cluster" | "service" | "ticket";
  /** Number of files a collapsed cluster super-node stands in for. */
  fileCount?: number;
  /** Commits in the recent git window touching this file (git heat layer);
      a collapsed cluster super-node carries the sum across its members. */
  churn?: number;
  /** Epoch seconds of the most recent commit; a super-node carries the max. */
  lastCommitAt?: number;
  /** Work-lens metadata. Present only on synthetic ticket nodes. */
  ticketId?: string;
  ticketTitle?: string;
  ticketStatus?: TicketStatus;
  ticketPriority?: TicketPriority;
}

/** The intentionally small, resolved ticket shape the host sends to the Map. */
export interface MapTicket {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  files: string[];
  blockedBy: string[];
}

export type TicketStatus = "triage" | "backlog" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type TicketPriority = "urgent" | "high" | "normal" | "low";

export type EdgeKind =
  | "import" | "ai" | "user" | "api" | "event" | "data" | "config"
  /* Symbol-layer edges (background LSP sweep): who calls whom, who references a
     file's symbols, and type inheritance. Mirrors graph/graph-model.ts. */
  | "call" | "reference" | "supertype"
  /** Work lens: territory, explicit blockers, and derived overlap. */
  | "ticket_scope" | "ticket_blocked" | "ticket_overlap";

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
  /** Zero-based evidence locations, suitable for the VS Code open_file bridge. */
  sourceLine?: number;
  targetLine?: number;
  serviceFrom?: string;
  serviceTo?: string;
  label?: string;
  detail?: string;
  confidence?: number;
  evidence?: string[];
  occurrenceCount?: number;
  sourceOccurrenceCount?: number;
  targetOccurrenceCount?: number;
  ambiguityGroup?: string;
  ambiguousCandidateCount?: number;
}

/** A prior note's text, displaced by a map_note_update merge — bounded trail
    kept so the map can show "revised N×" without unbounded growth. */
export interface GraphAnnotationRevision {
  note: string;
  sessionId?: string;
  updatedAt: string;
}

/** What kind of insight a note records — lets the agent classify *why* it's
    worth keeping, not just what it says. Mirrors graph-annotation-store.ts. */
export const NOTE_CATEGORIES = ["architecture", "gotcha", "todo", "risk", "question"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

/** What kind of relationship an edge-scoped note is about, when the file pair
    carries more than one (e.g. both an import and an event flow). Purely
    descriptive — not a foreign key into a specific GraphEdge.id. */
export const RELATION_KINDS = [
  "import", "api", "event", "data", "config", "call", "reference", "inheritance", "other",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

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
  /** Short scannable heading, shown above the note body. */
  title?: string;
  /** What kind of insight this is — see NOTE_CATEGORIES. */
  category?: NoteCategory;
  /** Which relationship this edge-scoped note is about — see RELATION_KINDS.
      Only meaningful when scope is "edge". */
  relationKind?: RelationKind;
  note: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  /** Prior note text, most recent first, capped at 5 — see GraphAnnotationRevision. */
  history?: GraphAnnotationRevision[];
}

export type TraceKind =
  | "read"
  | "write"
  | "edit"
  | "execute"
  | "diagnostic"
  | "render"
  | "shell"
  | "nav";

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
  /** Short "intent" detail (shell command, git op, batch size) — what the file
      name alone doesn't convey. Rendered as a dimmed suffix on the live chip. */
  detail?: string;
}

/** Compact retained-run metadata for the Map's run selector. The canonical
    run record remains host-side; the Map only needs enough data to identify a
    run and establish a scrub range. */
export interface MapRunSummary {
  id: string;
  title: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
}

/** File activity projected from a retained Execution Run. `path` is the raw
    Codebase Map file id assigned by the host; the webview must not rewrite it
    or lane identity would be detached from the canonical event. */
export interface MapRunEvent {
  id: string;
  path: string;
  kind: TraceKind;
  /** Milliseconds elapsed from the run's monotonic start. */
  at: number;
  laneId?: string;
}

export interface MapRunCursor {
  /** Selected run-relative elapsed clock in milliseconds (same as MapRunEvent.at). */
  at: number;
}

export interface RunPlaybackState {
  mode: "live" | "playback";
  summaries: MapRunSummary[];
  selectedRunId?: string;
  cursor?: MapRunCursor;
  /** Inclusive time range exposed by the selected run's summary. */
  range?: { from: number; to: number };
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
  /** Neighborhood-territory layout mode; "auto" unless the user overrode it. */
  neighborhoods?: "auto" | "on" | "off";
  /** Opt-in background LSP symbol sweep (call/reference/supertype edges over the
      whole corpus). Off by default; surfaced in the "Light up more relationships"
      onboarding panel once a working language server is detected. */
  backgroundSymbols?: boolean;
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
      /** Background LSP symbol sweep's call/reference/supertype edges — merged
          into the file-lens edge set on arrival (see applyMessage). */
      symbolEdges?: GraphEdge[];
      annotations: GraphAnnotation[];
      config: GraphConfig;
      indexing: boolean;
      truncated: boolean;
      indexedTruncated?: boolean;
      renderedTruncated?: boolean;
      relationshipTruncated?: boolean;
      relationshipIndexing?: boolean;
      indexedFileCount?: number;
      renderedNodeCount?: number;
      relationshipEdgeCount?: number;
      relationshipTotalEdgeCount?: number;
      indexedImportEdgeCount?: number;
      renderedImportEdgeCount?: number;
      lspSupport?: LanguageSupportStatus[];
      indexedAt: string | null;
      /** Neighborhood-root pairs that participate in a cross-project reference
          cycle (dropped when the whole cycle collapses to one neighborhood). */
      cyclicNeighborhoodPairs?: [string, string][];
      /** File ids with no import connection to their neighborhood's main body. */
      orphanNodeIds?: string[];
      /** File ids in a single-access "pocket" subgraph hanging off one bridge edge. */
      pocketNodeIds?: string[];
      /** Edge ids that are the sole connection into a pocket subgraph. */
      bridgeEdgeIds?: string[];
    }
  | { type: "graph_indexing"; indexing: boolean }
  | { type: "annotations_changed"; annotations: GraphAnnotation[] }
  /** Open-ticket weight per file id — priority-weighted, resolved on the host from each
      ticket's declared files and areas so the webview never has to expand an area itself. */
  | { type: "tickets_state"; weights: Record<string, number>; openCount: number; tickets?: MapTicket[] }
  | { type: "trace_batch"; events: TraceEvent[] }
  | { type: "live_activity"; active: LiveActivity[] }
  | { type: "run_playback_state"; state: RunPlaybackState }
  | {
      type: "run_event_window";
      runId: string;
      from: number;
      to: number;
      events: MapRunEvent[];
      /** Echoed by the host so rapid scrub requests cannot apply out of order. */
      requestId?: number;
    }
  | { type: "run_playback_summary"; summary: MapRunSummary }
  | { type: "graph_config"; config: GraphConfig }
  | { type: "symbols_state"; path: string; symbols: SymbolNode[]; edges: SymbolEdge[]; error?: string }
  /** Host-initiated navigation: fly the camera to (and select) this file's
      star — e.g. "Show on map" from the Notes timeline tab. */
  | { type: "focus_node"; path: string };

export type GraphWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "rebuild_index" }
  /** Open the same live Map surface in an editor tab, where VS Code's native
      split-editor controls can place it beside source files. */
  | { type: "open_full_map" }
  /** Open the Map Notes timeline in an editor tab (scrollable note history
      with revision trails and per-file git history). */
  | { type: "open_notes_timeline" }
  | { type: "open_tickets" }
  /** Set the neighborhood-territory layout mode; the host persists it and
      rebuilds the map. */
  | { type: "set_neighborhoods"; mode: "auto" | "on" | "off" }
  | { type: "open_file"; path: string; line?: number }
  | { type: "remove_annotation"; id: string }
  | { type: "make_ticket_from_note"; id: string }
  | { type: "expand_symbols"; path: string }
  | { type: "collapse_symbols"; path: string }
  | { type: "select_run"; runId: string }
  | { type: "seek_run"; runId: string; cursor: MapRunCursor }
  | { type: "request_run_window"; runId: string; from: number; to: number; requestId?: number }
  | { type: "exit_run_playback" }
  /** Reveal a language-server extension in the Extensions view so the user can
      install it with one click (from the LSP onboarding panel). */
  | { type: "install_extension"; extensionId: string }
  /** Persist blacksite.graph.backgroundSymbols (from the LSP onboarding panel).
      The host's generic blacksite.graph.* config listener reposts graph_config
      and rebuilds, exactly like set_neighborhoods. */
  | { type: "set_background_symbols"; enabled: boolean };

export function isGraphHostMessage(value: unknown): value is GraphHostMessage {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
