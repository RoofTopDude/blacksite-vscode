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
  type ProjectTopology,
} from "./project-topology.js";
import { couplingKey, packDirectoryTree } from "./directory-pack.js";

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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const NODE_COLLISION_BASE_RADIUS = 14;
const NODE_COLLISION_DEGREE_SCALE = 2.6;
const NODE_COLLISION_DEGREE_CAP = 18;
const NODE_COLLISION_ITERATIONS = 2;
const DEFAULT_CLUSTER_SPACING = 42;

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

/** Clear space between sibling folder discs. Territories (whole codebases) get
    the widest moat; each level of nesting below sits closer than the one above
    (every level's margin compounds into its parent's), so siblings read as one
    unit and cousins stay visibly apart. `depth` is the siblings' nesting level,
    1 being the top. */
export function folderTreeGap(depth: number, territorial: boolean, base = 48, territoryGap = 96): number {
  if (territorial && depth === 1) return territoryGap;
  const level = Math.max(1, territorial ? depth - 1 : depth);
  return Math.max(12, base * 0.62 ** (level - 1));
}

/** Seed radius for a folder before its files are laid out: roughly the disc its
    members need at the default spacing. Replaced by the measured radius once
    the force pass has arranged them (see repackFolderTree). */
export function estimateClusterRadius(count: number, spacingPerNode = DEFAULT_CLUSTER_SPACING): number {
  return 18 + spacingPerNode * 0.5 * Math.sqrt(Math.max(1, count));
}

/** Coupling between folders, for ordering and orienting siblings in the folder
    tree: import counts between their files, plus each declared project
    reference (package.json dependencies, .csproj references, …) as a link
    between the two projects' largest folders. One link per reference is enough
    to turn a project toward the one it depends on, without an all-pairs blow-up
    on a project with hundreds of folders. */
export function clusterCouplings(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[],
  topology?: ProjectTopology | null,
): Map<string, number> {
  const dirById = new Map(nodes.map((node) => [node.id, node.dir]));
  const out = new Map<string, number>();
  const add = (a: string | undefined, b: string | undefined, weight: number): void => {
    if (!a || !b || a === b || !(weight > 0)) return;
    const key = couplingKey(a, b);
    out.set(key, (out.get(key) ?? 0) + weight);
  };
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    add(dirById.get(edge.from), dirById.get(edge.to), 1);
  }
  if (topology && topology.references.length > 0) {
    const sizes = new Map<string, Map<string, number>>();
    for (const node of nodes) {
      const project = owningProjectForPath(topology, node.id);
      if (!project) continue;
      const dirs = sizes.get(project.root) ?? new Map<string, number>();
      dirs.set(node.dir, (dirs.get(node.dir) ?? 0) + 1);
      sizes.set(project.root, dirs);
    }
    const largest = new Map<string, string>();
    for (const [root, dirs] of sizes) {
      let best = "";
      let bestCount = -1;
      for (const [dir, count] of dirs) {
        if (count > bestCount || (count === bestCount && dir < best)) { best = dir; bestCount = count; }
      }
      largest.set(root, best);
    }
    for (const [from, targets] of buildProjectReferenceMap(topology)) {
      for (const to of targets) add(largest.get(from), largest.get(to), 8);
    }
  }
  return out;
}

/** Each folder's territory: whichever codebase most of its files belong to. */
function clusterTerritories(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  neighborhoods: ReadonlyMap<string, string>,
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const nb = neighborhoods.get(node.id) ?? ".";
    const dirVotes = votes.get(node.dir) ?? new Map<string, number>();
    dirVotes.set(nb, (dirVotes.get(nb) ?? 0) + 1);
    votes.set(node.dir, dirVotes);
  }
  const out = new Map<string, string>();
  for (const [dir, dirVotes] of votes) out.set(dir, majorityVote(dirVotes, "."));
  return out;
}

function clusterCounts(nodes: readonly Pick<GraphNode, "dir">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.dir, (counts.get(node.dir) ?? 0) + 1);
  return counts;
}

/** Folder centres for the flat (single-territory) map, laid out directory-first:
    every folder subtree is one disc nested inside its parent's, siblings never
    overlap, and import/project coupling only orders and orients siblings. */
export function clusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  spacingPerNode = DEFAULT_CLUSTER_SPACING,
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[] = [],
  topology?: ProjectTopology | null,
): Map<string, { x: number; y: number }> {
  const counts = clusterCounts(nodes);
  return packDirectoryTree(
    [...counts].map(([dir, count]) => ({ dir, count, radius: estimateClusterRadius(count, spacingPerNode) })),
    { gap: (depth) => folderTreeGap(depth, false), couplings: clusterCouplings(nodes, edges, topology) },
  ).centers;
}

