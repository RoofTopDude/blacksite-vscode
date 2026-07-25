/* Pure query layer over the Codebase Map's indexed adjacency: transitive impact
   (blast radius), bounded route enumeration between two files, and filtered node
   search. No vscode/fs imports — GraphAgentGateway feeds it the already-computed
   edge sets and this module answers the questions the one-hop map_relationships
   view can't.

   ── Dependency direction ────────────────────────────────────────────────────
   Everything here normalizes to ONE convention: an adjacency entry `A -> B`
   means "A depends on B". Getting there needs per-layer care, because the raw
   edge sets do not all point the same way:

   - import edges  (from imports to)                     → already A depends on B.
   - service edges (sourcePath calls/publishes/reads to
                    targetPath)                          → already A depends on B.
   - symbol `call` / `supertype`                         → already A depends on B
                                                           (outgoing calls, supertypes
                                                           of a local symbol).
   - symbol `reference`                                  → REVERSED. symbol-indexer
                                                           records "who references MY
                                                           symbol", so `to` is the
                                                           referencing file and it is
                                                           `to` that depends on `from`.
   - note edges                                          → descriptive, not a real
                                                           dependency; carried as an
                                                           undirected hint and only
                                                           when the caller opts in.

   Collapsing that inconsistency here — rather than in each caller — is the whole
   point of the module: a traversal that mixes layers must not silently walk half
   its edges backwards. */

import type { EdgeKind, GraphEdge, GraphNode } from "./graph-model.js";

/** Which indexed relationship layer a link came from. */
export type MapLayer = "import" | "service" | "symbol" | "note";

export const MAP_LAYERS: readonly MapLayer[] = ["import", "service", "symbol", "note"];

/** One directed dependency link between two files, already normalized so the
    owning adjacency bucket means "depends on" / "depended on by". */
export interface MapLink {
  /** The peer file id (the other end of the link, relative to its bucket key). */
  peer: string;
  kind: EdgeKind;
  layer: MapLayer;
  label?: string;
  confidence?: number;
}

export interface MapAdjacency {
  /** file id → files it depends on. */
  dependsOn: ReadonlyMap<string, MapLink[]>;
  /** file id → files that depend on it. */
  dependedOnBy: ReadonlyMap<string, MapLink[]>;
  /** Every file id that participates in at least one link. */
  ids: ReadonlySet<string>;
}

export interface AdjacencyInput {
  importEdges?: readonly GraphEdge[];
  serviceEdges?: readonly GraphEdge[];
  symbolEdges?: readonly GraphEdge[];
  /** Edge-scoped map notes, as {from,to} pairs. */
  noteEdges?: readonly { from: string; to?: string; kind?: string; title?: string }[];
  /** Layers to include; defaults to import + service + symbol (notes off — they
      are human annotations, not mechanical dependencies). */
  layers?: readonly MapLayer[];
}

const DEFAULT_LAYERS: readonly MapLayer[] = ["import", "service", "symbol"];

/**
 * Fold the indexed edge layers into one direction-normalized adjacency.
 *
 * Parallel links between the same pair are kept (a file pair can be joined by an
 * import AND an API call AND a note); callers that only need reachability read
 * the first entry, callers explaining a route read them all.
 */
export function buildAdjacency(input: AdjacencyInput): MapAdjacency {
  const layers = new Set(input.layers ?? DEFAULT_LAYERS);
  const dependsOn = new Map<string, MapLink[]>();
  const dependedOnBy = new Map<string, MapLink[]>();
  const ids = new Set<string>();

  const link = (dependent: string, dependency: string, kind: EdgeKind, layer: MapLayer, label?: string, confidence?: number): void => {
    if (!dependent || !dependency || dependent === dependency) return;
    ids.add(dependent);
    ids.add(dependency);
    push(dependsOn, dependent, { peer: dependency, kind, layer, label, confidence });
    push(dependedOnBy, dependency, { peer: dependent, kind, layer, label, confidence });
  };

  if (layers.has("import")) {
    for (const edge of input.importEdges ?? []) link(edge.from, edge.to, edge.kind, "import", edge.label);
  }

  if (layers.has("service")) {
    for (const edge of input.serviceEdges ?? []) {
      /* Service edges are file-anchored (sourcePath/targetPath) with the
         service pair carried alongside; an edge without both file anchors
         can't take part in a file-level traversal. */
      const from = edge.sourcePath;
      const to = edge.targetPath;
      if (!from || !to) continue;
      link(from, to, edge.kind, "service", edge.label, edge.confidence);
    }
  }

  if (layers.has("symbol")) {
    for (const edge of input.symbolEdges ?? []) {
      // See the header: `reference` is recorded definition→referencer, i.e. backwards.
      if (edge.kind === "reference") link(edge.to, edge.from, edge.kind, "symbol", edge.label);
      else link(edge.from, edge.to, edge.kind, "symbol", edge.label);
    }
  }

  if (layers.has("note")) {
    for (const note of input.noteEdges ?? []) {
      if (!note.to) continue;
      /* A note is a human/agent assertion of a relation, not a proven dependency.
         Register it both ways so it can bridge a traversal without claiming a
         direction the note never established. */
      link(note.from, note.to, "ai", "note", note.title);
      link(note.to, note.from, "ai", "note", note.title);
    }
  }

  return { dependsOn, dependedOnBy, ids };
}

