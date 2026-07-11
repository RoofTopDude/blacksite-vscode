/* Pure, seeded force layout for the Codebase Map. Runs in the extension host
   (never the webview): the simulation is deterministic for a given seed, so
   unit tests can assert positions and incremental re-indexes can pin survivors.
   The indexer drives ticks in chunks via createLayout().tick() to stay
   responsive; computeLayout() runs to completion for tests and small graphs. */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode } from "./graph-model.js";
import {
  buildProjectReferenceMap,
  owningProjectForPath,
  shareContainer,
  type ProjectTopology,
} from "./project-topology.js";

export interface LayoutOptions {
  seed: number;
  /** Positions from a previous layout; matching nodes start (and stay) there. */
  prevPositions?: ReadonlyMap<string, { x: number; y: number }>;
  /** Pin nodes present in prevPositions instead of just seeding them. */
  pinPrevious?: boolean;
  /** Host-only project topology that tightens related project neighborhoods. */
  topology?: ProjectTopology | null;
  /** nodeId → neighborhood (codebase territory). When present (and ≥2 distinct),
      the layout territorializes: each codebase gets its own separated region and
      cross-codebase imports don't pull territories together. Omitted = the flat
      layout. See graph/neighborhoods.ts. */
  neighborhoods?: ReadonlyMap<string, string>;
}

export interface LayoutHandle {
  /** Advance up to `count` ticks; returns false once converged/finished. */
  tick(count: number): boolean;
  positions(): Map<string, { x: number; y: number }>;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  dir: string;
  degree: number;
}

interface ClusterSimNode extends SimulationNodeDatum {
  id: string;
  count: number;
  anchorX: number;
  anchorY: number;
}

