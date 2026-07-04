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
  TraceEvent,
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
  edgeMode: EdgeMode;
  showImports: boolean;
  showAnnotations: boolean;
  showRelations: boolean;
  showEdgeLabels: boolean;
  /** When on, the camera gently follows the file the agent is working on. */
  followAgent: boolean;
}

export const DEFAULT_DISPLAY_OPTIONS: GraphDisplayOptions = {
  edgeMode: "all",
  showImports: true,
  showAnnotations: true,
  showRelations: true,
  showEdgeLabels: true,
  followAgent: false,
};

export interface PositionedSymbol {
  symbol: SymbolNode;
  parent: GraphNode;
  x: number;
  y: number;
}

export interface GraphViewState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  annotations: GraphAnnotation[];
  config: GraphConfig;
  indexing: boolean;
  truncated: boolean;
  indexedAt: string | null;
  traces: TraceEvent[];
  /** Nodes the agent is operating on right now (in-flight tool calls). */
  liveActivity: LiveActivity[];
  /** Symbol layer: expansions keyed by file path (present = expanded). */
  symbolsByPath: Record<string, SymbolExpansion>;
  symbolsEnabled: boolean;
  display: GraphDisplayOptions;
  search: string;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
}

export const DEFAULT_CONFIG: GraphConfig = {
  traceFadeSeconds: 45,
  maxNodes: 4000,
  traceShellEvents: true,
};

export function initialState(): GraphViewState {
  return {
    nodes: [],
    edges: [],
    annotations: [],
    config: DEFAULT_CONFIG,
    indexing: false,
    truncated: false,
    indexedAt: null,
    traces: [],
    liveActivity: [],
    symbolsByPath: {},
    symbolsEnabled: false,
    display: DEFAULT_DISPLAY_OPTIONS,
    search: "",
    selectedNodeId: null,
    hoveredNodeId: null,
  };
}

/** Annotations render as edges alongside imports. */
export function annotationEdges(annotations: readonly GraphAnnotation[]): GraphEdge[] {
  return annotations.map((a) => ({
    id: a.id,
    from: a.from,
    to: a.to,
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
      return {
        ...state,
        nodes: msg.nodes,
        edges: msg.edges,
        annotations: msg.annotations,
        config: msg.config,
        indexing: msg.indexing,
        truncated: msg.truncated,
        indexedAt: msg.indexedAt,
        symbolsByPath,
        selectedNodeId: state.selectedNodeId && validIds.has(state.selectedNodeId) ? state.selectedNodeId : null,
        hoveredNodeId: state.hoveredNodeId && validIds.has(state.hoveredNodeId) ? state.hoveredNodeId : null,
      };
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
  kind: "import" | "annotation" | "relation";
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
    /* Import edges render as arcs (see lib/graph/edges); their label rides the
       arc midpoint so it sits on the curve. Straight relationships keep the
       chord midpoint. */
    const mid = kind === "import" ? edgeArcMidpoint(from, to) : { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
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
  if (display.showAnnotations) {
    for (const annotation of annotations) {
      if (annotation.from === selectedNodeId) add(annotation.id, annotation.from, annotation.to, "note", annotation.note, "annotation");
      else if (annotation.to === selectedNodeId) add(annotation.id, annotation.from, annotation.to, "note", annotation.note, "annotation");
    }
  }
  if (display.showRelations) {
    const expansion = symbolsByPath[selectedNodeId];
    const symbols = new Map((expansion?.symbols ?? []).map((symbol) => [symbol.id, symbol]));
    for (const edge of expansion?.edges ?? []) {
      const symbol = symbols.get(edge.from);
      add(`rel:${edge.from}->${edge.toPath}`, selectedNodeId, edge.toPath, symbol?.name ?? "symbol", edge.toPath, "relation");
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
