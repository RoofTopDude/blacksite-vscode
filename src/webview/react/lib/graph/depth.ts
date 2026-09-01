/* What the Map's depth cue encodes. Pure — no pixi, no DOM — so the channel
   math is unit-testable on its own, like motion.ts and labels.ts.

   `GraphNode.z` arrives from the host as a log-scaled function of degree and
   drives one thing today: sprite alpha. The renderer's spatial cues (haze,
   sort order, scale falloff, edge alpha, parallax) read *this* value instead,
   which lets depth encode whichever axis the user is reasoning about without
   disturbing the alpha baseline the host already computed.

   Why the default is `nesting` and not `degree`: `graphNodeRadius()` is already
   a function of degree, so spending the depth dimension on degree too would
   encode one signal twice — stars would grow for being hubs and grow again for
   being near — and the map would look more three-dimensional while carrying
   less information. Nesting is orthogonal to radius, stable under edits, and
   needs no git or LSP data. */

import type { GraphNode } from "./protocol";

export const DEPTH_CHANNELS = ["nesting", "degree", "layer", "recency", "churn", "size"] as const;
export type DepthChannel = (typeof DEPTH_CHANNELS)[number];

export const DEPTH_CHANNEL_LABELS: Record<DepthChannel, string> = {
  nesting: "Folder nesting",
  degree: "Connectedness",
  layer: "Entry → leaf",
  recency: "Recently changed",
  churn: "Change frequency",
  size: "File size",
};

/** One-line explanation of what "near" means per channel, for the live caption
    under the control. Without it a user who switches channels sees the map
    shift with no idea what axis they are now looking at. */
export const DEPTH_CHANNEL_HINTS: Record<DepthChannel, string> = {
  nesting: "Shallow paths sit forward, deeply nested files recede",
  degree: "Well-connected files sit forward, isolated files recede",
  layer: "Entry points sit forward, leaf utilities recede",
  recency: "Recently committed files sit forward, stale files recede",
  churn: "Frequently changed files sit forward, quiet files recede",
  size: "Large files sit forward, small files recede",
};

export function isDepthChannel(value: unknown): value is DepthChannel {
  return typeof value === "string" && (DEPTH_CHANNELS as readonly string[]).includes(value);
}

/** Matches depthFromDegree's floor: nothing ever recedes fully into the
    background, because a star the user cannot see is a file they cannot click. */
const DEPTH_FLOOR = 0.15;
/** Where a node sits when its channel has nothing to say about it — an
    untracked file under `recency`, a one-import file under `layer`. Deliberately
    mid-depth rather than the floor: "unknown" is not "far away". */
const DEPTH_NEUTRAL = 0.55;
/** Below this total degree the entry/leaf ratio is noise — a single import
    would otherwise fling a file to one extreme. */
const LAYER_MIN_DEGREE = 3;

export interface DepthStats {
  maxDirSegments: number;
  maxDegree: number;
  maxChurn: number;
  oldestCommitAt: number;
  newestCommitAt: number;
  maxSizeScore: number;
}

function dirSegmentCount(node: Pick<GraphNode, "id" | "dir" | "kind">): number {
  /* A collapsed folder super-node stands at its own directory's depth; its id
     is synthetic, so the path can't be measured the same way a file's can. */
  const dir = node.kind === "cluster" ? node.dir : node.id.slice(0, Math.max(0, node.id.lastIndexOf("/")));
  if (!dir) return 0;
  return dir.split("/").filter(Boolean).length;
}

function sizeScore(bytes: number | undefined): number {
  return bytes && bytes > 0 ? Math.log10(1 + bytes / 1024) : 0;
}

/** Corpus-relative normalizers, computed once per display-graph rebuild so a
    channel reads as a distribution over *this* map rather than absolute units. */
