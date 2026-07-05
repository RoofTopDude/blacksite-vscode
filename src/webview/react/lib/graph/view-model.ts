/* Pure view-model reducer for the Map webview. Applies every GraphHostMessage
   and derives search/selection/neighbor state. The React store wraps this; the
   pixi renderer reads the produced state. No DOM, no bridge — vitest-safe. */

import type {
  GraphAnnotation,
  GraphConfig,
  GraphEdge,
  GraphHostMessage,
  GraphNode,
  LiveActivity,
  SymbolEdge,
  SymbolNode,
  SymbolRelation,
  TraceEvent,
  LanguageSupportStatus,
} from "./protocol";
import { pruneTraces } from "./traces";
import { edgeArcMidpoint } from "./edges";

export interface SymbolExpansion {
  symbols: SymbolNode[];
  edges: SymbolEdge[];
  error?: string;
}

export type EdgeMode = "all" | "selected" | "clusters" | "off";

export interface GraphDisplayOptions {
  lens: "files" | "services";
  edgeMode: EdgeMode;
  showImports: boolean;
  showApi: boolean;
  showEvents: boolean;
  showData: boolean;
  showConfig: boolean;
  showAnnotations: boolean;
  showRelations: boolean;
  showEdgeLabels: boolean;
  /** When on, the camera gently follows the file the agent is working on. */
  followAgent: boolean;
  /** Git heat lens: tint stars by commit recency (warm = recent) and grow them
      by churn (commit count). Off by default — it's a distinct analytical view. */
  showGitHeat: boolean;
}

export const DEFAULT_DISPLAY_OPTIONS: GraphDisplayOptions = {
  lens: "files",
  edgeMode: "all",
  showImports: true,
  showApi: true,
  showEvents: true,
  showData: true,
  showConfig: true,
  showAnnotations: true,
  showRelations: true,
  showEdgeLabels: true,
  followAgent: false,
  showGitHeat: false,
};

/** Non-destructive focus filter. All-zero/empty = inactive (everything shown).
    Filtered-out stars are ghosted, not removed, so the map keeps its shape. */
export interface GraphFilter {
  /** Active language buckets (node.lang); empty = every language. */
  langs: string[];
  /** Hide files below this total degree (in+out); 0 = off. Declutters to hubs. */
  minDegree: number;
  /** With a selection, show only nodes within this many hops of it; 0 = off. */
  isolateDepth: number;
}

export const DEFAULT_FILTER: GraphFilter = { langs: [], minDegree: 0, isolateDepth: 0 };

export function filterIsActive(filter: GraphFilter, hasSelection: boolean): boolean {
  return filter.langs.length > 0 || filter.minDegree > 0 || (filter.isolateDepth > 0 && hasSelection);
}

/** Node ids within `depth` hops of `rootId` across imports + annotations
    (undirected), including the root. */
export function nodesWithinHops(
  rootId: string,
  edges: readonly GraphEdge[],
  annotations: readonly GraphAnnotation[],
  depth: number,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    (adjacency.get(a) ?? adjacency.set(a, []).get(a)!).push(b);
    (adjacency.get(b) ?? adjacency.set(b, []).get(b)!).push(a);
  };
  for (const edge of edges) if (edge.kind === "import") link(edge.from, edge.to);
  for (const a of annotations) if (a.to) link(a.from, a.to);

  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Ids that pass the active filter (base lang/degree, then optional isolate
    intersection). Returns null when nothing is active — the renderer's
    fast-path meaning "everything visible". Cluster super-nodes always pass the
    lang/degree gates (they aggregate mixed files); the current selection is
    always kept visible so its card never dangles over a hidden star. */