function push(map: Map<string, MapLink[]>, key: string, value: MapLink): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ── Transitive impact ────────────────────────────────────────────────────────

/** Which way to walk from the seeds. */
export type ImpactDirection = "dependents" | "dependencies" | "both";

export interface PathStep {
  from: string;
  to: string;
  kind: EdgeKind;
  layer: MapLayer;
  label?: string;
  /** Every kind linking this pair, when the two files are joined by more than
      one (e.g. an import AND an API call). Set only by route enumeration, which
      collapses parallel links into one hop — otherwise the same node path would
      come back several times and eat the route budget saying nothing new. */
  kinds?: EdgeKind[];
}

export interface ImpactHit {
  id: string;
  /** Hops from the nearest seed (seeds themselves are depth 0 and not returned). */
  depth: number;
  /** The seed this file was first reached from. */
  seed: string;
  /** Which way it sits relative to that seed. */
  relation: "dependent" | "dependency";
  /** Shortest chain between the seed and this file, one step per hop, ordered so
      it reads along the dependency arrows: a dependency chain runs seed → … → id,
      a dependent chain runs id → … → seed. */
  via: PathStep[];
}

export interface ImpactOptions {
  direction: ImpactDirection;
  maxDepth: number;
  /** Stop expanding once this many distinct files have been reached. */
  maxNodes: number;
}

export interface ImpactResult {
  hits: ImpactHit[];
  /** True when maxNodes cut the frontier off before it was exhausted. */
  truncated: boolean;
}

/**
 * Breadth-first closure from `seeds`, recording each reached file once at its
 * shortest depth along with the concrete edge chain that got there.
 *
 * Multi-seed traversal runs as a single frontier rather than one BFS per seed:
 * a file reachable from two seeds is reported once, attributed to the nearer
 * one, which is what a caller sizing "the blast radius of this change set"
 * actually wants — not N overlapping radii it has to merge itself.
 */
export function traverseImpact(
  adjacency: MapAdjacency,
  seeds: readonly string[],
  options: ImpactOptions,
): ImpactResult {
  const maxDepth = Math.max(1, Math.floor(options.maxDepth));
  const maxNodes = Math.max(1, Math.floor(options.maxNodes));
  const seedSet = new Set(seeds);
  const seen = new Map<string, ImpactHit>();
  let truncated = false;

  const directions: Array<{ bucket: ReadonlyMap<string, MapLink[]>; relation: "dependent" | "dependency" }> = [];
  if (options.direction === "dependents" || options.direction === "both") {
    directions.push({ bucket: adjacency.dependedOnBy, relation: "dependent" });
  }
  if (options.direction === "dependencies" || options.direction === "both") {
    directions.push({ bucket: adjacency.dependsOn, relation: "dependency" });
  }

  for (const { bucket, relation } of directions) {
    let frontier: Array<{ id: string; seed: string; via: PathStep[] }> = seeds.map((seed) => ({ seed, id: seed, via: [] }));
    const visited = new Set(seedSet);
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: Array<{ id: string; seed: string; via: PathStep[] }> = [];
      for (const current of frontier) {
        for (const link of bucket.get(current.id) ?? []) {
          if (visited.has(link.peer)) continue;
          if (seen.size >= maxNodes) { truncated = true; break; }
          visited.add(link.peer);
          /* Direction of the *edge* as it exists in the graph, so the chain
             reads correctly whichever way the traversal walked it. */
          const step: PathStep = relation === "dependent"
            ? { from: link.peer, to: current.id, kind: link.kind, layer: link.layer, label: link.label }
            : { from: current.id, to: link.peer, kind: link.kind, layer: link.layer, label: link.label };
          const via = [...current.via, step];
          /* Dependent chains are discovered seed-outward but read best
             outward-in (the far dependent, through the middle, down to the
             seed) — that's the order the arrows already point. */
          const hit: ImpactHit = {
            id: link.peer,
            depth,
            seed: current.seed,
            relation,
            via: relation === "dependent" ? [...via].reverse() : via,
          };
          const existing = seen.get(link.peer);
          if (!existing || existing.depth > depth) seen.set(link.peer, hit);
          next.push({ id: link.peer, seed: current.seed, via });
        }
        if (truncated) break;
      }
      if (truncated) break;
      frontier = next;
    }
  }

  const hits = [...seen.values()].sort(
    (left, right) => left.depth - right.depth || left.id.localeCompare(right.id),
  );
  return { hits, truncated };
}

