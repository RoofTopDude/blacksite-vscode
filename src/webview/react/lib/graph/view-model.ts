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
import { fileRole } from "./file-role";
import type { Camera } from "./camera";

export interface SymbolExpansion {
  symbols: SymbolNode[];
  edges: SymbolEdge[];
  error?: string;
}

export type EdgeMode = "all" | "selected" | "clusters" | "off";

/** Renderer-facing interpretation of the persisted edge mode. `all` remains a
    stable user preference, but resolves adaptively so dense overviews do not
    turn into an unreadable mesh. */
export type EdgeRenderStrategy = "raw" | "selected" | "bundled" | "off";

export interface EdgePresentation {
  strategy: EdgeRenderStrategy;
  dense: boolean;
  /** Directed edges per visible node. */
  density: number;
  /** Zoom ratio (relative to fit) where an adaptive overview reveals raw edges. */
  detailZoom: number;
}

const FILE_EDGE_DETAIL_ZOOM = 1.8;
const FILE_DENSE_NODE_FLOOR = 320;
const FILE_DENSE_EDGE_FLOOR = 900;
const FILE_DENSE_EDGES_PER_NODE = 1.6;
/* Service nodes are already a semantic projection of the file corpus, so a
   graph with a few dozen services can be just as visually dense as a much
   larger file map. These thresholds deliberately operate on *typed service
   routes* (after duplicate detections are bundled), not raw detections. */
const SERVICE_EDGE_DETAIL_ZOOM = 1.65;
const SERVICE_DENSE_NODE_FLOOR = 28;
const SERVICE_DENSE_EDGE_FLOOR = 84;
const SERVICE_DENSE_EDGES_PER_NODE = 2.4;

/** Resolve a persisted edge mode into the amount of topology the renderer
    should present at the current zoom. Explicit modes are exact; only `all` is
    adaptive. The service lens passes its already-bundled typed route count so
    large many-to-many service meshes receive the same readable overview
    treatment as file graphs without hiding small, evidence-rich topologies. */
export function edgePresentation(
  edgeMode: EdgeMode,
  lens: GraphDisplayOptions["lens"],
  nodeCount: number,
  edgeCount: number,
  zoomRatio: number,
): EdgePresentation {
  const nodes = Number.isFinite(nodeCount) ? Math.max(0, Math.floor(nodeCount)) : 0;
  const edges = Number.isFinite(edgeCount) ? Math.max(0, Math.floor(edgeCount)) : 0;
  const density = nodes > 0 ? edges / nodes : 0;
  const serviceLens = lens === "services";
  const nodeFloor = serviceLens ? SERVICE_DENSE_NODE_FLOOR : FILE_DENSE_NODE_FLOOR;
  const edgeFloor = serviceLens ? SERVICE_DENSE_EDGE_FLOOR : FILE_DENSE_EDGE_FLOOR;
  const densityFloor = serviceLens ? SERVICE_DENSE_EDGES_PER_NODE : FILE_DENSE_EDGES_PER_NODE;
  const detailZoom = serviceLens ? SERVICE_EDGE_DETAIL_ZOOM : FILE_EDGE_DETAIL_ZOOM;
  const dense = nodes >= nodeFloor
    && edges >= edgeFloor
    && density >= densityFloor;
  const zoom = Number.isFinite(zoomRatio) && zoomRatio > 0 ? zoomRatio : 1;

  let strategy: EdgeRenderStrategy;
  if (edgeMode === "off") strategy = "off";
  else if (edgeMode === "selected") strategy = "selected";
  else if (edgeMode === "clusters") strategy = "bundled";
  else strategy = dense && zoom < detailZoom ? "bundled" : "raw";

  return { strategy, dense, density, detailZoom };
}

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
  /** Highlight cross-project reference cycles on their connecting edges. Off
      by default, like every other additive analysis layer. */
  showCycles: boolean;
  /** Highlight single-access "pocket" subgraphs and true orphans within each
      neighborhood. Off by default, like every other additive analysis layer. */
  showCulDeSacs: boolean;
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
  showCycles: false,
  showCulDeSacs: false,
};

/** Non-destructive focus filter. All-zero/empty = inactive (everything shown).
    Filtered-out stars are ghosted, not removed, so the map keeps its shape. */
export interface GraphFilter {
  /** Active language buckets (node.lang); empty = every language. */
  langs: string[];
  /** Soloed folder territories (node.dir); empty = every territory. */
  dirs: string[];
  /** Active functional roles (fileRole(node.id) — test/config/docs/…); empty = every role. */
  roles: string[];
  /** Hide files below this total degree (in+out); 0 = off. Declutters to hubs. */
  minDegree: number;
  /** With a selection, show only nodes within this many hops of it; 0 = off. */
  isolateDepth: number;
}

