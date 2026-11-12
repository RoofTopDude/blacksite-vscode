/* Shared, cached workspace hierarchy (graph/hierarchy.ts). The Map webview
   (Systems overview, outline, scope bar) and the agent gateway (codebases and
   dependency findings in map_overview) read one instance, rebuilt when the
   index generation, the relationship set, or the co-change set changes. Pure
   aggregation over data the indexer and relationship snapshot already hold. */

import { buildHierarchy, type WorkspaceHierarchy } from "./hierarchy.js";
import type { MapIndexReader, ServiceRelationshipReader } from "./index-reader.js";
import type { WorkspaceRoot } from "./workspace-roots.js";

const EMPTY: WorkspaceHierarchy = { groups: [], edges: [], roots: [], declaredUnused: [], usedUndeclared: [], fileCount: 0 };

export class HierarchySnapshot {
  private _key = "";
  private _result: WorkspaceHierarchy = EMPTY;

  constructor(
    private readonly _indexer: MapIndexReader,
    private readonly _relationships: ServiceRelationshipReader,
    private readonly _roots: () => WorkspaceRoot[],
  ) {}

  get(): WorkspaceHierarchy {
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return EMPTY;
    const serviceEdges = this._relationships.full();
    const cochange = this._indexer.cochangeEdges();
    const topology = this._indexer.topology();
    const key = [
      snapshot.seq ?? snapshot.indexedAt,
      serviceEdges.length,
      cochange.length,
      topology?.projects.length ?? 0,
      topology?.references.length ?? 0,
    ].join(":");
    if (key === this._key) return this._result;
    this._key = key;
    try {
      const roots = this._roots();
      this._result = buildHierarchy({
        nodes: this._indexer.nodeIndex(),
        renderedIds: new Set(snapshot.nodes.map((node) => node.id)),
        rootNames: roots.length > 1 ? roots.map((root) => root.name) : [],
        topology,
        importEdges: this._indexer.importEdges(),
        serviceEdges,
        cochangeEdges: cochange,
      });
    } catch {
      /* Best-effort, like StructuralSnapshot: a throw must not abort a state post. */
      this._result = EMPTY;
    }
    return this._result;
  }
}
