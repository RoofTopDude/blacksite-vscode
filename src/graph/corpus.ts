/* The canonical host-side corpus for the Codebase Map: every eligible file and
   every edge the indexer knows, kept whole and persisted separately from the
   render snapshot. Render slices, agent payloads, and queries are projections of
   this — capacity caps describe a projection, they never delete from the corpus.
   Pure data + projection helpers (no vscode/fs) so the indexer and unit tests
   share one definition; the host writes/reads it via graph/corpus-store.ts. */

import type { GraphEdge } from "./graph-model.js";
import type { ProjectTopology } from "./project-topology.js";

/** Bumped when the persisted corpus shape changes; independent of the render
    cache's CACHE_SCHEMA_VERSION so the two evolve separately. */
export const CORPUS_SCHEMA_VERSION = 1;

export interface GraphCorpus {
  version: number;
  indexedAt: string;
  /** Every eligible file, bounded only by the raw scan ceiling — not by any
      render/relationship cap. This is the truth the map is a view of. */
  files: string[];
  importEdges: GraphEdge[];
  /** Full service-relationship edges (api/event/data/config), uncapped. */
  relationshipEdges: GraphEdge[];
  topology: ProjectTopology | null;
  /** True file count before any projection — what the workspace actually holds. */
  fileCount: number;
  /** How many stars the current render slice draws (a projection of `files`). */
  renderedCount: number;
}

export interface RelationshipProjection {
  edges: GraphEdge[];
  truncated: boolean;
}

/** Project the full relationship-edge set down to a render/query cap. Highest
    confidence first (stable within a tier), so a truncated view keeps the most
    certain relationships rather than an arbitrary prefix. `truncated` reports
    whether the cap actually dropped anything — the cap is a property of this
    projection, never of the corpus it reads from. */
export function rankRelationshipEdges(edges: readonly GraphEdge[], cap: number): RelationshipProjection {
  if (!Number.isFinite(cap) || cap >= edges.length) return { edges: [...edges], truncated: false };
  if (cap <= 0) return { edges: [], truncated: edges.length > 0 };
  const ranked = [...edges].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { edges: ranked.slice(0, cap), truncated: true };
}
