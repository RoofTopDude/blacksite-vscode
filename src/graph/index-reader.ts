/* What the Codebase Map's consumers read from the index, as interfaces rather than the concrete
   GraphIndexer: the agent gateway, the relationship / structural / hierarchy snapshots, and (later)
   any host that brings its own index. GraphIndexer implements MapIndexReader; RelationshipSnapshot
   implements ServiceRelationshipReader. */

import type { Event } from "./events.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./graph-model.js";
import type { ProjectTopology } from "./project-topology.js";

export interface MapIndexReader {
  /** The latest render projection, or null before the first index (or cache load). */
  snapshot(): GraphSnapshot | null;
  /** Every indexed file as a laid-out node: a superset of snapshot().nodes whenever the render
      cap truncates. Before the first rebuild, whatever the cache held. */
  nodeIndex(): GraphNode[];
  /** Ids of every indexed file. */
  indexedFiles(): string[];
  /** Every eligible file in the workspace, before any index or render cap. */
  corpusFiles(): string[];
  /** Import edges over the whole indexed corpus, not just the render projection. */
  importEdges(): GraphEdge[];
  /** Logical-coupling edges from git history (files that keep changing together). */
  cochangeEdges(): GraphEdge[];
  /** Projects and project references from the last full rebuild, or null before one. */
  topology(): ProjectTopology | null;
  isIndexing(): boolean;
  /** Whether a node id sits under a directory the index never looks at (exclusion policy). */
  isExcludedPath(id: string): boolean;
  /** Apply waiting file-change notifications now instead of after the debounce. Resolves with
      how many changed paths were waiting. */
  flushPending(): Promise<number>;
  readonly onDidChange: Event<GraphSnapshot>;
}

export interface ServiceRelationshipReader {
  /** The latest full service-relationship set. Schedules a refresh without waiting for it. */
  full(): GraphEdge[];
  /** The service-relationship set for the current index generation, waiting for it if needed. */
  fullAsync(): Promise<GraphEdge[]>;
}
