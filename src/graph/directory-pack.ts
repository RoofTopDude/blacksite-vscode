/* Directory-first placement for the Codebase Map.

   Folders are placed as a tree of nested discs: every folder's subtree owns one
   disc, packed inside its parent's disc, so `services/auth/**` can never end up
   interleaved with `services/billing/**`, and the chunks an oversized flat
   folder is split into (`tests/unit#0…#7`, see assignClusters) sit together
   inside `tests/unit`. Import and declared-dependency coupling never moves a
   folder out of its parent; it only decides, within a parent, which siblings
   sit nearest the middle and which way each subtree faces — so a folder that
   talks to another codebase is turned toward it.

   Pure and deterministic (d3-hierarchy's sibling packing is seeded since 3.1):
   the same folders and couplings always produce the same positions. */

import { packSiblings } from "d3-hierarchy";

export interface PackCluster {
  /** Cluster key as assignClusters writes it: a folder path, "." for top-level
      files, or `path#n` for one import-community chunk of an oversized folder. */
  dir: string;
  /** Radius of the cluster's own disc (its files, already arranged). */
  radius: number;
  /** Files in the cluster; bigger siblings pack toward the middle. */
  count: number;
  /** Codebase territory. When any cluster has one, territories become the top
      level of the tree and each folder tree is built inside its territory. */
  territory?: string;
}

export interface DirectoryPackOptions {
  /** Clear space between sibling discs at nesting depth `depth` (0 = top level). */
  gap: (depth: number) => number;
  /** Undirected coupling between cluster dirs, keyed by couplingKey(a, b). */
  couplings?: ReadonlyMap<string, number>;
}

export interface DirectoryPack {
  /** World position of every cluster's centre. */
  centers: Map<string, { x: number; y: number }>;
  /** Radius of the disc enclosing everything. */
  radius: number;
}

export function couplingKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** The folder a cluster key belongs to: `src/graph#2` → `src/graph`. */
export function clusterBaseDir(dir: string): string {
  return dir.replace(/#\d+$/, "");
}

interface TreeNode {
  key: string;
  children: TreeNode[];
  cluster?: PackCluster;
  parent: TreeNode | null;
  depth: number;
  radius: number;
  count: number;
  /** Coupling weight between this subtree and everything outside it. */
  external: number;
  /** Offset from the parent's centre, then world position once placed. */
  x: number;
  y: number;
  wx: number;
  wy: number;
  /** Couplings that cross this node's boundary from one of its children:
      the child holding our end, the leaf at the far end, and the weight. */
  pulls: Array<{ child: TreeNode; partner: TreeNode; weight: number }>;
}

function makeNode(key: string, parent: TreeNode | null): TreeNode {
  return { key, children: [], parent, depth: 0, radius: 0, count: 0, external: 0, x: 0, y: 0, wx: 0, wy: 0, pulls: [] };
}

function buildTree(clusters: readonly PackCluster[]): { root: TreeNode; leaves: Map<string, TreeNode> } {
  const root = makeNode("", null);
  const leaves = new Map<string, TreeNode>();
  const byKey = new Map<string, TreeNode>([["", root]]);
  const child = (parent: TreeNode, key: string): TreeNode => {
    let node = byKey.get(key);
    if (!node) {
      node = makeNode(key, parent);
      parent.children.push(node);
      byKey.set(key, node);
    }
    return node;
  };
  const territorial = clusters.some((cluster) => cluster.territory !== undefined);
  for (const cluster of clusters) {
    let parent = root;
    let scope = "";
    if (territorial) {
      scope = `t:${cluster.territory ?? "."}`;
      parent = child(root, scope);
    }
    const base = clusterBaseDir(cluster.dir);
    const segments = base === "." || base === "" ? [] : base.split("/").filter(Boolean);
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      parent = child(parent, `${scope}|${path}`);
    }
    const leaf = makeNode(`${scope}|leaf:${cluster.dir}`, parent);
    leaf.cluster = cluster;
    leaf.radius = Math.max(1, cluster.radius);
    leaf.count = Math.max(1, cluster.count);
    parent.children.push(leaf);
    leaves.set(cluster.dir, leaf);
  }
  return { root, leaves };
}

/** A folder with one child is the same disc as that child; drop the extra
    level so a deep `a/b/c/d` chain does not nest four identical circles. */
function collapse(node: TreeNode): TreeNode {
  node.children = node.children.map(collapse);
  for (const c of node.children) c.parent = node;
  if (node.parent && !node.cluster && node.children.length === 1) {
    const only = node.children[0]!;
    only.parent = node.parent;
    return only;
  }
  return node;
}

function assignDepth(node: TreeNode, depth: number): void {
  node.depth = depth;
  for (const c of node.children) assignDepth(c, depth + 1);
}

function chainOf(leaf: TreeNode): TreeNode[] {
  const chain: TreeNode[] = [];
  for (let n: TreeNode | null = leaf; n; n = n.parent) chain.push(n);
  return chain.reverse();
}

/** Attribute every coupling to the subtrees it crosses: external weight on each
    node between a leaf and the lowest common ancestor (used to order siblings),
    and a pull on each of those nodes' parents (used to turn a subtree toward
    what it talks to). */
