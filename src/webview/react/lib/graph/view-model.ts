/* Pure view-model reducer for the Map webview. Applies every GraphHostMessage
   and derives search/selection/neighbor state. The React store wraps this; the
   pixi renderer reads the produced state. No DOM, no bridge — vitest-safe. */

import type {
  GraphAnnotation,
  GraphConfig,
  GraphEdge,
  GraphHostMessage,
  GraphNode,
  SymbolEdge,
  SymbolNode,
  TraceEvent,
} from "./protocol";
import { pruneTraces } from "./traces";

export interface SymbolExpansion {
  symbols: SymbolNode[];
  edges: SymbolEdge[];
  error?: string;
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
  /** Symbol layer: expansions keyed by file path (present = expanded). */
  symbolsByPath: Record<string, SymbolExpansion>;
  symbolsEnabled: boolean;
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
    symbolsByPath: {},
    symbolsEnabled: false,
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
      return {
        ...state,
        nodes: msg.nodes,
        edges: msg.edges,
        annotations: msg.annotations,
        config: msg.config,
        indexing: msg.indexing,
        truncated: msg.truncated,
        indexedAt: msg.indexedAt,
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