export function visibleNodeIds(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  annotations: readonly GraphAnnotation[],
  filter: GraphFilter,
  selectedId: string | null,
): Set<string> | null {
  if (!filterIsActive(filter, Boolean(selectedId))) return null;
  const langSet = new Set(filter.langs);
  const passesBase = (node: GraphNode): boolean => {
    if (node.kind === "cluster") return true;
    if (langSet.size > 0 && !langSet.has(node.lang)) return false;
    if (filter.minDegree > 0 && node.inDegree + node.outDegree < filter.minDegree) return false;
    return true;
  };
  let ids = new Set<string>();
  for (const node of nodes) if (passesBase(node)) ids.add(node.id);
  if (filter.isolateDepth > 0 && selectedId) {
    const near = nodesWithinHops(selectedId, edges, annotations, filter.isolateDepth);
    ids = new Set([...ids].filter((id) => near.has(id)));
  }
  if (selectedId) ids.add(selectedId);
  return ids;
}

/** Languages present in the file set, most-common first, for the filter chips. */
export function languageCounts(nodes: readonly GraphNode[]): Array<{ lang: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === "cluster" || !node.lang) continue;
    counts.set(node.lang, (counts.get(node.lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => ({ lang, count }));
}

export interface PositionedSymbol {
  symbol: SymbolNode;
  parent: GraphNode;
  x: number;
  y: number;
}

export interface GraphViewState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  relationshipEdges: GraphEdge[];
  annotations: GraphAnnotation[];
  config: GraphConfig;
  indexing: boolean;
  truncated: boolean;
  indexedTruncated: boolean;
  renderedTruncated: boolean;
  relationshipTruncated: boolean;
  indexedFileCount: number;
  renderedNodeCount: number;
  relationshipEdgeCount: number;
  lspSupport: LanguageSupportStatus[];
  indexedAt: string | null;
  traces: TraceEvent[];
  /** Nodes the agent is operating on right now (in-flight tool calls). */
  liveActivity: LiveActivity[];
  /** Symbol layer: expansions keyed by file path (present = expanded). */
  symbolsByPath: Record<string, SymbolExpansion>;
  symbolsEnabled: boolean;
  display: GraphDisplayOptions;
  filter: GraphFilter;
  search: string;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  /** Cluster dirs currently collapsed into a single super-node. Empty = every
      file shown individually (the default, full file-to-file view). */
  collapsedClusters: string[];
  /** What the renderer + overlays actually draw: file nodes for expanded
      clusters, one super-node per collapsed cluster. Equal (by reference) to
      `nodes`/`edges` when nothing is collapsed, so the renderer skips a rebuild
      in the common case. Derived — never sent by the host. */
  displayNodes: GraphNode[];
  displayEdges: GraphEdge[];
}

export const DEFAULT_CONFIG: GraphConfig = {
  traceFadeSeconds: 45,
  performanceProfile: "balanced",
  maxIndexedFiles: 12000,
  maxRenderedStars: 4000,
  maxRelationshipEdges: 5000,
  traceShellEvents: true,
};

export function initialState(): GraphViewState {
  return {
    nodes: [],
    edges: [],
    relationshipEdges: [],
    annotations: [],
    config: DEFAULT_CONFIG,
    indexing: false,
    truncated: false,
    indexedTruncated: false,
    renderedTruncated: false,
    relationshipTruncated: false,
    indexedFileCount: 0,
    renderedNodeCount: 0,
    relationshipEdgeCount: 0,
    lspSupport: [],
    indexedAt: null,
    traces: [],
    liveActivity: [],
    symbolsByPath: {},
    symbolsEnabled: false,
    display: DEFAULT_DISPLAY_OPTIONS,
    filter: DEFAULT_FILTER,
    search: "",
    selectedNodeId: null,
    hoveredNodeId: null,
    collapsedClusters: [],
    displayNodes: [],
    displayEdges: [],
  };
}

/** Id of the synthetic super-node that stands in for a collapsed cluster dir.
    The `▤` prefix can't begin a real workspace-relative path, so it never
    collides with a file id. */
