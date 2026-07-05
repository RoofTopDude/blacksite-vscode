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
  spacingPerNode = 30,
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
  const worldRadius = 30 * Math.sqrt(Math.max(1, totalNodes)) + 120;
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
  spacingPerNode = 30,
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[] = [],
  topology?: ProjectTopology | null,
): Map<string, { x: number; y: number }> {
  const base = baseClusterCentroids(nodes, spacingPerNode);
  return refinedClusterCentroids(nodes, base, edges, topology);
}

/** Jitter radius for seeding a cluster's members around its centroid: tight
    for small folders, wider for big ones, capped so no cluster starts as a
    smear across its neighbors. */
export function clusterJitterRadius(clusterSize: number): number {
  return Math.min(150, 10 + 9 * Math.sqrt(Math.max(1, clusterSize)));
}

function totalTicks(nodeCount: number): number {
  /* Good centroid init converges fast; spend fewer ticks on huge graphs. */
  if (nodeCount > 3000) return 120;
  if (nodeCount > 1000) return 200;
  return 300;
}

export function createLayout(nodes: readonly GraphNode[], edges: readonly GraphEdge[], opts: LayoutOptions): LayoutHandle {
  const random = seededRandom(opts.seed);
  const centroids = clusterCentroids(nodes, 30, edges, opts.topology);
  const clusterSizes = new Map<string, number>();
  for (const node of nodes) clusterSizes.set(node.dir, (clusterSizes.get(node.dir) ?? 0) + 1);
  /* World radius under area-proportional packing is ~spacingPerNode*sqrt(N);
     used to bound the long-range charge so force cost stays sane. */
  const worldRadius = 30 * Math.sqrt(Math.max(1, nodes.length)) + 120;

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
    if (byId.has(edge.from) && byId.has(edge.to)) links.push({ source: edge.from, target: edge.to });
  }

  /* Gentle pull of every node toward its folder centroid keeps clusters
     coherent without a custom force implementation. */
  const clusterX = forceX<SimNode>((node) => (centroids.get(node.dir) ?? { x: 0, y: 0 }).x).strength(0.08);
  const clusterY = forceY<SimNode>((node) => (centroids.get(node.dir) ?? { x: 0, y: 0 }).y).strength(0.08);

  const simulation: Simulation<SimNode, SimulationLinkDatum<SimNode>> = forceSimulation(simNodes)
    .randomSource(random)
    .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((node) => node.id).strength(0.12).distance(60))
    .force("charge", forceManyBody<SimNode>().strength(-42).theta(0.9).distanceMax(Math.max(400, worldRadius * 0.5)))
    .force("clusterX", clusterX)
    .force("clusterY", clusterY)
    .force("collide", forceCollide<SimNode>((node) => 8 + Math.min(14, Math.sqrt(node.degree + 1) * 2.4)).iterations(1))
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