interface ClusterLink extends SimulationLinkDatum<ClusterSimNode> {
  weight: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const NODE_COLLISION_BASE_RADIUS = 14;
const NODE_COLLISION_DEGREE_SCALE = 2.6;
const NODE_COLLISION_DEGREE_CAP = 18;
const NODE_COLLISION_ITERATIONS = 2;
const DEFAULT_CLUSTER_SPACING = 42;
const DEFAULT_WORLD_PADDING = 150;

/** Radius used by both d3's collision force and the large-graph packer. Exported
    so scale tests can assert the packer's no-overlap contract without copying a
    second, inevitably-drifting radius formula. */
export function layoutNodeCollisionRadius(degree: number): number {
  return NODE_COLLISION_BASE_RADIUS + Math.min(NODE_COLLISION_DEGREE_CAP, Math.sqrt(Math.max(1, degree + 1)) * NODE_COLLISION_DEGREE_SCALE);
}

/** Degree-aware import spring strength. A uniform spring makes every spoke of
    a large hub pull at full force, collapsing a many-to-many core into one
    tight knot. Scaling by the busier endpoint keeps ordinary file pairs close
    while letting high-degree architecture hubs claim enough visual space for
    their neighborhoods to remain separable. */
export function importLinkStrength(sourceDegree: number, targetDegree: number): number {
  const busiest = Math.max(1, sourceDegree, targetDegree);
  return Math.max(0.018, Math.min(0.13, 0.18 / Math.sqrt(busiest + 1)));
}

/** Companion distance for the degree-aware spring. Hub spokes need more room
    than leaf-to-leaf links, but the logarithmic cap prevents a single extreme
    barrel file from inflating the whole world. */
export function importLinkDistance(sourceDegree: number, targetDegree: number): number {
  const busiest = Math.max(1, sourceDegree, targetDegree);
  return 70 + Math.min(72, Math.log2(busiest + 1) * 11);
}

/** Deterministic PRNG (mulberry32) so d3-force jitter is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arrange cluster centroids on a golden-angle spiral, larger clusters closer
    to the middle so hub folders anchor the map. Packing is area-proportional:
    each cluster's spiral radius grows with the cumulative node count placed so
    far, so the whole world spans ~O(sqrt(totalNodes)) regardless of how many
    clusters there are. (The old uniform `spacing * sqrt(i)` spread blew the
    world up to tens of thousands of units on big multi-cluster projects,
    which is what made the map look like 1-2 dots at minimum zoom.) */
function baseClusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  spacingPerNode = DEFAULT_CLUSTER_SPACING,
): Map<string, { x: number; y: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.dir, (counts.get(node.dir) ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const centroids = new Map<string, { x: number; y: number }>();
  let cumulative = 0;
  entries.forEach(([dir, count], i) => {
    const radius = i === 0 ? 0 : spacingPerNode * Math.sqrt(cumulative + count / 2);
    const angle = i * GOLDEN_ANGLE;
    centroids.set(dir, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    cumulative += count;
  });
  return centroids;
}

function addClusterWeight(weights: Map<string, number>, fromDir: string, toDir: string, weight: number): void {
  if (!fromDir || !toDir || fromDir === toDir || weight <= 0) return;
  const a = fromDir < toDir ? fromDir : toDir;
  const b = fromDir < toDir ? toDir : fromDir;
  const key = `${a}\u0000${b}`;
  weights.set(key, (weights.get(key) ?? 0) + weight);
}

function clusterGraphLinks(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[],
  topology?: ProjectTopology | null,
): ClusterLink[] {
  const dirById = new Map(nodes.map((node) => [node.id, node.dir]));
  const weights = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const fromDir = dirById.get(edge.from);
    const toDir = dirById.get(edge.to);
    if (!fromDir || !toDir) continue;
    addClusterWeight(weights, fromDir, toDir, 1);
  }

  if (topology) {
    const projectRefs = buildProjectReferenceMap(topology);
    const projectByRoot = new Map(topology.projects.map((project) => [project.root, project]));
    const clustersByProject = new Map<string, Set<string>>();
    for (const node of nodes) {
      const project = owningProjectForPath(topology, node.id);
      if (!project) continue;
      const clusters = clustersByProject.get(project.root) ?? new Set<string>();
      clusters.add(node.dir);
      clustersByProject.set(project.root, clusters);
    }

    for (const [projectRoot, clusters] of clustersByProject) {
      const clusterList = [...clusters].sort();
      if (clusterList.length < 2) continue;
      const pairWeight = 3 / Math.max(1, clusterList.length - 1);
      for (let i = 0; i < clusterList.length; i += 1) {
        for (let j = i + 1; j < clusterList.length; j += 1) {
          addClusterWeight(weights, clusterList[i]!, clusterList[j]!, pairWeight);
        }
      }
      /* Explicit project references should pull sibling project clusters into
         the same neighborhood more strongly than sparse file-import density.
         Normalize by cluster fan-out so a big multi-cluster project does not
         overwhelm the whole world. */
      for (const targetRoot of projectRefs.get(projectRoot) ?? []) {
        const targetClusters = clustersByProject.get(targetRoot);
        if (!targetClusters || targetClusters.size === 0) continue;
        const sourceProject = projectByRoot.get(projectRoot) ?? null;
        const targetProject = projectByRoot.get(targetRoot) ?? null;
        const baseWeight = shareContainer(sourceProject, targetProject) ? 20 : 14;
        const pairScale = Math.sqrt(Math.max(1, clusterList.length * targetClusters.size));
        for (const fromDir of clusterList) {
          for (const toDir of targetClusters) addClusterWeight(weights, fromDir, toDir, baseWeight / pairScale);
        }
      }
    }

    const groups = new Map<string, string[]>();
    for (const project of topology.projects) {
      if (!project.containerRoot) continue;
      const rootList = groups.get(project.containerRoot) ?? [];
      if (clustersByProject.has(project.root)) rootList.push(project.root);
      groups.set(project.containerRoot, rootList);
    }
    for (const projectRoots of groups.values()) {
      const uniqueRoots = [...new Set(projectRoots)].sort();
      for (let i = 0; i < uniqueRoots.length; i += 1) {
        const aRoot = uniqueRoots[i]!;
        const aClusters = [...(clustersByProject.get(aRoot) ?? [])];
        if (aClusters.length === 0) continue;
        for (let j = i + 1; j < uniqueRoots.length; j += 1) {
          const bRoot = uniqueRoots[j]!;
          const bClusters = [...(clustersByProject.get(bRoot) ?? [])];
          if (bClusters.length === 0) continue;
          const direct = projectRefs.get(aRoot)?.has(bRoot) || projectRefs.get(bRoot)?.has(aRoot);
          if (direct) continue;
          const pairScale = Math.sqrt(Math.max(1, aClusters.length * bClusters.length));
          for (const fromDir of aClusters) {
            for (const toDir of bClusters) addClusterWeight(weights, fromDir, toDir, 4 / pairScale);
          }
        }
      }
    }
  }
  return [...weights.entries()].map(([key, weight]): ClusterLink => {
    const parts = key.split("\u0000");
    const source = parts[0] ?? "";
    const target = parts[1] ?? "";
    return { source, target, weight };
  });
}

function refinedClusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  base: ReadonlyMap<string, { x: number; y: number }>,
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[],
  topology?: ProjectTopology | null,
): Map<string, { x: number; y: number }> {
  const links = clusterGraphLinks(nodes, edges, topology);
  if (base.size <= 1 || links.length === 0) return new Map(base);

  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.dir, (counts.get(node.dir) ?? 0) + 1);
  const totalNodes = nodes.length;
  const worldRadius = DEFAULT_CLUSTER_SPACING * Math.sqrt(Math.max(1, totalNodes)) + DEFAULT_WORLD_PADDING;
  const simNodes: ClusterSimNode[] = [...base.entries()].map(([dir, pos]) => ({
    id: dir,
    count: counts.get(dir) ?? 1,
    x: pos.x,
    y: pos.y,
    anchorX: pos.x,
    anchorY: pos.y,
  }));
  const simulation: Simulation<ClusterSimNode, ClusterLink> = forceSimulation(simNodes)
    .randomSource(seededRandom(1))
    .force(
      "link",
      forceLink<ClusterSimNode, ClusterLink>(links)
        .id((node) => node.id)
        .strength((link) => Math.min(0.42, 0.08 + Math.log1p(link.weight) * 0.08))
        .distance((link) => {
          const source = typeof link.source === "object" ? link.source : simNodes.find((node) => node.id === link.source);
          const target = typeof link.target === "object" ? link.target : simNodes.find((node) => node.id === link.target);
          const combined = (source?.count ?? 1) + (target?.count ?? 1);
          return Math.max(80, 170 + Math.sqrt(combined) * 2 - Math.log1p(link.weight) * 32);
        }),
    )
    .force("charge", forceManyBody<ClusterSimNode>().strength((node) => -120 - Math.sqrt(node.count) * 14).distanceMax(Math.max(450, worldRadius * 0.55)))
    .force("anchorX", forceX<ClusterSimNode>((node) => node.anchorX).strength(0.06))
    .force("anchorY", forceY<ClusterSimNode>((node) => node.anchorY).strength(0.06))
    .force("collide", forceCollide<ClusterSimNode>((node) => 18 + Math.min(48, Math.sqrt(node.count) * 3.5)).iterations(1))
    .stop();

  let ticks = 90;
  if (simNodes.length > 80) ticks = 60;
  if (simNodes.length > 180) ticks = 40;
  for (let i = 0; i < ticks; i += 1) simulation.tick();

  const out = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) out.set(node.id, { x: node.x ?? node.anchorX, y: node.y ?? node.anchorY });
  return out;
}

