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
  /** Commits in the recent git window that touched this file (git heat layer).
      Absent when the workspace isn't a git repo or the file is untracked. */
  churn?: number;
  /** Epoch seconds of this file's most recent commit (git heat recency). */
  lastCommitAt?: number;
  kind?: "file" | "cluster" | "service";
  fileCount?: number;
}

export type EdgeKind = "import" | "ai" | "user" | "api" | "event" | "data" | "config";

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
  sourcePath?: string;
  targetPath?: string;
  serviceFrom?: string;
  serviceTo?: string;
  label?: string;
  detail?: string;
  confidence?: number;
  evidence?: string[];
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexedAt: string;
  /** True when the workspace exceeded maxNodes and the map is partial. */
  truncated: boolean;
  indexedTruncated?: boolean;
  renderedTruncated?: boolean;
  relationshipTruncated?: boolean;
  indexedFileCount?: number;
  renderedNodeCount?: number;
  relationshipEdgeCount?: number;
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

/** Cluster key using up to `depth` directory segments (not counting the
    filename), capped at however many the path actually has. depth=2 matches
    clusterDir()'s fixed behavior; assignClusters() goes deeper adaptively. */
function clusterKeyAtDepth(relPath: string, depth: number): string {
  const segments = normalizeGraphPath(relPath).split("/");
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length === 0) return ".";
  return dirSegments.slice(0, Math.max(1, Math.min(depth, dirSegments.length))).join("/");
}

/** Adaptive cluster assignment for a full file set: starts every path at
    clusterDir()'s 2-segment default, then recursively splits any cluster
    bigger than maxClusterSize one segment deeper — so a single top-level
    package with thousands of files across dozens of subdirectories doesn't
    render as one giant same-color blob while everything else on the map is
    finely divided. Stops splitting a cluster once its members are out of
    directory segments to add (nothing left to distinguish them by) or
    maxDepth is reached. Pure function of the whole set, not a single path —
    run it once per full rebuild, not per incremental add. */
export function assignClusters(
  paths: readonly string[],
  maxClusterSize = 40,
  maxDepth = 6,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();

  function settle(bucket: readonly string[], depth: number): void {
    for (const p of bucket) result.set(p, clusterKeyAtDepth(p, depth));
  }

  function split(bucket: readonly string[], depth: number): void {
    if (bucket.length <= maxClusterSize || depth >= maxDepth) {
      settle(bucket, depth);
      return;
    }
    const deeper = new Map<string, string[]>();
    let anyDeeper = false;
    for (const p of bucket) {
      const dirSegmentCount = normalizeGraphPath(p).split("/").length - 1;
      if (dirSegmentCount > depth) anyDeeper = true;
      const key = clusterKeyAtDepth(p, depth + 1);
      const list = deeper.get(key);
      if (list) list.push(p);
      else deeper.set(key, [p]);
    }
    if (!anyDeeper) {
      /* Every member is already at its full depth — splitting further would
         just reproduce the same grouping. Settle here even though oversized. */
      settle(bucket, depth);
      return;
    }
    for (const list of deeper.values()) split(list, depth + 1);
  }

  const initial = new Map<string, string[]>();
  for (const p of paths) {
    const key = clusterKeyAtDepth(p, 2);
    const list = initial.get(key);
    if (list) list.push(p);
    else initial.set(key, [p]);
  }
  for (const list of initial.values()) split(list, 2);

  return result;
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

/** When more candidate files exist than the display cap allows, take them
    round-robin across clusters (top-level folders) instead of a flat
    alphabetical cut. A flat cut lets one huge early-alphabet subtree crowd
    out every other folder, so on a large project only its first-discovered
    area ever renders and everything nested deeper elsewhere is starved out
    entirely. Round-robin guarantees every cluster gets representation. */
export function sampleAcrossClusters(files: readonly string[], cap: number): string[] {
  if (files.length <= cap) return [...files].sort();
  const byCluster = new Map<string, string[]>();
  for (const file of files) {
    const key = clusterDir(file);
    const list = byCluster.get(key);
    if (list) list.push(file);
    else byCluster.set(key, [file]);
  }
  for (const list of byCluster.values()) list.sort();
  const clusters = [...byCluster.values()];
  const out: string[] = [];
  for (let round = 0; out.length < cap; round += 1) {
    let addedAny = false;
    for (const list of clusters) {
      if (round >= list.length) continue;
      out.push(list[round]!);
      addedAny = true;
      if (out.length >= cap) break;
    }
    if (!addedAny) break;
  }
  return out.sort();
}