// ── Routes between two files ─────────────────────────────────────────────────

export interface Route {
  hops: number;
  path: string[];
  steps: PathStep[];
}

export interface RouteOptions {
  maxHops: number;
  maxRoutes: number;
  /** Follow links in both directions (default true) — "how are these connected"
      is usually a question about relatedness, not strict dependency flow. */
  undirected?: boolean;
  /** Hard ceiling on partial paths expanded, so a hub-dense graph can't turn a
      route query into an exponential walk. */
  maxExpansions?: number;
}

export interface RouteResult {
  routes: Route[];
  /** True when the expansion ceiling stopped the search before it was exhausted. */
  truncated: boolean;
}

/**
 * Enumerate up to `maxRoutes` shortest simple paths from `from` to `to`.
 *
 * Breadth-first over partial paths (not nodes), so results come out in
 * increasing hop count and the first one returned is a genuine shortest path.
 * Each partial path carries its own visited set — the same node may appear in
 * two different routes, just never twice within one.
 */
export function findRoutes(
  adjacency: MapAdjacency,
  from: string,
  to: string,
  options: RouteOptions,
): RouteResult {
  const maxHops = Math.max(1, Math.floor(options.maxHops));
  const maxRoutes = Math.max(1, Math.floor(options.maxRoutes));
  const maxExpansions = Math.max(1, Math.floor(options.maxExpansions ?? 40_000));
  const undirected = options.undirected !== false;
  if (from === to) return { routes: [], truncated: false };

  /* One step per distinct peer, merging parallel links. Two files joined by both
     an import and an API call are one hop that happens to have two kinds — not
     two routes through the same nodes. */
  const neighbors = (id: string): PathStep[] => {
    const byPeer = new Map<string, PathStep>();
    const consider = (peer: string, step: PathStep, kind: EdgeKind): void => {
      const existing = byPeer.get(peer);
      if (!existing) { byPeer.set(peer, step); return; }
      const kinds = existing.kinds ?? [existing.kind];
      if (!kinds.includes(kind)) existing.kinds = [...kinds, kind];
    };
    for (const link of adjacency.dependsOn.get(id) ?? []) {
      consider(link.peer, { from: id, to: link.peer, kind: link.kind, layer: link.layer, label: link.label }, link.kind);
    }
    if (undirected) {
      for (const link of adjacency.dependedOnBy.get(id) ?? []) {
        consider(link.peer, { from: link.peer, to: id, kind: link.kind, layer: link.layer, label: link.label }, link.kind);
      }
    }
    return [...byPeer.values()];
  };

  const routes: Route[] = [];
  let expansions = 0;
  let truncated = false;
  let frontier: Array<{ id: string; path: string[]; steps: PathStep[]; visited: Set<string> }> = [
    { id: from, path: [from], steps: [], visited: new Set([from]) },
  ];

  for (let hop = 1; hop <= maxHops && frontier.length > 0 && routes.length < maxRoutes; hop += 1) {
    const next: typeof frontier = [];
    for (const partial of frontier) {
      for (const step of neighbors(partial.id)) {
        const peer = step.from === partial.id ? step.to : step.from;
        if (partial.visited.has(peer)) continue;
        expansions += 1;
        if (expansions > maxExpansions) { truncated = true; break; }
        const path = [...partial.path, peer];
        const steps = [...partial.steps, step];
        if (peer === to) {
          routes.push({ hops: hop, path, steps });
          if (routes.length >= maxRoutes) break;
          continue; // a shortest simple path never continues through its own target
        }
        const visited = new Set(partial.visited);
        visited.add(peer);
        next.push({ id: peer, path, steps, visited });
      }
      if (truncated || routes.length >= maxRoutes) break;
    }
    if (truncated) break;
    frontier = next;
  }

  return { routes, truncated };
}

// ── Node search ──────────────────────────────────────────────────────────────

export type NodeSortKey = "degree" | "dependents" | "dependencies" | "churn" | "recency" | "size" | "path";