export function clusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  spacingPerNode = DEFAULT_CLUSTER_SPACING,
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[] = [],
  topology?: ProjectTopology | null,
): Map<string, { x: number; y: number }> {
  const base = baseClusterCentroids(nodes, spacingPerNode);
  return refinedClusterCentroids(nodes, base, edges, topology);
}

/** Extra separation between neighborhood centers vs. clusters within one, so
    codebases read as distinct regions rather than adjacent folders. */
const NEIGHBORHOOD_SPREAD = 2.4;

interface NbSimNode extends SimulationNodeDatum {
  id: string;
  count: number;
  anchorX: number;
  anchorY: number;
}

interface NbLink extends SimulationLinkDatum<NbSimNode> {
  weight: number;
}

/** Aggregate every cross-neighborhood import edge into a weighted graph over
    neighborhoods — the coupling that force placement uses to pull related
    codebases nearer each other. Intra-neighborhood edges are irrelevant here
    (they shape the layout *inside* a territory, not where territories sit). */
function neighborhoodLinks(
  nodes: readonly Pick<GraphNode, "id">[],
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[],
  neighborhoods: ReadonlyMap<string, string>,
): NbLink[] {
  const nbById = new Map(nodes.map((node) => [node.id, neighborhoods.get(node.id) ?? "."]));
  const weights = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const a = nbById.get(edge.from);
    const b = nbById.get(edge.to);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return [...weights.entries()].map(([key, weight]): NbLink => {
    const parts = key.split(" ");
    return { source: parts[0] ?? "", target: parts[1] ?? "", weight };
  });
}

/** Level one of the hierarchy: place neighborhood centers. A golden-angle
    spiral by member count seeds the positions deterministically, then — when
    cross-neighborhood edges exist — a seeded force pass lets that coupling pull
    related territories together, while a member-count collision radius keeps
    every territory a distinct region (heavily-coupled ≠ collapsed). With no
    cross edges it stays the pure spiral. Deterministic for a given input. */