export function depthStats(nodes: readonly GraphNode[]): DepthStats {
  let maxDirSegments = 0;
  let maxDegree = 0;
  let maxChurn = 0;
  let oldestCommitAt = Infinity;
  let newestCommitAt = 0;
  let maxSizeScore = 0;
  for (const node of nodes) {
    const segments = dirSegmentCount(node);
    if (segments > maxDirSegments) maxDirSegments = segments;
    const degree = node.inDegree + node.outDegree;
    if (degree > maxDegree) maxDegree = degree;
    if ((node.churn ?? 0) > maxChurn) maxChurn = node.churn ?? 0;
    const at = node.lastCommitAt;
    if (at && at > 0) {
      if (at < oldestCommitAt) oldestCommitAt = at;
      if (at > newestCommitAt) newestCommitAt = at;
    }
    const size = sizeScore(node.sizeBytes);
    if (size > maxSizeScore) maxSizeScore = size;
  }
  return {
    maxDirSegments,
    maxDegree,
    maxChurn,
    oldestCommitAt: Number.isFinite(oldestCommitAt) ? oldestCommitAt : 0,
    newestCommitAt,
    maxSizeScore,
  };
}

/** Map a raw [0,1] fraction into the usable depth band. */
function band(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return DEPTH_FLOOR + (1 - DEPTH_FLOOR) * clamped;
}

/** Depth for `node` under `channel`: 1 is nearest (fully forward), DEPTH_FLOOR
    is furthest. Always finite and always within [DEPTH_FLOOR, 1], so callers
    can multiply by it without guarding. */
export function depthFor(node: GraphNode, channel: DepthChannel, stats: DepthStats): number {
  switch (channel) {
    case "nesting": {
      if (stats.maxDirSegments <= 0) return 1;
      /* Shallow = forward. The root of a codebase is its surface. */
      return band(1 - dirSegmentCount(node) / stats.maxDirSegments);
    }
    case "degree": {
      const degree = node.inDegree + node.outDegree;
      if (stats.maxDegree <= 0 || degree <= 0) return DEPTH_FLOOR;
      return band(Math.log1p(degree) / Math.log1p(stats.maxDegree));
    }
    case "layer": {
      const total = node.inDegree + node.outDegree;
      /* A file that only imports is an entry point and belongs at the surface;
         one that is only imported is a leaf utility and belongs deep. */
      if (total < LAYER_MIN_DEGREE) return DEPTH_NEUTRAL;
      return band(node.outDegree / total);
    }
    case "recency": {
      const at = node.lastCommitAt;
      if (!at || at <= 0) return DEPTH_NEUTRAL;
      const span = stats.newestCommitAt - stats.oldestCommitAt;
      if (span <= 0) return DEPTH_NEUTRAL;
      return band((at - stats.oldestCommitAt) / span);
    }
    case "churn": {
      const churn = node.churn ?? 0;
      if (churn <= 0 || stats.maxChurn <= 0) return DEPTH_FLOOR;
      return band(Math.log1p(churn) / Math.log1p(stats.maxChurn));
    }
    case "size": {
      const score = sizeScore(node.sizeBytes);
      if (score <= 0 || stats.maxSizeScore <= 0) return DEPTH_FLOOR;
      return band(score / stats.maxSizeScore);
    }
    default:
      return 1;
  }
}

/** Blend a channel depth toward flat by `intensity`.

    At intensity 0 this returns exactly 1 for every node, which is the identity
    value for every cue that reads it (haze 0, scale multiplier 1, uniform sort
    key, edge multiplier 1, parallax offset 0). That is the regression
    guarantee: intensity 0 must render exactly what the map rendered before
    depth existed. */
export function applyDepthIntensity(depth: number, intensity: number): number {
  const clampedIntensity = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 1));
  const clampedDepth = Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 1));
  return 1 - clampedIntensity * (1 - clampedDepth);
}

/** Depth for every node in one pass. Returns an empty map when depth is flat,
    so callers can skip the whole depth path on a hot rebuild. */
export function depthMap(
  nodes: readonly GraphNode[],
  channel: DepthChannel,
  intensity: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!(intensity > 0) || nodes.length === 0) return out;
  const stats = depthStats(nodes);
  for (const node of nodes) {
    out.set(node.id, applyDepthIntensity(depthFor(node, channel, stats), intensity));
  }
  return out;
}
