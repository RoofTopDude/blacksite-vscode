/* Agent-facing dispatch surface for the Codebase Map ("graph.*" runtime types). Map queries —
   overview / find / relationships / impact / routes, and the per-turn context blocks — are
   answered by MapQueryService (src/graph/map-query-service.ts); note ops (add/list/update/remove)
   go to the durable notes store. agent-session.ts dispatches every graph.* op to this one object
   without knowing which subsystem answers it.

   The query service reports failures as codes with neutral messages; this class turns them back
   into the wording the extension's map_* tools have always returned, so what the agent reads does
   not change. */

import type { GraphAnnotationContext, GraphAnnotationProvider, GraphAnnotationStore } from "./graph-annotation-store.js";
import type { MapIndexReader, ServiceRelationshipReader } from "./graph/index-reader.js";
import type { StructuralSnapshot } from "./graph/structural-snapshot.js";
import type { HierarchySnapshot } from "./graph/hierarchy-snapshot.js";
import type { GraphEdge } from "./graph/graph-model.js";
import type { WorkspaceRoot } from "./graph/workspace-roots.js";
import {
  formatWorkspaceOverview,
  MapQueryService,
  type FindQuery,
  type ImpactQuery,
  type OverviewQuery,
  type PathsQuery,
  type QueryFailure,
  type RoutesQuery,
} from "./graph/map-query-service.js";

const OVERVIEW_NOT_READY = "The Codebase Map has not finished indexing yet. Continue with code intelligence and call map_overview again once the index is ready.";
const QUERY_NOT_READY = "The Codebase Map has not finished indexing yet — try again shortly.";

/** A query result in the shape the map_* tools return. */
function toolResult(op: string, result: { ok: true } | QueryFailure): Record<string, unknown> {
  if (result.ok) return result as unknown as Record<string, unknown>;
  if (result.code === "not_indexed") {
    return op === "overview"
      ? { ok: false, indexing: result.indexing === true, error: OVERVIEW_NOT_READY }
      : { ok: false, error: QUERY_NOT_READY };
  }
  return { ok: false, error: result.message };
}

export class GraphAgentGateway implements GraphAnnotationProvider {
  private readonly _queries: MapQueryService;

  constructor(
    private readonly _annotations: GraphAnnotationStore,
    indexer: MapIndexReader,
    relationships: ServiceRelationshipReader,
    roots: () => WorkspaceRoot[],
    /** Background symbol-layer edges (call/reference/supertype); empty when the
        opt-in sweep is off. See graph/symbol-indexer.ts. */
    symbolEdges: () => readonly GraphEdge[] = () => [],
    /** Cycles / orphans / pockets / bridges. Optional because the same analysis
        already backs the Map webview; when it isn't wired the query ops still
        answer, just without the structural section. */
    structure: StructuralSnapshot | null = null,
    /** Codebase-level relationships and dependency findings. Optional for the
        same reason as `structure`. */
    hierarchy: HierarchySnapshot | null = null,
  ) {
    this._queries = new MapQueryService({ index: indexer, relationships, roots, notes: _annotations, symbolEdges, structure, hierarchy });
  }

  async dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>> {
    if (op === "overview") return toolResult(op, await this._queries.overview(payload as OverviewQuery, { waitForRelationships: true }));
    if (op === "relationships") return toolResult(op, await this._queries.relationships(payload as PathsQuery));
    if (op === "impact") return toolResult(op, await this._queries.impact(payload as ImpactQuery));
    if (op === "routes") return toolResult(op, await this._queries.routes(payload as RoutesQuery));
    if (op === "find") return toolResult(op, await this._queries.find(payload as FindQuery));
    return this._annotations.dispatch(op, payload, ctx);
  }

  /** Whether a workspace-relative file is on the map. Synchronous, against the index already built. */
  hasFile(path: string): boolean {
    return this._queries.hasFile(path);
  }

  /**
   * Files that import any of these, one hop, from the import layer already indexed. Synchronous and
   * best-effort: it never schedules a rebuild, so a file indexed since the last pass may be missed.
   */
  importDependents(paths: readonly string[]): string[] {
    return this._queries.importDependents(paths);
  }

  syncIndex(): Promise<{ appliedChanges: number }> {
    return this._queries.syncIndex();
  }

  projectRootOf(value: string): string | undefined {
    return this._queries.projectRootOf(value);
  }

  isMapIndexable(value: string): boolean {
    return this._queries.isMapIndexable(value);
  }

  /** Compact prose form injected into the live workspace context on every model turn. */
  async workspaceOverview(): Promise<string> {
    // Automatic context must never wait for a corpus-wide relationship rebuild.
    // The relationship snapshot schedules stale work in the background and returns the latest good
    // generation; an explicit map_overview call may await the fresh generation.
    const overview = await this._queries.overview({ limit: 8 }, { waitForRelationships: false });
    return overview.ok ? formatWorkspaceOverview(overview) : OVERVIEW_NOT_READY;
  }

  /** Per-turn map neighbourhood for the files the user currently has open. */
  localOverview(paths: readonly string[]): Promise<string> {
    return this._queries.localOverview(paths);
  }
}