export function neighborhoodCenters(
  nodes: readonly Pick<GraphNode, "id">[],
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[],
  neighborhoods: ReadonlyMap<string, string>,
  spacingPerNode = DEFAULT_CLUSTER_SPACING,
): Map<string, { x: number; y: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const nb = neighborhoods.get(node.id) ?? ".";
    counts.set(nb, (counts.get(nb) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const seed = new Map<string, { x: number; y: number }>();
  let cumulative = 0;
  entries.forEach(([nb, count], i) => {
    const radius = i === 0 ? 0 : spacingPerNode * NEIGHBORHOOD_SPREAD * Math.sqrt(cumulative + count / 2);
    const angle = i * GOLDEN_ANGLE;
    seed.set(nb, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    cumulative += count;
  });

  const links = neighborhoodLinks(nodes, edges, neighborhoods);
  if (entries.length <= 1 || links.length === 0) return new Map(seed);

  const simNodes: NbSimNode[] = entries.map(([nb, count]) => {
    const pos = seed.get(nb)!;
    return { id: nb, count, x: pos.x, y: pos.y, anchorX: pos.x, anchorY: pos.y };
  });
  const worldRadius = spacingPerNode * NEIGHBORHOOD_SPREAD * Math.sqrt(Math.max(1, nodes.length)) + DEFAULT_WORLD_PADDING;
  const base = spacingPerNode * NEIGHBORHOOD_SPREAD;
  /* Collision radius scales with a territory's size so a big codebase claims
     proportional room and no two centers can be pulled closer than the sum of
     their radii — the guarantee that keeps territories legibly separate even
     when they're heavily coupled. */
  const collisionRadius = (node: NbSimNode): number => base * Math.sqrt(Math.max(1, node.count)) * 0.45;
  const simNodeById = new Map(simNodes.map((node) => [node.id, node]));
  const resolve = (end: NbSimNode | string | number): NbSimNode | undefined =>
    typeof end === "object" ? end : simNodeById.get(String(end));
  const simulation: Simulation<NbSimNode, NbLink> = forceSimulation(simNodes)
    .randomSource(seededRandom(1))
    .force(
      "link",
      forceLink<NbSimNode, NbLink>(links)
        .id((node) => node.id)
        .strength((link) => Math.min(0.5, 0.12 + Math.log1p(link.weight) * 0.1))
        /* Pull coupled territories toward *touching* (the collision sum), more
           tightly the heavier the coupling — always ≥ the collision sum, so this
           never fights separation, and < the seed spacing, so coupling visibly
           draws them together. */
        .distance((link) => {
          const source = resolve(link.source);
          const target = resolve(link.target);
          const collisionSum = (source ? collisionRadius(source) : base) + (target ? collisionRadius(target) : base);
          return collisionSum + base / (1 + link.weight);
        }),
    )
    .force("charge", forceManyBody<NbSimNode>().strength((node) => -base * 3 - Math.sqrt(node.count) * spacingPerNode).distanceMax(Math.max(600, worldRadius * 0.7)))
    .force("anchorX", forceX<NbSimNode>((node) => node.anchorX).strength(0.04))
    .force("anchorY", forceY<NbSimNode>((node) => node.anchorY).strength(0.04))
    .force("collide", forceCollide<NbSimNode>(collisionRadius).iterations(2))
    .stop();

  let ticks = 120;
  if (simNodes.length > 60) ticks = 80;
  if (simNodes.length > 150) ticks = 50;
  for (let i = 0; i < ticks; i += 1) simulation.tick();

  const out = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) out.set(node.id, { x: node.x ?? node.anchorX, y: node.y ?? node.anchorY });
  return out;
}

/** Level two of the hierarchy: which subdivision each cluster belongs to. When
    topology is known, a subdivision is the owning project (a real sub-project),
    so a project's folders sit together within its territory; otherwise the
    cluster is its own subdivision, collapsing back to the flat two-level layout. */
function clusterSubdivisions(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  topology: ProjectTopology | null | undefined,
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const project = topology ? owningProjectForPath(topology, node.id) : null;
    const subdivision = project?.root ?? node.dir;
    const dirVotes = votes.get(node.dir) ?? new Map<string, number>();
    dirVotes.set(subdivision, (dirVotes.get(subdivision) ?? 0) + 1);
    votes.set(node.dir, dirVotes);
  }
  const out = new Map<string, string>();
  for (const [dir, dirVotes] of votes) {
    let best = dir;
    let bestCount = -1;
    for (const [subdivision, count] of dirVotes) {
      if (count > bestCount || (count === bestCount && subdivision < best)) { best = subdivision; bestCount = count; }
    }
    out.set(dir, best);
  }
  return out;
}

/** Territorial cluster centroids, laid out as a three-level hierarchy:
    neighborhoods (codebases) placed by force over aggregated cross-neighborhood
    edges, subdivisions (topology sub-projects) placed within each neighborhood,
    and clusters (folders) placed within each subdivision. Cross-codebase edges
    influence where territories sit but never collapse them; layout inside a
    territory stays local. Deterministic for a given input. */
export function territorialClusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  neighborhoods: ReadonlyMap<string, string>,
  spacingPerNode = DEFAULT_CLUSTER_SPACING,
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[] = [],
  topology: ProjectTopology | null = null,
): Map<string, { x: number; y: number }> {
  const clusterVotes = new Map<string, Map<string, number>>();
  const clusterCounts = new Map<string, number>();
  for (const node of nodes) {
    const nb = neighborhoods.get(node.id) ?? ".";
    clusterCounts.set(node.dir, (clusterCounts.get(node.dir) ?? 0) + 1);
    const votes = clusterVotes.get(node.dir) ?? new Map<string, number>();
    votes.set(nb, (votes.get(nb) ?? 0) + 1);
    clusterVotes.set(node.dir, votes);
  }
  /* Each cluster belongs to whichever neighborhood most of its members are in. */
  const clusterNeighborhood = new Map<string, string>();
  for (const [dir, votes] of clusterVotes) {
    let best = ".";
    let bestCount = -1;
    for (const [nb, count] of votes) {
      if (count > bestCount || (count === bestCount && nb < best)) { best = nb; bestCount = count; }
    }
    clusterNeighborhood.set(dir, best);
  }

  const nbCenter = neighborhoodCenters(nodes, edges, neighborhoods, spacingPerNode);
  const subdivisionOf = clusterSubdivisions(nodes, topology);

  /* Group clusters as neighborhood → subdivision → [cluster dirs]. */
  const byNeighborhood = new Map<string, Map<string, string[]>>();
  for (const [dir, nb] of clusterNeighborhood) {
    const subdivision = subdivisionOf.get(dir) ?? dir;
    const subdivisions = byNeighborhood.get(nb) ?? new Map<string, string[]>();
    const list = subdivisions.get(subdivision) ?? [];
    list.push(dir);
    subdivisions.set(subdivision, list);
    byNeighborhood.set(nb, subdivisions);
  }

  const out = new Map<string, { x: number; y: number }>();
  for (const [nb, subdivisions] of byNeighborhood) {
    const center = nbCenter.get(nb) ?? { x: 0, y: 0 };
    /* Subdivisions on a spiral around the neighborhood center, biggest first. */
    const subList = [...subdivisions.entries()]
      .map(([subdivision, dirs]) => ({ subdivision, dirs, count: dirs.reduce((sum, dir) => sum + (clusterCounts.get(dir) ?? 1), 0) }))
      .sort((a, b) => b.count - a.count || a.subdivision.localeCompare(b.subdivision));
    let subCumulative = 0;
    subList.forEach((entry, i) => {
      const radius = i === 0 ? 0 : spacingPerNode * Math.sqrt(subCumulative + entry.count / 2);
      const angle = i * GOLDEN_ANGLE;
      const subCenter = { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
      subCumulative += entry.count;
      /* Clusters on a tighter spiral around their subdivision center. */
      const dirs = entry.dirs.sort((a, b) => (clusterCounts.get(b) ?? 0) - (clusterCounts.get(a) ?? 0) || a.localeCompare(b));
      let clusterCumulative = 0;
      dirs.forEach((dir, j) => {
        const count = clusterCounts.get(dir) ?? 1;
        const r = j === 0 ? 0 : spacingPerNode * 0.7 * Math.sqrt(clusterCumulative + count / 2);
        const a = j * GOLDEN_ANGLE;
        out.set(dir, { x: subCenter.x + r * Math.cos(a), y: subCenter.y + r * Math.sin(a) });
        clusterCumulative += count;
      });
    });
  }
  return out;
}

/** Jitter radius for seeding a cluster's members around its centroid: tight
    for small folders, wider for big ones, capped so no cluster starts as a
    smear across its neighbors. */
export function clusterJitterRadius(clusterSize: number): number {
  return Math.min(180, 14 + 11 * Math.sqrt(Math.max(1, clusterSize)));
}

function totalTicks(nodeCount: number): number {
  /* Good centroid init converges fast; spend fewer ticks on huge graphs. */
  if (nodeCount > 3000) return 120;
  if (nodeCount > 1000) return 200;
  return 300;
}

/** Full d3 force simulation is valuable while the graph is small enough for
    individual springs to improve the picture. Past this point, even 120 ticks
    make the extension host pay O(ticks * (N log N + E)). The large path below
    instead makes a fixed number of linear passes over nodes/edges. */
export const LARGE_GRAPH_LAYOUT_THRESHOLD = 6_000;

const LARGE_NODE_GAP = 4;
const LARGE_CLUSTER_GAP = 52;
const LARGE_NEIGHBORHOOD_GAP = 112;
const PHYLLOTAXIS_SPACING_SAFETY = 1.08;
const PHYLLOTAXIS_ATTEMPTS = 4;

interface PackItem<T> {
  value: T;
  radius: number;
  score: number;
}

interface PackPlacement<T> extends PackItem<T> {
  x: number;
  y: number;
}

interface PackResult<T> {
  placements: PackPlacement<T>[];
  /** Radius of the enclosing disc, including every item's own radius. */
  radius: number;
}

interface OccupiedDisc {
  x: number;
  y: number;
  radius: number;
}

/** Convert an arbitrary non-negative score to the uint32 key used by the stable
    radix order below. Graph degree/count scores are integers in practice; the
    clamp keeps malformed/extreme fixture data deterministic too. */
function scoreKey(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0xffffffff, Math.floor(value)) >>> 0;
}