/** Folder centres for a multi-codebase map: codebases are the top level of the
    tree, each with its own folder tree inside, so a codebase is one separated
    region and its folders stay nested by path within it. Cross-codebase
    coupling turns territories toward each other but never merges them. */
export function territorialClusterCentroids(
  nodes: readonly Pick<GraphNode, "id" | "dir">[],
  neighborhoods: ReadonlyMap<string, string>,
  spacingPerNode = DEFAULT_CLUSTER_SPACING,
  edges: readonly Pick<GraphEdge, "from" | "to" | "kind">[] = [],
  topology: ProjectTopology | null = null,
): Map<string, { x: number; y: number }> {
  const counts = clusterCounts(nodes);
  const territories = clusterTerritories(nodes, neighborhoods);
  return packDirectoryTree(
    [...counts].map(([dir, count]) => ({
      dir, count, radius: estimateClusterRadius(count, spacingPerNode), territory: territories.get(dir) ?? ".",
    })),
    { gap: (depth) => folderTreeGap(depth, true), couplings: clusterCouplings(nodes, edges, topology) },
  ).centers;
}

/** Final placement for the force path: measure each folder as its files were
    actually arranged, then pack those discs as the folder tree and move every
    folder whole to its slot. The force pass decides how a folder looks inside;
    this decides where it sits — always inside its parent folder, never
    overlapping a sibling. */