export const DEFAULT_FILTER: GraphFilter = { langs: [], dirs: [], roles: [], minDegree: 0, isolateDepth: 0 };

export function filterIsActive(filter: GraphFilter, hasSelection: boolean): boolean {
  return filter.langs.length > 0
    || (filter.dirs?.length ?? 0) > 0
    || (filter.roles?.length ?? 0) > 0
    || filter.minDegree > 0
    || (filter.isolateDepth > 0 && hasSelection);
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
  const dirSet = new Set(filter.dirs ?? []);
  const roleSet = new Set(filter.roles ?? []);
  const passesBase = (node: GraphNode): boolean => {
    if (node.kind === "service") return true;
    /* Territory solo applies to clusters too — a folded folder *is* its dir —
       while the lang/role/degree gates still skip aggregates (mixed contents). */
    if (dirSet.size > 0 && !dirSet.has(node.dir)) return false;
    if (node.kind === "cluster") return true;
    if (langSet.size > 0 && !langSet.has(node.lang)) return false;
    if (roleSet.size > 0 && !roleSet.has(fileRole(node.id))) return false;
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
  /** Neighborhood-root pairs in a cross-project reference cycle. */
  cyclicNeighborhoodPairs: [string, string][];
  /** File ids with no import connection to their neighborhood's main body. */
  orphanNodeIds: string[];
  /** File ids in a single-access "pocket" subgraph. */
  pocketNodeIds: string[];
  /** Edge ids that are the sole connection into a pocket subgraph. */
  bridgeEdgeIds: string[];
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
  /** Territory (dir) the pointer is previewing in the rail's territory index —
      transient, never persisted; the renderer lifts that territory's stars. */
  hoveredTerritory: string | null;
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

/** A named, persisted snapshot of camera + display/filter/collapse state, so a
    user can jump back to a particular vantage on a large map (e.g. "auth
    flow", "what Alice touches") instead of re-deriving it every time. Camera
    restoration itself is handled by the caller (GraphStoreState.pendingCameraRestore
    → GraphApp.tsx's flyTo effect), since the camera is renderer-owned. */
export interface SavedView {
  id: string;
  name: string;
  createdAt: string;
  camera: Camera;
  display: GraphDisplayOptions;
  filter: GraphFilter;
  collapsedClusters: string[];
}

export const DEFAULT_CONFIG: GraphConfig = {
  traceFadeSeconds: 45,
  performanceProfile: "balanced",
  maxIndexedFiles: 12000,
  maxRenderedStars: 4000,
  maxRelationshipEdges: 5000,
  traceShellEvents: true,
  backgroundSymbols: false,
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
    cyclicNeighborhoodPairs: [],
    orphanNodeIds: [],
    pocketNodeIds: [],
    bridgeEdgeIds: [],
    traces: [],
    liveActivity: [],
    symbolsByPath: {},
    symbolsEnabled: false,
    display: DEFAULT_DISPLAY_OPTIONS,
    filter: DEFAULT_FILTER,
    search: "",
    selectedNodeId: null,
    hoveredNodeId: null,
    hoveredTerritory: null,
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
/** File-lens edge kinds worth remapping onto cluster super-nodes when their
    endpoints collapse — imports plus the background symbol sweep's edges.
    Service-lens edges (api/event/data/config) have their own aggregation
    (deriveServiceGraph) and never reach this path. */
const CLUSTER_REMAPPABLE_KINDS = new Set<GraphEdge["kind"]>(["import", "call", "reference", "supertype"]);

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
  const agg = new Map<string, {
    sx: number;
    sy: number;
    size: number;
    count: number;
    churn: number;
    lastAt: number;
    neighborhoods: Map<string, number>;
  }>();
  const displayNodes: GraphNode[] = [];
  for (const node of nodes) {
    dirById.set(node.id, node.dir);
    if (!collapsed.has(node.dir)) {
      displayNodes.push(node);
      continue;
    }
    const entry = agg.get(node.dir) ?? {
      sx: 0,
      sy: 0,
      size: 0,
      count: 0,
      churn: 0,
      lastAt: 0,
      neighborhoods: new Map<string, number>(),
    };
    entry.sx += node.x;
    entry.sy += node.y;
    entry.size += node.sizeBytes;
    entry.count += 1;
    entry.churn += node.churn ?? 0;
    if ((node.lastCommitAt ?? 0) > entry.lastAt) entry.lastAt = node.lastCommitAt ?? 0;
    if (node.neighborhood) {
      entry.neighborhoods.set(node.neighborhood, (entry.neighborhoods.get(node.neighborhood) ?? 0) + 1);
    }
    agg.set(node.dir, entry);
  }
  for (const [dir, entry] of agg) {
    const neighborhood = [...entry.neighborhoods.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    displayNodes.push({
      id: clusterNodeId(dir),
      dir,
      lang: "",
      sizeBytes: entry.size,
      /* Filled from the remapped, merged display edges below. */
      inDegree: 0,
      outDegree: 0,
      x: entry.sx / entry.count,
      y: entry.sy / entry.count,
      z: 1,
      kind: "cluster",
      fileCount: entry.count,
      churn: entry.churn || undefined,
      lastCommitAt: entry.lastAt || undefined,
      ...(neighborhood ? { neighborhood } : {}),
    });
  }

  /* Remap every file-lens edge (imports + the background symbol sweep's
     call/reference/supertype edges) onto the visible endpoints and merge
     duplicates, keyed by kind so different relations between the same two
     clusters don't collapse into one. */
  const mapEndpoint = (id: string): string => {
    const dir = dirById.get(id);
    return dir !== undefined && collapsed.has(dir) ? clusterNodeId(dir) : id;
  };
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (!CLUSTER_REMAPPABLE_KINDS.has(edge.kind)) continue;
    const from = mapEndpoint(edge.from);
    const to = mapEndpoint(edge.to);
    if (from === to) continue; /* wholly inside one collapsed cluster */
    const key = `${edge.kind}|${from}->${to}`;
    if (!merged.has(key)) {
      const idPrefix = edge.kind === "import" ? "imp" : edge.kind;
      merged.set(key, { id: `${idPrefix}:${from}->${to}`, from, to, kind: edge.kind });
    }
  }
  const displayEdges = [...merged.values()];
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of displayEdges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  for (const node of displayNodes) {
    if (!isClusterNode(node)) continue;
    node.inDegree = inDegree.get(node.id) ?? 0;
    node.outDegree = outDegree.get(node.id) ?? 0;
  }
  return { displayNodes, displayEdges };
}

function relationshipVisible(edge: GraphEdge, display: GraphDisplayOptions): boolean {
  if (edge.kind === "api") return display.showApi;
  if (edge.kind === "event") return display.showEvents;
  if (edge.kind === "data") return display.showData;
  if (edge.kind === "config") return display.showConfig;
  return false;
}

export type ServiceRelationshipKind = Extract<GraphEdge["kind"], "api" | "event" | "data" | "config">;

export interface ServiceRelationshipBundle {
  id: string;
  from: string;
  to: string;
  kind: ServiceRelationshipKind;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  count: number;
  averageConfidence: number;
  minConfidence: number;
  maxConfidence: number;
  /** Highest-confidence edge in the bundle (stable id tie-break), retaining
      label, evidence, source/target paths, and other drill-down metadata. */
  representative: GraphEdge;
}

function serviceRelationshipKind(kind: GraphEdge["kind"]): kind is ServiceRelationshipKind {
  return kind === "api" || kind === "event" || kind === "data" || kind === "config";
}

function normalizedRelationshipConfidence(edge: GraphEdge): number {
  return Math.max(0, Math.min(1, edge.confidence ?? 0.55));
}

/** Renderer-ready, directed bundles of parallel service relationships. Raw
    detections remain untouched for inspector drill-down; this projection gives
    an overview one route per from/to/kind with truthful strength and confidence.
    Missing endpoints are omitted because their positions cannot be rendered. */
export function serviceRelationshipBundles(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): ServiceRelationshipBundle[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, {
    from: GraphNode;
    to: GraphNode;
    kind: ServiceRelationshipKind;
    count: number;
    confidenceSum: number;
    minConfidence: number;
    maxConfidence: number;
    representative: GraphEdge;
    representativeConfidence: number;
  }>();

  for (const edge of edges) {
    if (!serviceRelationshipKind(edge.kind)) continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    const confidence = normalizedRelationshipConfidence(edge);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        from,
        to,
        kind: edge.kind,
        count: 1,
        confidenceSum: confidence,
        minConfidence: confidence,
        maxConfidence: confidence,
        representative: edge,
        representativeConfidence: confidence,
      });
      continue;
    }
    current.count += 1;
    current.confidenceSum += confidence;
    current.minConfidence = Math.min(current.minConfidence, confidence);
    current.maxConfidence = Math.max(current.maxConfidence, confidence);
    if (
      confidence > current.representativeConfidence
      || (confidence === current.representativeConfidence && edge.id < current.representative.id)
    ) {
      current.representative = edge;
      current.representativeConfidence = confidence;
    }
  }

  return [...grouped.values()]
    .map((bundle): ServiceRelationshipBundle => ({
      id: `service:${bundle.kind}:${bundle.from.id}->${bundle.to.id}`,
      from: bundle.from.id,
      to: bundle.to.id,
      kind: bundle.kind,
      fromX: bundle.from.x,
      fromY: bundle.from.y,
      toX: bundle.to.x,
      toY: bundle.to.y,
      count: bundle.count,
      averageConfidence: bundle.confidenceSum / bundle.count,
      minConfidence: bundle.minConfidence,
      maxConfidence: bundle.maxConfidence,
      representative: bundle.representative,
    }))
    .sort((a, b) => b.count - a.count
      || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to)
      || a.kind.localeCompare(b.kind));
}