/** Stable descending radix order in four fixed byte passes: O(items), unlike a
    comparison sort's O(items log items). High-degree nodes/clusters land near
    the center, while equal-score input order stays stable across rebuilds. */
function orderByScore<T>(items: readonly PackItem<T>[]): PackItem<T>[] {
  if (items.length <= 1) return [...items];
  let input = [...items];
  let output = new Array<PackItem<T>>(items.length);
  for (const shift of [0, 8, 16, 24]) {
    const counts = new Uint32Array(256);
    for (const item of input) {
      const bucket = (scoreKey(item.score) >>> shift) & 0xff;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const offsets = new Uint32Array(256);
    let offset = 0;
    for (let bucket = 255; bucket >= 0; bucket -= 1) {
      offsets[bucket] = offset;
      offset += counts[bucket]!;
    }
    for (const item of input) {
      const bucket = (scoreKey(item.score) >>> shift) & 0xff;
      output[offsets[bucket]!] = item;
      offsets[bucket] = (offsets[bucket] ?? 0) + 1;
    }
    [input, output] = [output, input];
  }
  return input;
}

function stablePhase(seed: number, key: string): number {
  let hash = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
  return (hash / 4294967296) * Math.PI * 2;
}

/** Deterministic sunflower packing with an exact collision guard. The normal
    path follows a Fermat spiral (golden-angle turns, sqrt radius); the generous
    spacing makes collisions rare. A fixed-size spatial hash verifies each
    placement. After a constant number of retries, the item goes immediately
    outside the current enclosing disc, which is collision-free by construction.
    Thus every item does bounded local work and the whole pack remains O(N). */
function packPhyllotaxis<T>(rawItems: readonly PackItem<T>[], gap: number, phase: number): PackResult<T> {
  const items = orderByScore(rawItems);
  if (items.length === 0) return { placements: [], radius: 0 };
  const maxRadius = items.reduce((max, item) => Math.max(max, Math.max(0, item.radius)), 0);
  const cellSize = Math.max(1, maxRadius * 2 + gap);
  const step = cellSize * PHYLLOTAXIS_SPACING_SAFETY;
  const grid = new Map<string, OccupiedDisc[]>();
  const placements: PackPlacement<T>[] = [];
  let outerRadius = 0;

  const cellKey = (x: number, y: number): string => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  const collides = (x: number, y: number, radius: number): boolean => {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const required = radius + other.radius + gap;
          const px = x - other.x;
          const py = y - other.y;
          if (px * px + py * py < required * required - 1e-7) return true;
        }
      }
    }
    return false;
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const radius = Math.max(0, item.radius);
    let x = 0;
    let y = 0;
    let placed = false;
    for (let attempt = 0; attempt < PHYLLOTAXIS_ATTEMPTS; attempt += 1) {
      const spiralIndex = index + attempt * 0.375;
      const distance = spiralIndex === 0 ? 0 : step * Math.sqrt(spiralIndex);
      const angle = phase + spiralIndex * GOLDEN_ANGLE;
      x = distance === 0 ? 0 : Math.cos(angle) * distance;
      y = distance === 0 ? 0 : Math.sin(angle) * distance;
      if (!collides(x, y, radius)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      /* For every prior disc, outerRadius >= priorDistance + priorRadius.
         Putting this center at outerRadius + radius + gap therefore leaves at
         least priorRadius + radius + gap along the radial dimension alone. */
      const distance = outerRadius + radius + gap;
      const angle = phase + index * GOLDEN_ANGLE;
      x = Math.cos(angle) * distance;
      y = Math.sin(angle) * distance;
    }
    const occupied = { x, y, radius };
    const key = cellKey(x, y);
    const bucket = grid.get(key);
    if (bucket) bucket.push(occupied);
    else grid.set(key, [occupied]);
    outerRadius = Math.max(outerRadius, Math.hypot(x, y) + radius);
    placements.push({ ...item, x, y });
  }
  return { placements, radius: outerRadius };
}