const CLUSTER_ID_PREFIX = "▤";
export function clusterNodeId(dir: string): string {
  return CLUSTER_ID_PREFIX + dir;
}
export function isClusterNode(node: Pick<GraphNode, "kind">): boolean {
  return node.kind === "cluster";
}
export function isClusterNodeId(id: string): boolean {
  return id.startsWith(CLUSTER_ID_PREFIX);
}

/** Build the graph the map actually draws from the raw file graph + the set of
    collapsed cluster dirs. Each collapsed cluster becomes one super-node at its
    members' centroid; every import edge is remapped onto whichever endpoint is
    visible (file or super-node), self-loops within a collapsed cluster are
    dropped, and parallel edges are merged. Pure — the empty-collapse case
    returns the inputs untouched (same references) so the renderer can cheaply
    detect "nothing changed". */
export function deriveDisplayGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  collapsedClusters: readonly string[],
  display: GraphDisplayOptions = DEFAULT_DISPLAY_OPTIONS,
): { displayNodes: GraphNode[]; displayEdges: GraphEdge[] } {
  if (display.lens === "services") return deriveServiceGraph(nodes, edges, display);
  const collapsed = new Set(collapsedClusters);
  if (collapsed.size === 0) return { displayNodes: nodes, displayEdges: edges };

  const dirById = new Map<string, string>();
  const agg = new Map<string, { sx: number; sy: number; size: number; count: number; churn: number; lastAt: number }>();
  const displayNodes: GraphNode[] = [];
  for (const node of nodes) {
    dirById.set(node.id, node.dir);
    if (!collapsed.has(node.dir)) {
      displayNodes.push(node);
      continue;
    }
    const entry = agg.get(node.dir) ?? { sx: 0, sy: 0, size: 0, count: 0, churn: 0, lastAt: 0 };
    entry.sx += node.x;
    entry.sy += node.y;
    entry.size += node.sizeBytes;
    entry.count += 1;
    entry.churn += node.churn ?? 0;
    if ((node.lastCommitAt ?? 0) > entry.lastAt) entry.lastAt = node.lastCommitAt ?? 0;
    agg.set(node.dir, entry);
  }
  for (const [dir, entry] of agg) {
    /* Bounded degree so a huge folder's super-node reads as a big star without
       blowing past graphNodeRadius's own cap. */
    const boundedDeg = Math.min(80, entry.count);
    displayNodes.push({
      id: clusterNodeId(dir),
      dir,
      lang: "",
      sizeBytes: entry.size,
      inDegree: boundedDeg,
      outDegree: boundedDeg,
      x: entry.sx / entry.count,
      y: entry.sy / entry.count,
      z: 1,
      kind: "cluster",
      fileCount: entry.count,
      churn: entry.churn || undefined,
      lastCommitAt: entry.lastAt || undefined,
    });
  }

  /* Remap every import edge onto the visible endpoints and merge duplicates. */
  const mapEndpoint = (id: string): string => {
    const dir = dirById.get(id);
    return dir !== undefined && collapsed.has(dir) ? clusterNodeId(dir) : id;
  };
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const from = mapEndpoint(edge.from);
    const to = mapEndpoint(edge.to);
    if (from === to) continue; /* wholly inside one collapsed cluster */
    const key = `${from}->${to}`;
    if (!merged.has(key)) merged.set(key, { id: `imp:${key}`, from, to, kind: "import" });
  }
  return { displayNodes, displayEdges: [...merged.values()] };
}

function relationshipVisible(edge: GraphEdge, display: GraphDisplayOptions): boolean {
  if (edge.kind === "api") return display.showApi;
  if (edge.kind === "event") return display.showEvents;
  if (edge.kind === "data") return display.showData;
  if (edge.kind === "config") return display.showConfig;
  return false;
}

/** Compact a service-only relationship graph without losing the file-derived
    geography entirely: each service stays anchored to the centroid of its
    files, but repeated/high-confidence links iteratively pull peers closer.
    This keeps relationship-only topologies from spanning the whole canvas just
    because the underlying codebases happen to live far apart in the file map. */