export interface NodeFilter {
  /** Keep files under this directory prefix (matched on path segments). */
  area?: string;
  /** Keep files whose id contains this (case-insensitive). */
  contains?: string;
  /** Keep files whose id matches this glob (`*`, `**`, `?`). */
  glob?: string;
  /** Keep files in any of these language buckets. */
  langs?: readonly string[];
  minDegree?: number;
  /** Keep only files touched by at least this many commits in the git window. */
  minChurn?: number;
  sortBy?: NodeSortKey;
  limit?: number;
}

export interface NodeHit {
  path: string;
  area: string;
  lang: string;
  dependents: number;
  dependencies: number;
  sizeBytes: number;
  churn?: number;
  lastCommitAt?: number;
}

export interface NodeSearchResult {
  files: NodeHit[];
  /** How many files passed the filter before `limit` was applied. */
  matched: number;
}

/**
 * Filter and rank indexed map nodes — the drill-down map_overview's ranked
 * summaries can't give you ("which files are actually in this area", "what has
 * churned most under src/graph", "every Python file with no dependents").
 */
export function findNodes(nodes: readonly GraphNode[], filter: NodeFilter): NodeSearchResult {
  const area = filter.area ? normalizeArea(filter.area) : "";
  const contains = filter.contains?.toLowerCase() ?? "";
  const globRe = filter.glob ? globToRegExp(filter.glob) : null;
  const langs = filter.langs && filter.langs.length > 0 ? new Set(filter.langs.map((l) => l.toLowerCase())) : null;
  const minDegree = Math.max(0, Math.floor(filter.minDegree ?? 0));
  const minChurn = Math.max(0, Math.floor(filter.minChurn ?? 0));

  const matches = nodes.filter((node) => {
    if (area && !(node.id === area || node.id.startsWith(`${area}/`))) return false;
    if (contains && !node.id.toLowerCase().includes(contains)) return false;
    if (globRe && !globRe.test(node.id)) return false;
    if (langs && !langs.has((node.lang ?? "").toLowerCase())) return false;
    if (node.inDegree + node.outDegree < minDegree) return false;
    if (minChurn > 0 && (node.churn ?? 0) < minChurn) return false;
    return true;
  });

  const sorted = [...matches].sort(comparatorFor(filter.sortBy ?? "degree"));
  const limit = Math.max(1, Math.floor(filter.limit ?? 50));
  return {
    matched: matches.length,
    files: sorted.slice(0, limit).map((node) => ({
      path: node.id,
      area: node.neighborhood ?? node.dir,
      lang: node.lang,
      dependents: node.inDegree,
      dependencies: node.outDegree,
      sizeBytes: node.sizeBytes,
      ...(node.churn === undefined ? {} : { churn: node.churn }),
      ...(node.lastCommitAt === undefined ? {} : { lastCommitAt: node.lastCommitAt }),
    })),
  };
}

function comparatorFor(key: NodeSortKey): (left: GraphNode, right: GraphNode) => number {
  const byPath = (left: GraphNode, right: GraphNode) => left.id.localeCompare(right.id);
  switch (key) {
    case "dependents": return (l, r) => r.inDegree - l.inDegree || byPath(l, r);
    case "dependencies": return (l, r) => r.outDegree - l.outDegree || byPath(l, r);
    case "churn": return (l, r) => (r.churn ?? 0) - (l.churn ?? 0) || byPath(l, r);
    case "recency": return (l, r) => (r.lastCommitAt ?? 0) - (l.lastCommitAt ?? 0) || byPath(l, r);
    case "size": return (l, r) => r.sizeBytes - l.sizeBytes || byPath(l, r);
    case "path": return byPath;
    case "degree":
    default: return (l, r) => (r.inDegree + r.outDegree) - (l.inDegree + l.outDegree) || byPath(l, r);
  }
}

function normalizeArea(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/** Minimal glob → RegExp for map node ids: `**` spans separators, `*` and `?`
    do not. Everything else is escaped literally. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  const normalized = pattern.trim().replace(/\\/g, "/");
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (normalized[i + 1] === "/") i += 1; // "**/" also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

// ── Summaries ────────────────────────────────────────────────────────────────

/** Group reached files by area so a large blast radius reads as "which parts of
    the system this touches" instead of a flat path list. */
export function summarizeByArea(
  hits: readonly { id: string }[],
  areaOf: (id: string) => string,
  limit = 12,
): Array<{ area: string; files: number }> {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    const area = areaOf(hit.id);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts]
    .map(([area, files]) => ({ area, files }))
    .sort((left, right) => right.files - left.files || left.area.localeCompare(right.area))
    .slice(0, limit);
}
