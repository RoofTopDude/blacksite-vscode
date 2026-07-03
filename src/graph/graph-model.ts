/* Pure data model for the Codebase Map. No vscode imports — everything here is
   shared between the host indexer, the annotation store, and unit tests. Node
   ids are workspace-relative paths with forward slashes on every platform. */

export interface GraphNode {
  /** Workspace-relative path, forward slashes (e.g. "src/webview/shell.html"). */
  id: string;
  /** Cluster key: top one or two path segments (e.g. "src/webview"). */
  dir: string;
  /** Language bucket derived from the file extension (e.g. "ts", "py", "css"). */
  lang: string;
  sizeBytes: number;
  inDegree: number;
  outDegree: number;
  x: number;
  y: number;
  /** Depth cue in [0,1]: degree-derived importance. 1 = foreground/brightest. */
  z: number;
}

export type EdgeKind = "import" | "ai" | "user";

export interface GraphEdge {
  /** Import edges: `imp:${from}->${to}`. Annotation edges reuse the annotation id. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  author?: "agent" | "user";
  note?: string;
  createdAt?: string;
  sessionId?: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexedAt: string;
  /** True when the workspace exceeded maxNodes and the map is partial. */
  truncated: boolean;
}

export function normalizeGraphPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/** Cluster key for a path: first two segments for files under a top-level dir,
    or "." for root-level files. "src/webview/react/App.tsx" → "src/webview". */
export function clusterDir(relPath: string): string {
  const segments = normalizeGraphPath(relPath).split("/");
  const first = segments[0] ?? "";
  if (segments.length <= 1 || !first) return ".";
  if (segments.length === 2) return first;
  return `${first}/${segments[1] ?? ""}`;
}

export function langOf(relPath: string): string {
  const name = normalizeGraphPath(relPath).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function importEdgeId(from: string, to: string): string {
  return `imp:${from}->${to}`;
}

/** Depth cue from connectivity: log-scaled total degree mapped into [0,1]. */
export function depthFromDegree(inDegree: number, outDegree: number, maxDegree: number): number {
  const degree = inDegree + outDegree;
  if (maxDegree <= 0 || degree <= 0) return 0.15;
  const scaled = Math.log1p(degree) / Math.log1p(maxDegree);
  return Math.min(1, 0.15 + 0.85 * scaled);
}