function relaxServicePositions(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  if (nodes.length <= 1 || edges.length === 0) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y, anchorX: node.x, anchorY: node.y }]));
  const weights = new Map<string, number>();
  for (const edge of edges) {
    const a = edge.from < edge.to ? edge.from : edge.to;
    const b = edge.from < edge.to ? edge.to : edge.from;
    const key = `${a}\u0000${b}`;
    weights.set(key, (weights.get(key) ?? 0) + 1 + Math.max(0, edge.confidence ?? 0.55));
  }
  const neighbors = new Map<string, Array<{ id: string; weight: number }>>();
  for (const [key, weight] of weights) {
    const [a, b] = key.split("\u0000");
    const aList = neighbors.get(a) ?? [];
    aList.push({ id: b, weight });
    neighbors.set(a, aList);
    const bList = neighbors.get(b) ?? [];
    bList.push({ id: a, weight });
    neighbors.set(b, bList);
  }

  const ANCHOR_WEIGHT = 3;
  const ITERATIONS = 12;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const next = new Map<string, { x: number; y: number; anchorX: number; anchorY: number }>();
    for (const node of nodes) {
      const current = byId.get(node.id)!;
      const linked = neighbors.get(node.id) ?? [];
      if (linked.length === 0) {
        next.set(node.id, current);
        continue;
      }
      let sumX = current.anchorX * ANCHOR_WEIGHT;
      let sumY = current.anchorY * ANCHOR_WEIGHT;
      let total = ANCHOR_WEIGHT;
      for (const neighbor of linked) {
        const peer = byId.get(neighbor.id);
        if (!peer) continue;
        sumX += peer.x * neighbor.weight;
        sumY += peer.y * neighbor.weight;
        total += neighbor.weight;
      }
      next.set(node.id, {
        ...current,
        x: sumX / total,
        y: sumY / total,
      });
    }
    for (const [id, value] of next) byId.set(id, value);
  }
  return nodes.map((node) => {
    const pos = byId.get(node.id);
    return pos ? { ...node, x: pos.x, y: pos.y } : node;
  });
}

function deriveServiceGraph(nodes: GraphNode[], relationshipEdges: GraphEdge[], display: GraphDisplayOptions): { displayNodes: GraphNode[]; displayEdges: GraphEdge[] } {
  const visibleEdges = relationshipEdges.filter((edge) => relationshipVisible(edge, display) && edge.serviceFrom && edge.serviceTo);
  const byService = new Map<string, GraphNode>();
  const sourceNodesByService = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    for (const edge of visibleEdges) {
      for (const service of [edge.serviceFrom, edge.serviceTo]) {
        if (service && (node.id === service || node.id.startsWith(`${service}/`))) {
          const list = sourceNodesByService.get(service) ?? [];
          list.push(node);
          sourceNodesByService.set(service, list);
        }
      }
    }
  }
  const ensure = (service: string): GraphNode => {
    const existing = byService.get(service);
    if (existing) return existing;
    const source = sourceNodesByService.get(service) ?? [];
    const x = source.length ? source.reduce((sum, node) => sum + node.x, 0) / source.length : Math.cos(byService.size * 2.399) * 360;
    const y = source.length ? source.reduce((sum, node) => sum + node.y, 0) / source.length : Math.sin(byService.size * 2.399) * 260;
    const node: GraphNode = {
      id: `svc:${service}`,
      dir: service,
      lang: "service",
      sizeBytes: source.reduce((sum, item) => sum + item.sizeBytes, 0),
      inDegree: 0,
      outDegree: 0,
      x,
      y,
      z: 1,
      kind: "service",
      fileCount: source.length,
    };
    byService.set(service, node);
    return node;
  };
  const edges = visibleEdges.map((edge, index) => {
    const from = ensure(edge.serviceFrom!);
    const to = ensure(edge.serviceTo!);
    from.outDegree += 1;
    to.inDegree += 1;
    return { ...edge, id: edge.id || `rel:${from.id}->${to.id}:${index}`, from: from.id, to: to.id };
  });
  return { displayNodes: relaxServicePositions([...byService.values()], edges), displayEdges: edges };
}