function repackFolderTree(
  nodes: SimNode[],
  territories: ReadonlyMap<string, string> | null,
  couplings: ReadonlyMap<string, number>,
  gap: (depth: number) => number,
): void {
  const groups = new Map<string, SimNode[]>();
  for (const node of nodes) {
    const members = groups.get(node.dir) ?? [];
    members.push(node);
    groups.set(node.dir, members);
  }
  const folders = [...groups].map(([dir, members]) => {
    const x = members.reduce((sum, node) => sum + node.x!, 0) / members.length;
    const y = members.reduce((sum, node) => sum + node.y!, 0) / members.length;
    /* Same outline allowance the renderer's folder hull needs. */
    const pad = 36 + Math.sqrt(members.length) * 4;
    const radius = members.reduce((bound, node) => Math.max(bound,
      Math.hypot(node.x! - x, node.y! - y) + Math.max(layoutNodeCollisionRadius(node.degree), pad)), 0);
    return { dir, members, x, y, radius };
  });
  const pack = packDirectoryTree(
    folders.map((folder) => ({
      dir: folder.dir,
      count: folder.members.length,
      radius: folder.radius,
      ...(territories ? { territory: territories.get(folder.dir) ?? "." } : {}),
    })),
    { gap, couplings },
  );
  for (const folder of folders) {
    const center = pack.centers.get(folder.dir);
    if (!center) continue;
    const dx = center.x - folder.x;
    const dy = center.y - folder.y;
    for (const node of folder.members) {
      node.x! += dx;
      node.y! += dy;
    }
  }
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
  nodePlacements: Map<string, { x: number; y: number }>;
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

/** Near-linear hierarchical path for very large maps. Files are packed inside
    their folder cluster (guarded phyllotaxis, hubs at the centre); the folder
    discs are then packed as the directory tree, codebases on top when the map
    is territorial (see directory-pack.ts). No level can overlap a peer disc,
    and no force tick or all-pairs collision pass occurs here. */
function createLargeGraphLayout(nodes: readonly GraphNode[], edges: readonly GraphEdge[], opts: LayoutOptions): LayoutHandle {
  const clusterByDir = new Map<string, LargeCluster>();
  for (const node of nodes) {
    let cluster = clusterByDir.get(node.dir);
    if (!cluster) {
      cluster = {
        dir: node.dir,
        nodes: [],
        neighborhoodVotes: new Map<string, number>(),
        neighborhood: ".",
        nodePlacements: new Map<string, { x: number; y: number }>(),
        radius: 0,
      };
      clusterByDir.set(node.dir, cluster);
    }
    cluster.nodes.push(node);
    const neighborhood = opts.neighborhoods?.get(node.id) ?? ".";
    cluster.neighborhoodVotes.set(neighborhood, (cluster.neighborhoodVotes.get(neighborhood) ?? 0) + 1);
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

  /* Folders are placed as their directory tree (codebases on top when the map
     is territorial): a folder's subtree is one disc inside its parent's, so
     sibling services never interleave. Coupling orders and turns siblings. */
  const territorial = Boolean(opts.neighborhoods)
    && new Set(clusters.map((cluster) => cluster.neighborhood)).size >= 2;
  const pack = packDirectoryTree(
    clusters.map((cluster) => ({
      dir: cluster.dir,
      count: cluster.nodes.length,
      radius: cluster.radius,
      ...(territorial ? { territory: cluster.neighborhood } : {}),
    })),
    {
      gap: (depth) => folderTreeGap(depth, territorial, LARGE_CLUSTER_GAP, LARGE_NEIGHBORHOOD_GAP),
      couplings: clusterCouplings(nodes, edges, opts.topology),
    },
  );

  const positions = new Map<string, { x: number; y: number }>();
  for (const cluster of clusters) {
    const center = pack.centers.get(cluster.dir) ?? { x: 0, y: 0 };
    for (const node of cluster.nodes) {
      const local = cluster.nodePlacements.get(node.id) ?? { x: 0, y: 0 };
      positions.set(node.id, { x: center.x + local.x, y: center.y + local.y });
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
     otherwise codebases are just the top of the folder tree. */
  const neighborhoods = opts.neighborhoods;
  const territorial = Boolean(neighborhoods) && new Set(neighborhoods!.values()).size >= 2;
  const territories = territorial ? clusterTerritories(nodes, neighborhoods!) : null;
  const couplings = clusterCouplings(nodes, edges, opts.topology);
  const gap = (depth: number): number => folderTreeGap(depth, territorial);
  const clusterSizes = clusterCounts(nodes);
  const centroids = packDirectoryTree(
    [...clusterSizes].map(([dir, count]) => ({
      dir, count, radius: estimateClusterRadius(count),
      ...(territories ? { territory: territories.get(dir) ?? "." } : {}),
    })),
    { gap, couplings },
  ).centers;
  /* Folders are re-placed as whole discs once the force pass ends, so repulsion
     only has to shape a folder's interior: bound it to about a folder's reach. */
  let largestFolder = 1;
  for (const size of clusterSizes.values()) largestFolder = Math.max(largestFolder, size);
  const chargeReach = Math.max(300, clusterJitterRadius(largestFolder) * 2.5);

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
    // Cross-folder imports already position the folder centroids. Applying
    // them again to files stretches folders into each other and creates knots.
    if (byId.get(edge.from)!.dir !== byId.get(edge.to)!.dir) continue;
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
        .distanceMax(chargeReach),
    )
    .force("clusterX", clusterX)
    .force("clusterY", clusterY)
    .force("collide", forceCollide<SimNode>((node) => layoutNodeCollisionRadius(node.degree)).iterations(NODE_COLLISION_ITERATIONS))
    .stop();

  let remaining = totalTicks(nodes.length);
  let separated = false;

  return {
    tick(count: number): boolean {
      const steps = Math.min(count, remaining);
      for (let i = 0; i < steps; i += 1) simulation.tick();
      remaining -= steps;
      if (remaining === 0 && !separated) {
        /* Pins are an explicit caller contract (incremental re-index keeps
           survivors where the user last saw them), so a pinned map only
           resolves overlaps; otherwise folders take their place in the tree. */
        if (simNodes.some((node) => node.fx != null || node.fy != null)) separateFolderBounds(simNodes, opts.seed);
        else repackFolderTree(simNodes, territories, couplings, gap);
        separated = true;
      }
      return remaining > 0;
    },
    positions(): Map<string, { x: number; y: number }> {
      const out = new Map<string, { x: number; y: number }>();
      for (const node of simNodes) out.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
      return out;
    },
  };
}

/** Move complete folders apart using their actual occupied bounds. Translating
    each group preserves its internal relationships; explicit pins take priority
    over separation. This pass is over folders, not all pairs of files. */
function separateFolderBounds(nodes: SimNode[], seed: number): void {
  const groups = new Map<string, SimNode[]>();
  for (const node of nodes) {
    const members = groups.get(node.dir) ?? [];
    members.push(node);
    groups.set(node.dir, members);
  }
  if (groups.size < 2) return;
  const folders = [...groups.values()].map((members) => {
    const x = members.reduce((sum, node) => sum + node.x!, 0) / members.length;
    const y = members.reduce((sum, node) => sum + node.y!, 0) / members.length;
    const radius = members.reduce((bound, node) => Math.max(bound,
      Math.hypot(node.x! - x, node.y! - y)
        + Math.max(layoutNodeCollisionRadius(node.degree), 36 + Math.sqrt(members.length) * 4)), 0);
    const pinned = members.some((node) => node.fx != null || node.fy != null);
    return { members, x, y, originX: x, originY: y, radius,
      fx: pinned ? x : undefined, fy: pinned ? y : undefined };
  });
  const packing = forceSimulation(folders)
    .randomSource(seededRandom(seed))
    .velocityDecay(0.6)
    .force("collide", forceCollide<(typeof folders)[number]>((folder) => folder.radius + 24).iterations(4))
    .stop();
  for (let tick = 0; tick < 100; tick += 1) packing.tick();
  for (const folder of folders) {
    for (const node of folder.members) {
      node.x! += folder.x - folder.originX;
      node.y! += folder.y - folder.originY;
    }
  }
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
