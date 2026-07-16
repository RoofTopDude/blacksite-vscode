/* Objective per-neighborhood connectivity signal for the Codebase Map's import
   graph — the measurement tool behind the per-language parity work (Python
   recall fixes, PHP PSR-4 support, …): before/after comparisons on a same-size
   sample should show average degree rise and orphan % fall, rather than
   eyeballing whether a language's map "looks" more connected. Pure — no
   vscode/fs, mirrors every other file in src/graph/. */

import type { GraphEdge, GraphNode } from "./graph-model.js";

export interface NeighborhoodConnectivity {
  /** node.neighborhood, or "__all__" when territorialization is inactive —
      same bucket key classifyStructuralRoles uses, so the two can be read
      side by side. */
  neighborhood: string;
  fileCount: number;
  /** Mean (inDegree + outDegree) over kind:"import" edges, across real files
      (aggregates — cluster/service super-nodes — are excluded). */
  averageDegree: number;
  /** orphanCount / fileCount, in [0, 1]. */
  orphanRatio: number;
}

/** Aggregate real (non-aggregate) file nodes and their import-edge degree per
    neighborhood, then fold in the orphan ids classifyStructuralRoles already
    computed. Degree is recomputed here from `edges` directly (not read off
    node.inDegree/outDegree) so the stat reflects exactly the import-kind edge
    set passed in, independent of whatever degree the render projection last
    cached on the node. */
export function neighborhoodConnectivityStats(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  orphanNodeIds: ReadonlySet<string> | readonly string[],
): NeighborhoodConnectivity[] {
  const orphans = orphanNodeIds instanceof Set ? orphanNodeIds : new Set(orphanNodeIds);
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const buckets = new Map<string, { fileCount: number; degreeSum: number; orphanCount: number }>();
  for (const node of nodes) {
    if (node.kind === "cluster" || node.kind === "service") continue;
    const key = node.neighborhood ?? "__all__";
    const bucket = buckets.get(key) ?? { fileCount: 0, degreeSum: 0, orphanCount: 0 };
    bucket.fileCount += 1;
    bucket.degreeSum += degree.get(node.id) ?? 0;
    if (orphans.has(node.id)) bucket.orphanCount += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([neighborhood, { fileCount, degreeSum, orphanCount }]): NeighborhoodConnectivity => ({
      neighborhood,
      fileCount,
      averageDegree: fileCount > 0 ? degreeSum / fileCount : 0,
      orphanRatio: fileCount > 0 ? orphanCount / fileCount : 0,
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.neighborhood.localeCompare(b.neighborhood));
}