interface LargeCluster {
  dir: string;
  nodes: GraphNode[];
  neighborhoodVotes: Map<string, number>;
  neighborhood: string;
  connectivity: number;
  nodePlacements: Map<string, { x: number; y: number }>;
  radius: number;
}

interface LargeNeighborhood {
  id: string;
  clusters: LargeCluster[];
  connectivity: number;
  clusterPlacements: Map<string, { x: number; y: number }>;
  radius: number;
}

function majorityVote(votes: ReadonlyMap<string, number>, fallback: string): string {
  let best = fallback;
  let bestCount = -1;
  for (const [value, count] of votes) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Linear-time hierarchical path for very large maps. Files are packed inside
    folder clusters; clusters are packed inside codebase neighborhoods; the
    neighborhoods are packed into the world. Every level uses the same guarded
    phyllotaxis primitive, so no lower-level disc can overlap a peer disc. Import
    edges are scanned once to rank architectural hubs toward each pack's center.
    No force tick, comparison sort, or all-pairs collision pass occurs here. */
function createLargeGraphLayout(nodes: readonly GraphNode[], edges: readonly GraphEdge[], opts: LayoutOptions): LayoutHandle {
  const clusterByDir = new Map<string, LargeCluster>();
  const dirByNodeId = new Map<string, string>();
  for (const node of nodes) {
    let cluster = clusterByDir.get(node.dir);
    if (!cluster) {
      cluster = {
        dir: node.dir,
        nodes: [],
        neighborhoodVotes: new Map<string, number>(),
        neighborhood: ".",
        connectivity: 0,
        nodePlacements: new Map<string, { x: number; y: number }>(),
        radius: 0,
      };
      clusterByDir.set(node.dir, cluster);
    }
    cluster.nodes.push(node);
    dirByNodeId.set(node.id, node.dir);
    const neighborhood = opts.neighborhoods?.get(node.id) ?? ".";
    cluster.neighborhoodVotes.set(neighborhood, (cluster.neighborhoodVotes.get(neighborhood) ?? 0) + 1);
  }

  /* One edge pass supplies cluster/neighborhood architectural importance. The
     actual file placement is intentionally not spring-driven at this scale. */
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const fromDir = dirByNodeId.get(edge.from);
    const toDir = dirByNodeId.get(edge.to);
    if (!fromDir || !toDir || fromDir === toDir) continue;
    const from = clusterByDir.get(fromDir);
    const to = clusterByDir.get(toDir);
    if (from) from.connectivity += 1;
    if (to) to.connectivity += 1;
  }

  const clusters = [...clusterByDir.values()];
  for (const cluster of clusters) {
    cluster.neighborhood = majorityVote(cluster.neighborhoodVotes, ".");
    const packed = packPhyllotaxis(
      cluster.nodes.map((node): PackItem<GraphNode> => ({
        value: node,
        radius: layoutNodeCollisionRadius(node.inDegree + node.outDegree),
        score: node.inDegree + node.outDegree,
      })),
      LARGE_NODE_GAP,
      stablePhase(opts.seed, `nodes:${cluster.dir}`),
    );
    cluster.radius = packed.radius;
    for (const placement of packed.placements) {
      cluster.nodePlacements.set(placement.value.id, { x: placement.x, y: placement.y });
    }
  }

  const territorial = Boolean(opts.neighborhoods)
    && new Set(clusters.map((cluster) => cluster.neighborhood)).size >= 2;
  const neighborhoodById = new Map<string, LargeNeighborhood>();
  for (const cluster of clusters) {
    const id = territorial ? cluster.neighborhood : "__all__";
    let neighborhood = neighborhoodById.get(id);
    if (!neighborhood) {
      neighborhood = {
        id,
        clusters: [],
        connectivity: 0,
        clusterPlacements: new Map<string, { x: number; y: number }>(),
        radius: 0,
      };
      neighborhoodById.set(id, neighborhood);
    }
    neighborhood.clusters.push(cluster);
    neighborhood.connectivity += cluster.connectivity;
  }

  const neighborhoods = [...neighborhoodById.values()];
  for (const neighborhood of neighborhoods) {
    const packed = packPhyllotaxis(
      neighborhood.clusters.map((cluster): PackItem<LargeCluster> => ({
        value: cluster,
        radius: cluster.radius,
        score: cluster.connectivity * 4 + cluster.nodes.length,
      })),
      LARGE_CLUSTER_GAP,
      stablePhase(opts.seed, `clusters:${neighborhood.id}`),
    );
    neighborhood.radius = packed.radius;
    for (const placement of packed.placements) {
      neighborhood.clusterPlacements.set(placement.value.dir, { x: placement.x, y: placement.y });
    }
  }

  const worldPack = packPhyllotaxis(
    neighborhoods.map((neighborhood): PackItem<LargeNeighborhood> => ({
      value: neighborhood,
      radius: neighborhood.radius,
      score: neighborhood.connectivity * 4 + neighborhood.clusters.reduce((sum, cluster) => sum + cluster.nodes.length, 0),
    })),
    LARGE_NEIGHBORHOOD_GAP,
    stablePhase(opts.seed, "neighborhoods"),
  );
  const neighborhoodPositions = new Map(worldPack.placements.map((placement) => [placement.value.id, { x: placement.x, y: placement.y }]));

  const positions = new Map<string, { x: number; y: number }>();
  for (const neighborhood of neighborhoods) {
    const neighborhoodPosition = neighborhoodPositions.get(neighborhood.id) ?? { x: 0, y: 0 };
    for (const cluster of neighborhood.clusters) {
      const clusterPosition = neighborhood.clusterPlacements.get(cluster.dir) ?? { x: 0, y: 0 };
      for (const node of cluster.nodes) {
        const local = cluster.nodePlacements.get(node.id) ?? { x: 0, y: 0 };
        positions.set(node.id, {
          x: neighborhoodPosition.x + clusterPosition.x + local.x,
          y: neighborhoodPosition.y + clusterPosition.y + local.y,
        });
      }
    }
  }

  /* Pinning is an explicit caller contract and therefore wins over repacking.
     Unpinned previous positions are intentionally not blended: interpolation
     can reintroduce overlaps, while this deterministic layout is already stable
     for an unchanged corpus. */
  if (opts.pinPrevious) {
    for (const [id, previous] of opts.prevPositions ?? []) {
      if (positions.has(id)) positions.set(id, { x: previous.x, y: previous.y });
    }
  }

  return {
    tick(): boolean {
      return false;
    },
    positions(): Map<string, { x: number; y: number }> {
      return new Map(positions);
    },
  };
}