/** Refresh displayNodes/displayEdges after nodes/edges/collapse change. */
export function withDisplayGraph(state: GraphViewState): GraphViewState {
  const sourceEdges = state.display.lens === "services" ? state.relationshipEdges : state.edges;
  const { displayNodes, displayEdges } = deriveDisplayGraph(state.nodes, sourceEdges, state.collapsedClusters, state.display);
  return { ...state, displayNodes, displayEdges };
}

/** Toggle whether a cluster dir is collapsed; expanding drops any stale dirs. */
export function setClusterCollapsed(state: GraphViewState, dir: string, collapsed: boolean): GraphViewState {
  const has = state.collapsedClusters.includes(dir);
  if (collapsed === has) return state;
  const collapsedClusters = collapsed
    ? [...state.collapsedClusters, dir]
    : state.collapsedClusters.filter((d) => d !== dir);
  return withDisplayGraph({ ...state, collapsedClusters });
}

/** Collapse every cluster present in the current file graph. */
export function collapseAllClusters(state: GraphViewState): GraphViewState {
  const dirs = [...new Set(state.nodes.map((node) => node.dir))];
  return withDisplayGraph({ ...state, collapsedClusters: dirs });
}

/** Expand everything back to the full file-to-file view. */
export function expandAllClusters(state: GraphViewState): GraphViewState {
  if (state.collapsedClusters.length === 0) return state;
  return withDisplayGraph({ ...state, collapsedClusters: [] });
}

/** Edge-scoped annotations render as edges alongside imports; single-file
    notes have no second endpoint and are excluded (see annotationsForNode). */
export function annotationEdges(annotations: readonly GraphAnnotation[]): GraphEdge[] {
  return annotations
    .filter((a) => Boolean(a.to))
    .map((a) => ({
      id: a.id,
      from: a.from,
      to: a.to!,
      kind: a.kind,
      author: a.author,
      note: a.note,
      createdAt: a.createdAt,
      sessionId: a.sessionId,
    }));
}

export function applyMessage(state: GraphViewState, msg: GraphHostMessage, now: number): GraphViewState {
  switch (msg.type) {
    case "graph_state": {
      const validIds = new Set(msg.nodes.map((node) => node.id));
      const symbolsByPath = Object.fromEntries(
        Object.entries(state.symbolsByPath).filter(([path]) => validIds.has(path)),
      );
      /* Keep only collapsed dirs that still exist in the new file set — a
         re-index (or workspace swap) can retire folders out from under us. */
      const liveDirs = new Set(msg.nodes.map((node) => node.dir));
      const collapsedClusters = state.collapsedClusters.filter((dir) => liveDirs.has(dir));
      /* A selection/hover on a collapsed cluster's super-node has no file id in
         validIds; keep it as long as its cluster is still collapsed. */
      const stillValid = (id: string | null): boolean =>
        Boolean(id) && (validIds.has(id!) || (isClusterNodeId(id!) && collapsedClusters.includes(id!.slice(1))));
      return withDisplayGraph({
        ...state,
        nodes: msg.nodes,
        edges: msg.edges,
        relationshipEdges: msg.relationshipEdges ?? [],
        annotations: msg.annotations,
        config: msg.config,
        indexing: msg.indexing,
        truncated: msg.truncated,
        indexedTruncated: msg.indexedTruncated === true,
        renderedTruncated: msg.renderedTruncated === true,
        relationshipTruncated: msg.relationshipTruncated === true,
        indexedFileCount: msg.indexedFileCount ?? msg.nodes.length,
        renderedNodeCount: msg.renderedNodeCount ?? msg.nodes.length,
        relationshipEdgeCount: msg.relationshipEdgeCount ?? msg.relationshipEdges?.length ?? 0,
        lspSupport: msg.lspSupport ?? [],
        indexedAt: msg.indexedAt,
        symbolsByPath,
        collapsedClusters,
        selectedNodeId: stillValid(state.selectedNodeId) ? state.selectedNodeId : null,
        hoveredNodeId: stillValid(state.hoveredNodeId) ? state.hoveredNodeId : null,
      });
    }
    case "graph_indexing":
      return { ...state, indexing: msg.indexing };
    case "annotations_changed":
      return { ...state, annotations: msg.annotations };
    case "trace_batch": {
      const fadeMs = state.config.traceFadeSeconds * 1000;
      const merged = [...state.traces, ...msg.events];
      return { ...state, traces: pruneTraces(merged, now, fadeMs) };
    }
    case "live_activity":
      return { ...state, liveActivity: msg.active };
    case "graph_config":
      return { ...state, config: msg.config };
    case "symbols_state":
      return {
        ...state,
        symbolsByPath: {
          ...state.symbolsByPath,
          [msg.path]: { symbols: msg.symbols, edges: msg.edges, error: msg.error },
        },
      };
    default:
      return state;
  }
}

