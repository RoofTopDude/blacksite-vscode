/* Two-level territory model for the Codebase Map. A "neighborhood" is a distinct
   codebase — a project/solution/workspace root — that should render as its own
   separated region; within it, the existing purpose clusters (node.dir) become
   subdivisions. Hybrid basis: manifest-derived project roots where present, top
   path segment otherwise. Pure (no vscode/fs) so the indexer, layout, and unit
   tests share one definition. */

import { normalizeGraphPath } from "./graph-model.js";
import type { ProjectTopology } from "./project-topology.js";

/** Below this many distinct codebases the map stays flat unless the workspace is
    also large — territorial layout is overhead a small single/dual-codebase repo
    doesn't need (matches the "only for exceedingly large/complex projects" ask). */
const TERRITORY_MIN_NEIGHBORHOODS_ALWAYS = 4;
const TERRITORY_MIN_NEIGHBORHOODS_LARGE = 2;
const TERRITORY_MIN_FILES = 600;

/** Candidate neighborhood roots from topology: a project's solution/workspace
    container when it has one (so sibling projects of one .sln / monorepo share a
    territory), else the project's own root. */
export function neighborhoodRoots(topology: ProjectTopology | null | undefined): string[] {
  const roots = new Set<string>();
  for (const project of topology?.projects ?? []) {
    const container = project.containerRoot && project.containerRoot !== "." ? project.containerRoot : project.root;
    const normalized = normalizeGraphPath(container);
    if (normalized && normalized !== ".") roots.add(normalized);
  }
  return [...roots];
}

function longestPrefixRoot(id: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if ((id === root || id.startsWith(`${root}/`)) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

/** Fallback neighborhood for a file with no owning project: its top path segment
    — the coarsest codebase boundary directory structure offers. */
function fallbackNeighborhood(id: string): string {
  const segments = normalizeGraphPath(id).split("/").filter(Boolean);
  return segments.length <= 1 ? "." : segments[0]!;
}

/** Rounds of affinity propagation. Owned files never move, so this only bounds
    how far an owned neighborhood can reach across chains of unowned files
    (docs → helper → owned code). A handful of passes settles any real repo. */
const AFFINITY_ITERATIONS = 6;

/** Assign each node id a neighborhood root. Topology container/project roots win
    by longest-prefix match (manifests where present). Files under no project are
    pulled — by import affinity, when `edges` is supplied — into the codebase they
    actually connect to; only files with no path to an owned neighborhood keep
    the coarse top-path-segment fallback. */
export function assignNeighborhoods(
  ids: readonly string[],
  topology: ProjectTopology | null | undefined,
  edges?: ReadonlyMap<string, readonly string[]>,
): Map<string, string> {
  const roots = neighborhoodRoots(topology).sort((a, b) => b.length - a.length);
  const out = new Map<string, string>();
  const unowned: string[] = [];
  const owned = new Set<string>(); // the neighborhood values that come from topology, not fallback
  for (const id of ids) {
    const normalized = normalizeGraphPath(id);
    const root = longestPrefixRoot(normalized, roots);
    if (root) {
      out.set(id, root);
      owned.add(root);
    } else {
      out.set(id, fallbackNeighborhood(normalized));
      unowned.push(id);
    }
  }
  if (edges && unowned.length > 0 && owned.size > 0) applyImportAffinity(out, unowned, owned, edges);
  return out;
}

/** Label-propagation over the undirected import graph, seeded by the fixed owned
    assignments. An unowned file adopts the owned neighborhood the majority of its
    import neighbors belong to; nothing else moves, so loose files are pulled into
    real codebases without ever inventing a merge between two fallback buckets. */
function applyImportAffinity(
  assignment: Map<string, string>,
  unowned: readonly string[],
  owned: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly string[]>,
): void {
  const ids = new Set(assignment.keys());
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
  };
  for (const [from, tos] of edges) {
    const f = normalizeGraphPath(from);
    if (!ids.has(f)) continue;
    for (const rawTo of tos) {
      const t = normalizeGraphPath(rawTo);
      if (t === f || !ids.has(t)) continue;
      link(f, t);
      link(t, f);
    }
  }

  const order = [...unowned].sort(); // deterministic — a rebuild is stable
  for (let iter = 0; iter < AFFINITY_ITERATIONS; iter += 1) {
    let changed = false;
    for (const id of order) {
      const votes = new Map<string, number>();
      for (const neighbor of neighbors.get(id) ?? []) {
        const label = assignment.get(neighbor);
        if (label && owned.has(label)) votes.set(label, (votes.get(label) ?? 0) + 1);
      }
      if (votes.size === 0) continue; // no owned neighborhood in reach — keep the segment fallback
      let best = "";
      let bestCount = 0;
      for (const [label, count] of votes) {
        if (count > bestCount || (count === bestCount && label < best)) { best = label; bestCount = count; }
      }
      if (best && best !== assignment.get(id)) { assignment.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
}

/** Distinct codebase territories in an assignment, excluding the loose "." /
    root bucket (which isn't a codebase). */
export function distinctNeighborhoods(neighborhoods: ReadonlyMap<string, string>): Set<string> {
  const out = new Set(neighborhoods.values());
  out.delete(".");
  return out;
}

/** Adaptive activation for the "auto" mode: territorialize only when the
    workspace is genuinely multi-codebase (4+ territories) or a sizable
    multi-codebase repo (2-3 territories over the file threshold). */
export function shouldTerritorialize(neighborhoods: ReadonlyMap<string, string>, nodeCount: number): boolean {
  const distinct = distinctNeighborhoods(neighborhoods).size;
  if (distinct >= TERRITORY_MIN_NEIGHBORHOODS_ALWAYS) return true;
  return distinct >= TERRITORY_MIN_NEIGHBORHOODS_LARGE && nodeCount >= TERRITORY_MIN_FILES;
}

const GENERIC_SEGMENTS = new Set(["src", "main", "app", "apps", "packages", "services", "lib", "libs", "develop", "master"]);

/** Human-facing name for a neighborhood root: its most specific non-generic
    trailing path segment (e.g. ".../Dev Portal Repo/Main/q2-portal-develop"
    reads as "q2-portal-develop", not "develop"). */
export function neighborhoodLabel(root: string): string {
  if (!root || root === ".") return "workspace";
  const segments = normalizeGraphPath(root).split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!GENERIC_SEGMENTS.has(segments[i]!.toLowerCase())) return segments[i]!;
  }
  return segments[segments.length - 1] ?? root;
}