export function createLayout(nodes: readonly GraphNode[], edges: readonly GraphEdge[], opts: LayoutOptions): LayoutHandle {
  if (nodes.length >= LARGE_GRAPH_LAYOUT_THRESHOLD) return createLargeGraphLayout(nodes, edges, opts);
  const random = seededRandom(opts.seed);
  /* Territorial layout kicks in only with ≥2 distinct codebases to separate;
     otherwise the flat, force-refined layout is used unchanged. */
  const neighborhoods = opts.neighborhoods;
  const territorial = Boolean(neighborhoods) && new Set(neighborhoods!.values()).size >= 2;
  const centroids = territorial
    ? territorialClusterCentroids(nodes, neighborhoods!, DEFAULT_CLUSTER_SPACING, edges, opts.topology ?? null)
    : clusterCentroids(nodes, DEFAULT_CLUSTER_SPACING, edges, opts.topology);
  const clusterSizes = new Map<string, number>();
  for (const node of nodes) clusterSizes.set(node.dir, (clusterSizes.get(node.dir) ?? 0) + 1);
  /* World radius under area-proportional packing is ~spacingPerNode*sqrt(N);
     used to bound the long-range charge so force cost stays sane. The
     territorial layout spreads neighborhoods wider, so the bound scales with it. */
  const worldRadius = DEFAULT_CLUSTER_SPACING * (territorial ? NEIGHBORHOOD_SPREAD : 1) * Math.sqrt(Math.max(1, nodes.length)) + DEFAULT_WORLD_PADDING;

  const simNodes: SimNode[] = nodes.map((node) => {
    const prev = opts.prevPositions?.get(node.id);
    const centroid = centroids.get(node.dir) ?? { x: 0, y: 0 };
    const jitterRadius = clusterJitterRadius(clusterSizes.get(node.dir) ?? 1);
    const jitterAngle = random() * Math.PI * 2;
    const jitterDist = Math.sqrt(random()) * jitterRadius; /* uniform over the disc */
    const x = prev ? prev.x : centroid.x + Math.cos(jitterAngle) * jitterDist;
    const y = prev ? prev.y : centroid.y + Math.sin(jitterAngle) * jitterDist;
    const pinned = Boolean(prev && opts.pinPrevious);
    return {
      id: node.id,
      dir: node.dir,
      degree: node.inDegree + node.outDegree,
      x,
      y,
      fx: pinned ? x : undefined,
      fy: pinned ? y : undefined,
    };
  });

  const byId = new Map(simNodes.map((node) => [node.id, node]));
  const links: SimulationLinkDatum<SimNode>[] = [];
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    /* In territorial mode, only intra-codebase imports exert pull — a
       cross-codebase import must not drag one territory's stars into another
       (the cross edge still renders, it just doesn't fight the separation). */
    if (territorial && neighborhoods!.get(edge.from) !== neighborhoods!.get(edge.to)) continue;
    links.push({ source: edge.from, target: edge.to });
  }

  /* Gentle pull of every node toward its folder centroid keeps clusters
     coherent without a custom force implementation. */
  const clusterX = forceX<SimNode>((node) => (centroids.get(node.dir) ?? { x: 0, y: 0 }).x).strength(0.06);
  const clusterY = forceY<SimNode>((node) => (centroids.get(node.dir) ?? { x: 0, y: 0 }).y).strength(0.06);

  const simulation: Simulation<SimNode, SimulationLinkDatum<SimNode>> = forceSimulation(simNodes)
    .randomSource(random)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((node) => node.id)
        .strength((link) => {
          const source = typeof link.source === "object" ? link.source : byId.get(String(link.source));
          const target = typeof link.target === "object" ? link.target : byId.get(String(link.target));
          return importLinkStrength(source?.degree ?? 0, target?.degree ?? 0);
        })
        .distance((link) => {
          const source = typeof link.source === "object" ? link.source : byId.get(String(link.source));
          const target = typeof link.target === "object" ? link.target : byId.get(String(link.target));
          return importLinkDistance(source?.degree ?? 0, target?.degree ?? 0);
        }),
    )
    .force(
      "charge",
      forceManyBody<SimNode>()
        .strength((node) => -48 - Math.min(72, Math.sqrt(Math.max(0, node.degree)) * 6))
        .theta(0.9)
        .distanceMax(Math.max(450, worldRadius * 0.55)),
    )
    .force("clusterX", clusterX)
    .force("clusterY", clusterY)
    .force("collide", forceCollide<SimNode>((node) => layoutNodeCollisionRadius(node.degree)).iterations(NODE_COLLISION_ITERATIONS))
    .stop();

  let remaining = totalTicks(nodes.length);

  return {
    tick(count: number): boolean {
      const steps = Math.min(count, remaining);
      for (let i = 0; i < steps; i += 1) simulation.tick();
      remaining -= steps;
      return remaining > 0;
    },
    positions(): Map<string, { x: number; y: number }> {
      const out = new Map<string, { x: number; y: number }>();
      for (const node of simNodes) out.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
      return out;
    },
  };
}