export function collapseSymbols(state: GraphViewState, path: string): GraphViewState {
  if (!(path in state.symbolsByPath)) return state;
  const next = { ...state.symbolsByPath };
  delete next[path];
  return { ...state, symbolsByPath: next };
}

/** Shorten a cluster key for the small overlay label: adaptive clustering
    (assignClusters on the host) can produce deep keys like
    "packages/frontend/src/components" for an oversized top-level package —
    show just the last two segments with a leading ellipsis so the label
    stays readable; the full key is still available as a title/tooltip. */
export function shortClusterLabel(dir: string): string {
  if (dir === ".") return ".";
  const segments = dir.split("/");
  return segments.length <= 2 ? dir : `…/${segments.slice(-2).join("/")}`;
}

/** Present-continuous verb for a live activity kind, for the status chip. */
export function traceKindVerb(kind: TraceEvent["kind"]): string {
  switch (kind) {
    case "read": return "Reading";
    case "write": return "Writing";
    case "edit": return "Editing";
    case "shell": return "Running in";
    case "nav": return "Inspecting";
    default: return "Working on";
  }
}

/** Short verb for a symbol-relation edge label (e.g. "calls", "used by"). */
export function symbolRelationVerb(relation: SymbolRelation): string {
  switch (relation) {
    case "call": return "calls";
    case "implements": return "implements";
    case "extends": return "extends";
    case "reference":
    default: return "used by";
  }
}

/** Final path segment for compact display (e.g. "a/b/c.ts" → "c.ts"). */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Case-insensitive substring match on path; empty query matches everything. */
export function matchesSearch(node: GraphNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return node.id.toLowerCase().includes(q);
}

export function searchMatches(nodes: readonly GraphNode[], query: string, limit = 50): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (node.id.toLowerCase().includes(q)) {
      out.push(node);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Node ids adjacent to `nodeId` across imports and annotations. */
export function neighborIds(nodeId: string, edges: readonly GraphEdge[], annotations: readonly GraphAnnotation[]): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    if (edge.from === nodeId) out.add(edge.to);
    else if (edge.to === nodeId) out.add(edge.from);
  }
  for (const a of annotations) {
    if (!a.to) continue; // single-file notes don't imply a neighbor
    if (a.from === nodeId) out.add(a.to);
    else if (a.to === nodeId) out.add(a.from);
  }
  return out;
}

/** Annotations touching a node (for the NodeCard). */
export function annotationsForNode(nodeId: string, annotations: readonly GraphAnnotation[]): GraphAnnotation[] {
  return annotations.filter((a) => a.from === nodeId || a.to === nodeId);
}

