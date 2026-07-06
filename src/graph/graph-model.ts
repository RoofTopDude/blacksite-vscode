/* Pure data model for the Codebase Map. No vscode imports — everything here is
   shared between the host indexer, the annotation store, and unit tests. Node
   ids are workspace-relative paths with forward slashes on every platform. */

export interface GraphNode {
  /** Workspace-relative path, forward slashes (e.g. "src/webview/shell.html"). */
  id: string;
  /** Cluster key: top one or two path segments (e.g. "src/webview"). */
  dir: string;
  /** Codebase-territory key this file belongs to (a project/solution/workspace
      root from topology, else a top path segment). Drives the neighborhood
      layout + labels; absent when territorialization is off. See
      graph/neighborhoods.ts. */
  neighborhood?: string;
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

export type EdgeKind =
  | "import" | "ai" | "user" | "api" | "event" | "data" | "config"
  /* Symbol-layer edges (background LSP sweep): who calls whom, who references a
     file's symbols, and type inheritance. See graph/symbol-pass.ts. */
  | "call" | "reference" | "supertype";

/** Where an edge came from — lets the corpus keep one edge type across the
    import, service-relationship, symbol, and topology layers while still
    filtering by source at derive time. */
export type EdgeProvenance = "import" | "service" | "symbol" | "topology";

export interface GraphEdge {
  /** Import edges: `imp:${from}->${to}`. Annotation edges reuse the annotation id. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  provenance?: EdgeProvenance;
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

/** Directory of a node-id path ("a/b/c.ts" → "a/b", "c.ts" → ""). Assumes an
    already-normalized forward-slash path. Shared by every specifier resolver,
    the tsconfig/go.mod loaders, and the Razor/Java suffix matchers so "what
    directory is this path in" stays one definition. */
export function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

/** From a basename-index bucket (paths sharing a lowercased basename), keep
    only entries whose full path case-insensitively equals or ends with
    "/<target>" — i.e. `target` names a real suffix of the path, not just a
    same-named file in an unrelated tree. Shared by Java FQCN resolution and
    Markdown doc-link-by-name resolution, which both reduce a basename-index
    hit list to unambiguous path-suffix matches the same way. */
export function matchBySuffix(candidates: readonly string[], target: string): string[] {
  const targetLower = target.toLowerCase();
  const suffix = `/${targetLower}`;
  return candidates.filter((p) => {
    const lower = p.toLowerCase();
    return lower === targetLower || lower.endsWith(suffix);
  });
}

/** Collapse "a/b/../c" and "./" segments against a base dir without touching
    the filesystem. Returns null when the path climbs above the workspace root
    (a leading ".." with nothing left to pop). Shared by every specifier
    resolver and the tsconfig alias layer. */
export function joinPosix(base: string, rel: string): string | null {
  const parts = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null; // escapes the workspace
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
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

function stripClusterCommunitySuffix(dir: string): string {
  return dir.replace(/#\d+$/, "");
}

function sharedDirDepth(a: string, b: string): number {
  const aSegs = a.split("/").filter(Boolean);
  const bSegs = b.split("/").filter(Boolean);
  const limit = Math.min(aSegs.length, bSegs.length);
  let depth = 0;
  while (depth < limit && aSegs[depth] === bSegs[depth]) depth += 1;
  return depth;
}

/** Best-effort cluster assignment for a newly added file during incremental
    indexing. Full rebuilds use assignClusters() across the whole graph; the
    incremental path doesn't have that luxury, so it picks the most specific
    existing cluster that shares the deepest directory prefix with the file.
    This keeps new files inside the right neighborhood instead of snapping
    back to the coarse 2-segment clusterDir() fallback until the next rebuild. */
export function incrementalClusterDir(relPath: string, clusterCounts: ReadonlyMap<string, number>): string {
  const normalized = normalizeGraphPath(relPath);
  const parent = dirOf(normalized);
  const fallback = clusterDir(normalized);
  if (!parent) return fallback;

  let bestDir: string | null = null;
  let bestSharedDepth = 0;
  let bestIsPrefix = false;
  let bestCount = -1;
  for (const [dir, count] of clusterCounts) {
    const base = stripClusterCommunitySuffix(dir);
    if (!base || base === ".") continue;
    const sharedDepth = sharedDirDepth(parent, base);
    if (sharedDepth === 0) continue;
    const isPrefix = parent === base || parent.startsWith(`${base}/`);
    if (
      sharedDepth > bestSharedDepth
      || (sharedDepth === bestSharedDepth && Number(isPrefix) > Number(bestIsPrefix))
      || (sharedDepth === bestSharedDepth && isPrefix === bestIsPrefix && count > bestCount)
      || (sharedDepth === bestSharedDepth && isPrefix === bestIsPrefix && count === bestCount && dir < (bestDir ?? "\uffff"))
    ) {
      bestDir = dir;
      bestSharedDepth = sharedDepth;
      bestIsPrefix = isPrefix;
      bestCount = count;
    }
  }
  return bestDir ?? fallback;
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

/** Deterministic, bounded-cost grouping of `bucket` by import-graph
    community (label propagation, undirected, restricted to edges within the
    bucket) — the fallback assignClusters() reaches for once a cluster is
    oversized but has no deeper path segment left to split by (e.g. hundreds
    of files sitting flat in one folder, a common monorepo package layout).
    Runs only on the oversized bucket itself, not the whole graph, so cost
    stays proportional to that one folder's size even on a 15k+ file
    workspace. Falls back to plain alphabetical chunking for members with no
    within-bucket edges (nothing for label propagation to group by) and for
    any resulting community still over `maxClusterSize` (one large connected
    component, or many singletons) — always returns chunks no bigger than
    maxClusterSize, so the caller never has to re-check the result. */
function splitByImportCommunity(
  bucket: readonly string[],
  edgesByFrom: ReadonlyMap<string, readonly string[]>,
  maxClusterSize: number,
): string[][] {
  const bucketSet = new Set(bucket);
  const neighbors = new Map<string, string[]>();
  for (const p of bucket) neighbors.set(p, []);
  for (const p of bucket) {
    for (const to of edgesByFrom.get(p) ?? []) {
      if (!bucketSet.has(to) || to === p) continue;
      neighbors.get(p)!.push(to);
      neighbors.get(to)!.push(p); // undirected — grouping cares who's connected, not the import direction
    }
  }

  const label = new Map<string, string>();
  for (const p of bucket) label.set(p, p);
  const order = [...bucket].sort(); // deterministic iteration order — never randomized, so a rebuild is stable
  const MAX_LABEL_ITERATIONS = 5;
  for (let iter = 0; iter < MAX_LABEL_ITERATIONS; iter += 1) {
    let changed = false;
    for (const p of order) {
      const ns = neighbors.get(p)!;
      if (ns.length === 0) continue;
      const counts = new Map<string, number>();
      for (const n of ns) counts.set(label.get(n)!, (counts.get(label.get(n)!) ?? 0) + 1);
      // Linear argmax, not a sort — deterministic tie-break (smallest label
      // wins) needs only a plain string comparison against the current best,
      // not a full sort of every candidate on every node on every iteration.
      let best = label.get(p)!;
      let bestCount = 0;
      for (const [candidate, count] of counts) {
        if (count > bestCount || (count === bestCount && candidate < best)) { best = candidate; bestCount = count; }
      }
      if (best !== label.get(p)) { label.set(p, best); changed = true; }
    }
    if (!changed) break;
  }

  const communities = new Map<string, string[]>();
  for (const p of bucket) {
    const l = label.get(p)!;
    const list = communities.get(l);
    if (list) list.push(p);
    else communities.set(l, [p]);
  }

  /* Pack communities into chunks no bigger than maxClusterSize: biggest
     first, so a large connected component claims its own chunk while small
     communities (including import-less singletons) fill in behind it
     instead of each becoming its own one-file "cluster". */
  const sortedCommunities = [...communities.values()].sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  const chunks: string[][] = [];
  for (const community of sortedCommunities) {
    if (community.length > maxClusterSize) {
      const sorted = [...community].sort();
      for (let i = 0; i < sorted.length; i += maxClusterSize) chunks.push(sorted.slice(i, i + maxClusterSize));
      continue;
    }
    const fit = chunks.find((c) => c.length + community.length <= maxClusterSize);
    if (fit) fit.push(...community);
    else chunks.push([...community]);
  }
  return chunks;
}

/** Adaptive cluster assignment for a full file set: starts every path at
    clusterDir()'s 2-segment default, then recursively splits any cluster
    bigger than maxClusterSize one segment deeper — so a single top-level
    package with thousands of files across dozens of subdirectories doesn't
    render as one giant same-color blob while everything else on the map is
    finely divided. Stops splitting a cluster once its members are out of
    directory segments to add (nothing left to distinguish them by) or
    maxDepth is reached — at that point, if the caller supplied the import
    graph (`edgesByFrom`), an oversized flat cluster gets one more pass split
    by import-graph community instead of settling as one blob (see
    splitByImportCommunity). Pure function of the whole set, not a single
    path — run it once per full rebuild, not per incremental add. */
export function assignClusters(
  paths: readonly string[],
  maxClusterSize = 40,
  maxDepth = 6,
  edgesByFrom?: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();

  function settle(bucket: readonly string[], depth: number): void {
    for (const p of bucket) result.set(p, clusterKeyAtDepth(p, depth));
  }

  /** Out of path-based options (either every member is at its full path
      depth already, or maxDepth itself was reached) but still oversized —
      try the import-graph fallback before giving up. Both "give up" branches
      in split() route through here so neither one silently skips it. */
  function settleOrSplitByImports(bucket: readonly string[], depth: number): void {
    if (edgesByFrom && bucket.length > maxClusterSize) {
      const baseKey = clusterKeyAtDepth(bucket[0]!, depth);
      const chunks = splitByImportCommunity(bucket, edgesByFrom, maxClusterSize);
      chunks.forEach((chunk, i) => {
        const key = chunks.length > 1 ? `${baseKey}#${i}` : baseKey;
        for (const p of chunk) result.set(p, key);
      });
      return;
    }
    /* No edge data, or nothing to split by — settle here even though oversized. */
    settle(bucket, depth);
  }

  function split(bucket: readonly string[], depth: number): void {
    if (bucket.length <= maxClusterSize) {
      settle(bucket, depth); // genuinely small enough — no fallback needed
      return;
    }
    if (depth >= maxDepth) {
      settleOrSplitByImports(bucket, depth); // oversized, but out of depth budget
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
      settleOrSplitByImports(bucket, depth); // out of path segments to split by
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