/** Run the full simulation synchronously (tests, small graphs). */
export function computeLayout(nodes: readonly GraphNode[], edges: readonly GraphEdge[], opts: LayoutOptions): Map<string, { x: number; y: number }> {
  const handle = createLayout(nodes, edges, opts);
  while (handle.tick(50)) { /* run to convergence */ }
  return handle.positions();
}

/** Place a newly created file near its cluster without a global re-layout. */
export function placeNearCluster(
  dir: string,
  existing: ReadonlyMap<string, { x: number; y: number }>,
  nodesByDir: ReadonlyMap<string, readonly string[]>,
  seed: number,
): { x: number; y: number } {
  const random = seededRandom(seed);
  const siblings = nodesByDir.get(dir) ?? [];
  let cx = 0;
  let cy = 0;
  let count = 0;
  for (const id of siblings) {
    const pos = existing.get(id);
    if (!pos) continue;
    cx += pos.x;
    cy += pos.y;
    count += 1;
  }
  if (count === 0) {
    /* Unknown cluster: drop on the outer rim. */
    const angle = random() * Math.PI * 2;
    const radius = 200 + random() * 200;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }
  const angle = random() * Math.PI * 2;
  const radius = 24 + random() * 30;
  return { x: cx / count + radius * Math.cos(angle), y: cy / count + radius * Math.sin(angle) };
}
