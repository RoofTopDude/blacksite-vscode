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

export interface LayoutOptions {
  seed: number;
  /** Positions from a previous layout; matching nodes start (and stay) there. */
  prevPositions?: ReadonlyMap<string, { x: number; y: number }>;
  /** Pin nodes present in prevPositions instead of just seeding them. */
  pinPrevious?: boolean;
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
    to the middle so hub folders anchor the map. */
export function clusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  spacing: number,
): Map<string, { x: number; y: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.dir, (counts.get(node.dir) ?? 0) + 1);
  const dirs = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([dir]) => dir);
  const centroids = new Map<string, { x: number; y: number }>();
  dirs.forEach((dir, i) => {
    const radius = spacing * Math.sqrt(i);
    const angle = i * GOLDEN_ANGLE;
    centroids.set(dir, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });
  return centroids;
}

function totalTicks(nodeCount: number): number {
  /* Good centroid init converges fast; spend fewer ticks on huge graphs. */
  if (nodeCount > 3000) return 120;
  if (nodeCount > 1000) return 200;
  return 300;
}

export function createLayout(nodes: readonly GraphNode[], edges: readonly GraphEdge[], opts: LayoutOptions): LayoutHandle {
  const random = seededRandom(opts.seed);
  const spacing = Math.max(120, Math.sqrt(nodes.length) * 26);
  const centroids = clusterCentroids(nodes, spacing);

  const simNodes: SimNode[] = nodes.map((node) => {
    const prev = opts.prevPositions?.get(node.id);
    const centroid = centroids.get(node.dir) ?? { x: 0, y: 0 };
    const jitterRadius = spacing * 0.35;
    const x = prev ? prev.x : centroid.x + (random() - 0.5) * jitterRadius;
    const y = prev ? prev.y : centroid.y + (random() - 0.5) * jitterRadius;
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
    .force("charge", forceManyBody<SimNode>().strength(-42).theta(0.9).distanceMax(spacing * 3))
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