export interface EdgeLabel {
  id: string;
  from: string;
  to: string;
  x: number;
  y: number;
  label: string;
  detail: string;
  kind: "import" | "annotation" | "relation" | "service";
}

export function selectedEdgeLabels(
  selectedNodeId: string | null,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  annotations: readonly GraphAnnotation[],
  symbolsByPath: Readonly<Record<string, SymbolExpansion>>,
  display: GraphDisplayOptions = DEFAULT_DISPLAY_OPTIONS,
  limit = 12,
): EdgeLabel[] {
  if (!selectedNodeId || !display.showEdgeLabels) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = byId.get(selectedNodeId);
  if (!selected) return [];
  const out: EdgeLabel[] = [];
  const add = (id: string, fromId: string, toId: string, label: string, detail: string, kind: EdgeLabel["kind"]) => {
    if (out.length >= limit) return;
    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (!from || !to) return;
    /* Import and service edges render as arcs (see lib/graph/edges); their
       labels ride the arc midpoint so they sit on the curve. Straight
       relationships keep the chord midpoint. */
    const mid = kind === "import" || kind === "service" ? edgeArcMidpoint(from, to) : { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    out.push({
      id,
      from: fromId,
      to: toId,
      x: mid.x,
      y: mid.y,
      label,
      detail,
      kind,
    });
  };
  if (display.showImports) {
    for (const edge of edges) {
      if (edge.kind !== "import") continue;
      if (edge.from === selectedNodeId) add(edge.id, edge.from, edge.to, "imports", edge.to, "import");
      else if (edge.to === selectedNodeId) add(edge.id, edge.from, edge.to, "imported by", edge.from, "import");
    }
  }
  if (display.lens === "services") {
    for (const edge of edges) {
      if (!relationshipVisible(edge, display)) continue;
      const peer = edge.from === selectedNodeId ? edge.serviceTo ?? edge.to : edge.serviceFrom ?? edge.from;
      const direction = edge.from === selectedNodeId ? "calls" : "called by";
      if (edge.from === selectedNodeId || edge.to === selectedNodeId) {
        add(edge.id, edge.from, edge.to, edge.label ?? edge.kind, `${direction} ${peer.replace(/^svc:/, "")}`, "service");
      }
    }
  }
  if (display.showAnnotations) {
    for (const annotation of annotations) {
      if (!annotation.to) continue; // single-file notes have no second endpoint to label an edge with
      if (annotation.from === selectedNodeId) add(annotation.id, annotation.from, annotation.to, "note", annotation.note, "annotation");
      else if (annotation.to === selectedNodeId) add(annotation.id, annotation.from, annotation.to, "note", annotation.note, "annotation");
    }
  }
  if (display.showRelations) {
    const expansion = symbolsByPath[selectedNodeId];
    const symbols = new Map((expansion?.symbols ?? []).map((symbol) => [symbol.id, symbol]));
    for (const edge of expansion?.edges ?? []) {
      const symbol = symbols.get(edge.from);
      const relation = edge.relation ?? "reference";
      const label = `${symbol?.name ?? "symbol"} ${symbolRelationVerb(relation)}`;
      add(`rel:${edge.from}->${relation}->${edge.toPath}`, selectedNodeId, edge.toPath, label, edge.toSymbol ?? edge.toPath, "relation");
    }
  }
  return out;
}

export interface ClusterEdge {
  id: string;
  fromDir: string;
  toDir: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  count: number;
}

export function clusterEdges(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): ClusterEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const clusters = new Map<string, { sx: number; sy: number; count: number }>();
  for (const node of nodes) {
    const cluster = clusters.get(node.dir) ?? { sx: 0, sy: 0, count: 0 };
    cluster.sx += node.x;
    cluster.sy += node.y;
    cluster.count += 1;
    clusters.set(node.dir, cluster);
  }
  const grouped = new Map<string, { fromDir: string; toDir: string; count: number }>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to || from.dir === to.dir) continue;
    const key = `${from.dir}->${to.dir}`;
    const entry = grouped.get(key) ?? { fromDir: from.dir, toDir: to.dir, count: 0 };
    entry.count += 1;
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((edge) => {
    const from = clusters.get(edge.fromDir)!;
    const to = clusters.get(edge.toDir)!;
    return {
      id: `cluster:${edge.fromDir}->${edge.toDir}`,
      fromDir: edge.fromDir,
      toDir: edge.toDir,
      fromX: from.sx / from.count,
      fromY: from.sy / from.count,
      toX: to.sx / to.count,
      toY: to.sy / to.count,
      count: edge.count,
    };
  });
}