const DEFAULT_SERVICE_BACKBONE_MAX_ROUTES = 180;

/**
 * Select a compact, connectivity-preserving service projection from typed
 * service routes. It is intentionally applied *after* serviceRelationshipBundles:
 * the selected route still carries one real relationship kind, confidence, and
 * evidence representative rather than becoming an opaque aggregate.
 *
 * A maximum-strength forest makes every connected service reachable in the
 * overview; the strongest remaining routes then fill a bounded budget so
 * important alternate paths remain visible. Detail zoom and focused-service
 * inspection retain all typed routes, so this function never mutates evidence.
 */
export function serviceRelationshipBackbone(
  bundles: readonly ServiceRelationshipBundle[],
  maxRoutes?: number,
): ServiceRelationshipBundle[] {
  const strength = (bundle: ServiceRelationshipBundle): number =>
    bundle.count * (0.55 + bundle.averageConfidence * 0.45);
  const ranked = [...bundles].sort((a, b) => {
    const delta = strength(b) - strength(a);
    if (Math.abs(delta) > 1e-9) return delta;
    if (a.count !== b.count) return b.count - a.count;
    if (a.averageConfidence !== b.averageConfidence) return b.averageConfidence - a.averageConfidence;
    return a.id.localeCompare(b.id);
  });
  if (ranked.length <= 1) return ranked;

  const services = new Set<string>();
  for (const bundle of ranked) {
    services.add(bundle.from);
    services.add(bundle.to);
  }
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const service of services) {
    parent.set(service, service);
    rank.set(service, 0);
  }
  const find = (service: string): string => {
    const current = parent.get(service) ?? service;
    if (current === service) return service;
    const root = find(current);
    parent.set(service, root);
    return root;
  };
  const unite = (a: string, b: string): boolean => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return false;
    const rankA = rank.get(rootA) ?? 0;
    const rankB = rank.get(rootB) ?? 0;
    if (rankA < rankB || (rankA === rankB && rootA > rootB)) {
      [rootA, rootB] = [rootB, rootA];
    }
    parent.set(rootB, rootA);
    if (rankA === rankB) rank.set(rootA, rankA + 1);
    return true;
  };

  const selected = new Set<string>();
  for (const bundle of ranked) {
    if (unite(bundle.from, bundle.to)) selected.add(bundle.id);
  }
  const forestSize = selected.size;
  const defaultCap = Math.min(
    DEFAULT_SERVICE_BACKBONE_MAX_ROUTES,
    Math.max(1, services.size * 3),
  );
  const requestedCap = maxRoutes === undefined || Number.isNaN(maxRoutes)
    ? defaultCap
    : maxRoutes === Infinity
      ? ranked.length
      : Math.max(0, Math.floor(maxRoutes));
  const cap = Math.min(ranked.length, Math.max(forestSize, requestedCap));

  for (const bundle of ranked) {
    if (selected.size >= cap) break;
    selected.add(bundle.id);
  }
  return ranked.filter((bundle) => selected.has(bundle.id));
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
    const [a = "", b = ""] = key.split("\u0000");
    if (!a || !b) continue;
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
  /* Dense many-to-many meshes make every weighted average converge toward the
     same point. A deterministic collision pass restores legible service
     separation while a light anchor pull keeps the result related to the file
     geography. This is intentionally O(S²): S is the already-aggregated
     service count, not the file or raw relationship count. */
  const COLLISION_ITERATIONS = 14;
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const stableAngle = (a: string, b: string): number => {
    let hash = 2166136261;
    for (const char of `${a}\u0000${b}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return ((hash >>> 0) / 4294967296) * Math.PI * 2;
  };
  for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration += 1) {
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const aNode = ordered[i]!;
        const bNode = ordered[j]!;
        const a = byId.get(aNode.id)!;
        const b = byId.get(bNode.id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-6) {
          const angle = stableAngle(aNode.id, bNode.id);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const minimum = Math.min(210, 112 + Math.sqrt((aNode.fileCount ?? 1) + (bNode.fileCount ?? 1)) * 4);
        if (distance >= minimum) continue;
        const push = (minimum - distance) * 0.5;
        const ux = dx / distance;
        const uy = dy / distance;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
    for (const position of byId.values()) {
      position.x += (position.anchorX - position.x) * 0.025;
      position.y += (position.anchorY - position.y) * 0.025;
    }
  }
  return nodes.map((node) => {
    const pos = byId.get(node.id);
    return pos ? { ...node, x: pos.x, y: pos.y } : node;
  });
}

function deriveServiceGraph(nodes: GraphNode[], relationshipEdges: GraphEdge[], display: GraphDisplayOptions): { displayNodes: GraphNode[]; displayEdges: GraphEdge[] } {
  const visibleEdges = relationshipEdges.filter((edge) => relationshipVisible(edge, display) && edge.serviceFrom && edge.serviceTo);
  const byService = new Map<string, GraphNode>();
  const serviceRoots = [...new Set(visibleEdges.flatMap((edge) => [edge.serviceFrom!, edge.serviceTo!]))]
    .sort((a, b) => a.localeCompare(b));
  const sourceNodesByService = new Map<string, GraphNode[]>(serviceRoots.map((service) => [service, []]));
  for (const node of nodes) {
    /* A file belongs to its most specific service root. The old all-matches
       loop double-counted nested monorepo services (e.g. `apps` and
       `apps/payments`) and left workspace-root (`.`) services empty. */
    let owner: string | null = null;
    for (const service of serviceRoots) {
      if (service !== "." && node.id !== service && !node.id.startsWith(`${service}/`)) continue;
      if (!owner || service.length > owner.length || (service.length === owner.length && service < owner)) {
        owner = service;
      }
    }
    if (owner) sourceNodesByService.get(owner)!.push(node);
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
  /* Stable root order makes fallback placement independent of raw edge order. */
  for (const service of serviceRoots) ensure(service);
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
  const selectionExists = !state.selectedNodeId || displayNodes.some((node) => node.id === state.selectedNodeId);
  const selectedNodeId = selectionExists ? state.selectedNodeId : null;
  const hoveredNodeId = state.hoveredNodeId && displayNodes.some((node) => node.id === state.hoveredNodeId)
    ? state.hoveredNodeId
    : null;
  const filter = selectedNodeId || state.filter.isolateDepth === 0
    ? state.filter
    : { ...state.filter, isolateDepth: 0 };
  return { ...state, displayNodes, displayEdges, selectedNodeId, hoveredNodeId, filter };
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

/** Apply a saved view's display/filter/collapse state. Collapsed dirs are
    filtered against the live file set — the same defensive pattern the
    graph_state case uses — since a saved view can predate a re-index that
    retired a folder. Camera restoration is not this function's job; the
    caller (store.ts's applyView) separately sets pendingCameraRestore. */
export function applySavedView(state: GraphViewState, view: SavedView): GraphViewState {
  const liveDirs = new Set(state.nodes.map((node) => node.dir));
  const collapsedClusters = view.collapsedClusters.filter((dir) => liveDirs.has(dir));
  return withDisplayGraph({
    ...state,
    display: { ...view.display },
    /* Merge over the defaults: a view saved before a filter field existed
       (e.g. `dirs`) must come back well-formed, not with undefined arrays. */
    filter: { ...DEFAULT_FILTER, ...view.filter },
    collapsedClusters,
  });
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
        // Symbol-sweep edges (call/reference/supertype) are file-to-file connections
        // like imports, so they belong in the same file-lens edge set rather than a
        // separate array — the services lens has no use for them.
        edges: msg.symbolEdges?.length ? [...msg.edges, ...msg.symbolEdges] : msg.edges,
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
        cyclicNeighborhoodPairs: msg.cyclicNeighborhoodPairs ?? [],
        orphanNodeIds: msg.orphanNodeIds ?? [],
        pocketNodeIds: msg.pocketNodeIds ?? [],
        bridgeEdgeIds: msg.bridgeEdgeIds ?? [],
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

/** Parent hub key for a cluster label: the first one or two path segments.
    Adaptive clustering can produce deeper buckets under a shared top-level
    territory; this key is the user-facing "what area is this?" anchor. */
export function clusterHubKey(dir: string): string {
  if (dir === ".") return ".";
  const segments = dir.split("/").filter(Boolean);
  return segments.slice(0, Math.min(2, segments.length)).join("/") || ".";
}

/** Human-facing label for a hub territory. Root-level files read as the
    workspace itself rather than a literal "." bucket. */
export function clusterHubLabel(dir: string): string {
  const hub = clusterHubKey(dir);
  return hub === "." ? "workspace" : hub;
}

/** Relative subgroup label underneath a hub territory, or null when the
    cluster itself already *is* the hub. Kept compact so the overlay can show
    both the parent hub and one distinguishing subgroup cue without turning
    into a path dump. */
export function clusterSubgroupLabel(dir: string): string | null {
  const hub = clusterHubKey(dir);
  if (dir === "." || dir === hub) return null;
  const suffix = dir.slice(hub.length + 1);
  if (!suffix) return null;
  const segments = suffix.split("/").filter(Boolean);
  return segments.length <= 3 ? suffix : `…/${segments.slice(-2).join("/")}`;
}

const GENERIC_NEIGHBORHOOD_SEGMENTS = new Set(["src", "main", "app", "apps", "packages", "services", "lib", "libs", "develop", "master"]);

/** Human-facing name for a neighborhood-territory key (node.neighborhood): its
    most specific non-generic trailing path segment. Mirrors the host's
    graph/neighborhoods.ts neighborhoodLabel (hand-mirrored per repo convention). */
export function neighborhoodLabel(root: string): string {
  if (!root || root === ".") return "workspace";
  const segments = root.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!GENERIC_NEIGHBORHOOD_SEGMENTS.has(segments[i]!.toLowerCase())) return segments[i]!;
  }
  return segments[segments.length - 1] ?? root;
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

/** Indices (into `text`, already lowercased by the caller) of a left-to-right
    subsequence match of `term`, or null when the characters don't all appear
    in order. Greedy and deterministic — good enough for "grapp" → GraphApp. */
function subsequenceIndices(text: string, term: string): number[] | null {
  const out: number[] = [];
  let from = 0;
  for (const ch of term) {
    const at = text.indexOf(ch, from);
    if (at === -1) return null;
    out.push(at);
    from = at + 1;
  }
  return out;
}

interface SearchTermHit {
  score: number;
  /** Matched character indices into the full path, for highlighting. */
  indices: number[];
}

/** How one whitespace-separated search term lands on one path. Exact
    substrings beat fuzzy hits, and the basename beats the directory part —
    typing a file name should surface files *named* that, not every path that
    merely passes through a similarly-named folder. The fuzzy tier only ever
    looks at the basename, so short terms don't light up half the map via
    scattered path letters. */
function searchTermHit(path: string, term: string): SearchTermHit | null {
  const lower = path.toLowerCase();
  const baseStart = lower.lastIndexOf("/") + 1;
  const base = lower.slice(baseStart);
  const inBase = base.indexOf(term);
  if (inBase >= 0) {
    const indices: number[] = [];
    for (let i = 0; i < term.length; i += 1) indices.push(baseStart + inBase + i);
    return { score: 400 - inBase * 2 + (inBase === 0 ? 60 : 0) + term.length * 4, indices };
  }
  const inPath = lower.indexOf(term);
  if (inPath >= 0) {
    const indices: number[] = [];
    for (let i = 0; i < term.length; i += 1) indices.push(inPath + i);
    return { score: 220 - Math.min(140, inPath) + term.length * 3, indices };
  }
  if (term.length < 3) return null; /* 1–2 chars fuzzy-match nearly everything */
  const fuzzy = subsequenceIndices(base, term);
  if (!fuzzy) return null;
  const spread = (fuzzy[fuzzy.length - 1]! - fuzzy[0]!) - (term.length - 1); /* 0 = contiguous */
  return { score: Math.max(20, 140 - spread * 8), indices: fuzzy.map((i) => i + baseStart) };
}

/** Combined hit for a whole query (terms are AND-ed), or null on any miss. */
function searchQueryHit(path: string, query: string): SearchTermHit | null {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  let score = 0;
  const indices = new Set<number>();
  for (const term of terms) {
    const hit = searchTermHit(path, term);
    if (!hit) return null;
    score += hit.score;
    for (const i of hit.indices) indices.add(i);
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

/** Whether a node passes the search (multi-term AND; each term as a substring
    of the path or a fuzzy subsequence of the basename). Empty query matches
    everything. Must stay consistent with searchMatches — the renderer dims by
    this while the dropdown lists by that. */
export function matchesSearch(node: GraphNode, query: string): boolean {
  if (!query.trim()) return true;
  return searchQueryHit(node.id, query) !== null;
}

/** Ranked search results: exact basename hits first, then path substrings,
    then fuzzy basename matches; ties broken by shorter path, then id. */
export function searchMatches(nodes: readonly GraphNode[], query: string, limit = 50): GraphNode[] {
  if (!query.trim()) return [];
  const scored: Array<{ node: GraphNode; score: number }> = [];
  for (const node of nodes) {
    const hit = searchQueryHit(node.id, query);
    if (hit) scored.push({ node, score: hit.score });
  }
  return scored
    .sort((a, b) => b.score - a.score
      || a.node.id.length - b.node.id.length
      || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
    .slice(0, limit)
    .map((entry) => entry.node);
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/** Split a path into contiguous hit/miss segments for rendering the search
    dropdown with the matched characters emphasized. Segments always
    concatenate back to the original text; a query that doesn't match yields
    one unhighlighted segment. */
export function searchHighlightSegments(path: string, query: string): HighlightSegment[] {
  const hit = query.trim() ? searchQueryHit(path, query) : null;
  if (!hit || hit.indices.length === 0) return [{ text: path, hit: false }];
  const matched = new Set(hit.indices);
  const out: HighlightSegment[] = [];
  let start = 0;
  for (let i = 1; i <= path.length; i += 1) {
    if (i === path.length || matched.has(i) !== matched.has(start)) {
      out.push({ text: path.slice(start, i), hit: matched.has(start) });
      start = i;
    }
  }
  return out;
}

export interface FolderTerritory {
  dir: string;
  /** File count — the territory's weight in the rail listing. */
  count: number;
  /** Centroid of member files (world space). */
  x: number;
  y: number;
  /** Axis-aligned bounds of member files, for framing the camera. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** The biggest folder territories in the file corpus, for the control rail's
    territory index: each row carries the same dir key folderColor() hashes,
    so the rail swatches provably match the canvas hues. Aggregate nodes are
    excluded — territories are a projection of real files. */
export function folderTerritories(nodes: readonly GraphNode[], limit = 32): FolderTerritory[] {
  const byDir = new Map<string, { count: number; sx: number; sy: number; minX: number; minY: number; maxX: number; maxY: number }>();
  for (const node of nodes) {
    if (node.kind === "cluster" || node.kind === "service") continue;
    const entry = byDir.get(node.dir) ?? { count: 0, sx: 0, sy: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    entry.count += 1;
    entry.sx += node.x;
    entry.sy += node.y;
    if (node.x < entry.minX) entry.minX = node.x;
    if (node.x > entry.maxX) entry.maxX = node.x;
    if (node.y < entry.minY) entry.minY = node.y;
    if (node.y > entry.maxY) entry.maxY = node.y;
    byDir.set(node.dir, entry);
  }
  return [...byDir.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([dir, entry]) => ({
      dir,
      count: entry.count,
      x: entry.sx / entry.count,
      y: entry.sy / entry.count,
      bounds: { minX: entry.minX, minY: entry.minY, maxX: entry.maxX, maxY: entry.maxY },
    }));
}

/** The most-connected real files, for the rail's Hubs quick-list: the places
    a reader most likely needs to know exist. Aggregates are excluded (their
    degree is an artifact of folding) and zero-degree files never qualify. */
export function topHubs(nodes: readonly GraphNode[], limit = 8): GraphNode[] {
  return nodes
    .filter((node) => (!node.kind || node.kind === "file") && node.inDegree + node.outDegree > 0)
    .sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

/** Semantic zoom bands, mirroring the label overlay's crossfade levels: the
    altitude meter names the level the camera is at and offers one-click
    travel between them. Ratios are relative to the whole-map fit zoom. */
export type MapAltitude = "overview" | "modules" | "files";

export function altitudeBand(zoomRatio: number): MapAltitude {
  if (!Number.isFinite(zoomRatio) || zoomRatio < 1.1) return "overview";
  return zoomRatio < 2.05 ? "modules" : "files";
}

/** Fly-to target (as a fit-zoom multiple) for each band — comfortably inside
    the band, not at its boundary, so the meter lights the level you asked for. */
export function altitudeZoomRatio(band: MapAltitude): number {
  switch (band) {
    case "overview": return 0.85;
    case "modules": return 1.5;
    case "files": return 2.6;
  }
}

export interface NodeConnectionGroup {
  /** Total distinct neighbors in this direction (may exceed nodes.length). */
  total: number;
  /** Top neighbors by connectivity, ready for a click-to-navigate list. */
  nodes: GraphNode[];
}

/** The selected node's direct import neighbors, split by direction and ranked
    by connectivity so the node card can offer a "walk the graph" list instead
    of bare degree counts. Operates on the display graph, so a neighbor folded
    into a collapsed cluster surfaces as that cluster's super-node. */
export function nodeConnections(
  nodeId: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  limit = 5,
): { dependencies: NodeConnectionGroup; dependents: NodeConnectionGroup } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependencyIds = new Set<string>();
  const dependentIds = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    if (edge.from === nodeId && edge.to !== nodeId) dependencyIds.add(edge.to);
    else if (edge.to === nodeId && edge.from !== nodeId) dependentIds.add(edge.from);
  }
  const group = (ids: Set<string>): NodeConnectionGroup => ({
    total: ids.size,
    nodes: [...ids]
      .map((id) => byId.get(id))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit),
  });
  return { dependencies: group(dependencyIds), dependents: group(dependentIds) };
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
  limit = 6,
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
    /* Alternate outbound dependencies and inbound dependents so a high fan-in
       or fan-out cannot consume every label slot before the opposite direction
       is represented. The inspector retains the complete counts. */
    const outbound = edges.filter((edge) => edge.kind === "import" && edge.from === selectedNodeId);
    const inbound = edges.filter((edge) => edge.kind === "import" && edge.to === selectedNodeId);
    for (let index = 0; out.length < limit && (index < outbound.length || index < inbound.length); index += 1) {
      const dependency = outbound[index];
      if (dependency) add(dependency.id, dependency.from, dependency.to, "imports", dependency.to, "import");
      const dependent = inbound[index];
      if (dependent) add(dependent.id, dependent.from, dependent.to, "imported by", dependent.from, "import");
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

const DEFAULT_BACKBONE_MAX_EDGES = 240;

/** Reduce a dense cluster-to-cluster mesh without changing its reachability.
    Routes are ranked by aggregate import count (then stable ids), a maximum
    spanning forest is retained, and the strongest remaining routes fill the
    deterministic budget. If maxEdges is smaller than the forest, connectivity
    wins and the forest is returned in full. */
export function clusterBackboneEdges(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  maxEdges?: number,
): ClusterEdge[] {
  const ranked = clusterEdges(nodes, edges).sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  if (ranked.length <= 1) return ranked;

  const dirs = new Set<string>();
  for (const edge of ranked) {
    dirs.add(edge.fromDir);
    dirs.add(edge.toDir);
  }

  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const dir of dirs) {
    parent.set(dir, dir);
    rank.set(dir, 0);
  }
  const find = (dir: string): string => {
    const current = parent.get(dir) ?? dir;
    if (current === dir) return dir;
    const root = find(current);
    parent.set(dir, root);
    return root;
  };
  const unite = (a: string, b: string): boolean => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return false;
    const rankA = rank.get(rootA) ?? 0;
    const rankB = rank.get(rootB) ?? 0;
    if (rankA < rankB || (rankA === rankB && rootA > rootB)) {
      [rootA, rootB] = [rootB, rootA];
    }
    parent.set(rootB, rootA);
    if (rankA === rankB) rank.set(rootA, rankA + 1);
    return true;
  };

  const selected = new Set<string>();
  for (const edge of ranked) {
    if (unite(edge.fromDir, edge.toDir)) selected.add(edge.id);
  }
  const forestSize = selected.size;
  const defaultCap = Math.min(
    DEFAULT_BACKBONE_MAX_EDGES,
    Math.max(1, dirs.size * 2),
  );
  const requestedCap = maxEdges === undefined || Number.isNaN(maxEdges)
    ? defaultCap
    : maxEdges === Infinity
      ? ranked.length
      : Math.max(0, Math.floor(maxEdges));
  const cap = Math.min(ranked.length, Math.max(forestSize, requestedCap));

  for (const edge of ranked) {
    if (selected.size >= cap) break;
    selected.add(edge.id);
  }
  return ranked.filter((edge) => selected.has(edge.id));
}

export function graphNodeRadius(node: { inDegree: number; outDegree: number; sizeBytes?: number; kind?: string }): number {
  const degree = 2.5 + Math.min(9, Math.sqrt(node.inDegree + node.outDegree) * 1.1);
  // File size adds a secondary, log-scaled component on real files: a 100 KB file
  // reads visibly larger than a 1 KB one, without bulk ever outshouting
  // connectivity (degree spans ~9 radius units, size caps at 3.5). Aggregates
  // (cluster/service super-nodes) sum their members' bytes, so they stay
  // degree-sized — their silhouette marks already distinguish them.
  const isFile = !node.kind || node.kind === "file";
  const size = isFile && node.sizeBytes
    ? Math.min(3.5, Math.log10(1 + node.sizeBytes / 1024) * 1.4)
    : 0;
  return degree + size;
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