function attributeCouplings(leaves: ReadonlyMap<string, TreeNode>, couplings: ReadonlyMap<string, number> | undefined): void {
  if (!couplings || couplings.size === 0) return;
  const chains = new Map<TreeNode, TreeNode[]>();
  const chainFor = (leaf: TreeNode): TreeNode[] => chains.get(leaf) ?? chains.set(leaf, chainOf(leaf)).get(leaf)!;
  for (const [key, weight] of couplings) {
    if (!(weight > 0)) continue;
    const split = key.indexOf("\u0000");
    const a = leaves.get(key.slice(0, split));
    const b = leaves.get(key.slice(split + 1));
    if (!a || !b || a === b) continue;
    const ca = chainFor(a);
    const cb = chainFor(b);
    let lca = 0;
    while (lca + 1 < ca.length && lca + 1 < cb.length && ca[lca + 1] === cb[lca + 1]) lca += 1;
    for (const [chain, partner] of [[ca, b], [cb, a]] as const) {
      for (let i = lca + 1; i < chain.length; i += 1) {
        const node = chain[i]!;
        node.external += weight;
        /* The node's parent (below the common ancestor) is where this child's
           arrangement can be turned toward the partner. */
        if (i > lca + 1) chain[i - 1]!.pulls.push({ child: node, partner, weight });
      }
    }
  }
}

function score(node: TreeNode): number {
  return node.count + 2 * node.external;
}

function measure(node: TreeNode, gap: (depth: number) => number): void {
  if (node.cluster) return;
  for (const c of node.children) measure(c, gap);
  node.count = node.children.reduce((sum, c) => sum + c.count, 0);
  if (node.children.length === 0) {
    node.radius = 1;
    return;
  }
  /* Most-coupled and largest first: the front-chain packer puts early circles
     in the middle, so hubs end up central and coupled siblings adjacent. */
  node.children.sort((a, b) => score(b) - score(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (node.children.length === 1) {
    const only = node.children[0]!;
    only.x = 0;
    only.y = 0;
    node.radius = only.radius;
    return;
  }
  const half = gap(node.depth + 1) / 2;
  /* Each circle is inflated by half the gap, so tangent circles leave exactly
     `gap` between the real discs. packSiblings centres the enclosing circle on
     the origin; the measured extent (inflation included) becomes this node's
     radius, which pads its own outline by half a gap. */
  const circles = node.children.map((c) => ({ r: c.radius + half, x: 0, y: 0, node: c }));
  packSiblings(circles);
  let radius = 0;
  for (const circle of circles) {
    circle.node.x = circle.x;
    circle.node.y = circle.y;
    radius = Math.max(radius, Math.hypot(circle.x, circle.y) + circle.r);
  }
  node.radius = radius;
}

/** Turn a node's children so the ones pulled toward something outside this node
    face it, and the ones that are not face away — maximising Σ (vᵢ − v̄) · R(θ)oᵢ
    over θ, which has a closed form. */
function alignRotation(node: TreeNode): number {
  if (node.pulls.length === 0 || node.children.length < 2) return 0;
  const pull = new Map<TreeNode, { x: number; y: number }>();
  for (const { child, partner, weight } of node.pulls) {
    /* The partner's deepest ancestor already placed stands in for it: every node
       at this node's depth or shallower has a world position by now. */
    let rep = partner;
    while (rep.depth > node.depth && rep.parent) rep = rep.parent;
    const dx = rep.wx - node.wx;
    const dy = rep.wy - node.wy;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const v = pull.get(child) ?? { x: 0, y: 0 };
    v.x += (weight * dx) / length;
    v.y += (weight * dy) / length;
    pull.set(child, v);
  }
  if (pull.size === 0) return 0;
  let meanX = 0;
  let meanY = 0;
  for (const v of pull.values()) { meanX += v.x; meanY += v.y; }
  meanX /= node.children.length;
  meanY /= node.children.length;
  let c = 0;
  let s = 0;
  for (const child of node.children) {
    const v = pull.get(child) ?? { x: 0, y: 0 };
    const ax = v.x - meanX;
    const ay = v.y - meanY;
    c += ax * child.x + ay * child.y;
    s += ay * child.x - ax * child.y;
  }
  return Math.hypot(c, s) < 1e-9 ? 0 : Math.atan2(s, c);
}

function place(root: TreeNode): void {
  root.wx = 0;
  root.wy = 0;
  let layer: TreeNode[] = [root];
  while (layer.length > 0) {
    const next: TreeNode[] = [];
    for (const node of layer) {
      const theta = alignRotation(node);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      for (const c of node.children) {
        c.wx = node.wx + c.x * cos - c.y * sin;
        c.wy = node.wy + c.x * sin + c.y * cos;
        next.push(c);
      }
    }
    layer = next;
  }
}

/** Place clusters as nested discs following the folder tree (and, when given,
    codebase territories above it). Discs at the same level never overlap:
    each is at least `gap(depth)` clear of its siblings. */
export function packDirectoryTree(clusters: readonly PackCluster[], options: DirectoryPackOptions): DirectoryPack {
  const centers = new Map<string, { x: number; y: number }>();
  if (clusters.length === 0) return { centers, radius: 0 };
  const sorted = [...clusters].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const built = buildTree(sorted);
  const root = collapse(built.root);
  assignDepth(root, 0);
  attributeCouplings(built.leaves, options.couplings);
  measure(root, options.gap);
  place(root);
  for (const [dir, leaf] of built.leaves) centers.set(dir, { x: leaf.wx, y: leaf.wy });
  return { centers, radius: root.radius };
}