export function graphNodeRadius(node: { inDegree: number; outDegree: number }): number {
  return 2.5 + Math.min(9, Math.sqrt(node.inDegree + node.outDegree) * 1.1);
}

export interface GitHeatStats {
  /** Any node in the set carries git history. */
  hasData: boolean;
  maxChurn: number;
  /** Epoch seconds of the least / most recent commit across the set. */
  oldest: number;
  newest: number;
}

/** Range stats for the git heat lens over a node set — the reference frame the
    per-node recency/churn fractions are computed against. */
export function gitHeatStats(nodes: readonly GraphNode[]): GitHeatStats {
  let hasData = false;
  let maxChurn = 0;
  let oldest = Infinity;
  let newest = 0;
  for (const node of nodes) {
    if (node.churn) maxChurn = Math.max(maxChurn, node.churn);
    const at = node.lastCommitAt;
    if (at) {
      hasData = true;
      if (at < oldest) oldest = at;
      if (at > newest) newest = at;
    }
  }
  return { hasData, maxChurn, oldest: Number.isFinite(oldest) ? oldest : 0, newest };
}

/** Axis-aligned world bounds of a node set (with a little padding), for the
    minimap. Returns a unit box centered at origin for an empty set. */
export function nodeBounds(
  nodes: readonly { x: number; y: number }[],
  paddingFrac = 0.06,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const padX = Math.max(1, (maxX - minX) * paddingFrac);
  const padY = Math.max(1, (maxY - minY) * paddingFrac);
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

export function symbolRelationTargets(expansion: SymbolExpansion | undefined): Set<string> {
  const out = new Set<string>();
  if (!expansion) return out;
  for (const edge of expansion.edges) {
    if (edge.toPath) out.add(edge.toPath);
  }
  return out;
}

export function positionedSymbols(
  nodes: readonly GraphNode[],
  symbolsByPath: Readonly<Record<string, SymbolExpansion>>,
): PositionedSymbol[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const out: PositionedSymbol[] = [];
  for (const [path, expansion] of Object.entries(symbolsByPath)) {
    const parent = nodeById.get(path);
    if (!parent || expansion.symbols.length === 0) continue;
    const positions = symbolOrbitPositions(parent, expansion.symbols.length, graphNodeRadius(parent) + 16);
    for (let i = 0; i < expansion.symbols.length; i += 1) {
      const symbol = expansion.symbols[i];
      const position = positions[i];
      if (!symbol || !position) continue;
      out.push({ symbol, parent, x: position.x, y: position.y });
    }
  }
  return out;
}

/** Ring placement for an expanded file's symbol nodes: deterministic orbit
    around the parent star, spaced evenly with a stable angular offset so the
    layout doesn't jump when symbols are re-fetched. */
export function symbolOrbitPositions(
  parent: { x: number; y: number },
  count: number,
  baseRadius: number,
): Array<{ x: number; y: number }> {
  if (count <= 0) return [];
  const radius = baseRadius + Math.sqrt(count) * 4;
  const offset = -Math.PI / 2; /* first symbol due north */
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const angle = offset + (i / count) * Math.PI * 2;
    out.push({ x: parent.x + radius * Math.cos(angle), y: parent.y + radius * Math.sin(angle) });
  }
  return out;
}
