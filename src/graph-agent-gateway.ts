/* Agent-facing dispatch surface for the Codebase Map ("graph.*" runtime types).
   Routes note ops (add/list/update/remove) to the durable annotation store and
   the map_relationships query to the live index + shared service-relationship
   snapshot, so agent-session.ts can keep dispatching every graph.* op to one
   object without knowing which subsystem answers it. */

import type { GraphAnnotationContext, GraphAnnotationProvider, GraphAnnotation, GraphAnnotationStore } from "./graph-annotation-store.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import type { RelationshipSnapshot } from "./graph/relationship-snapshot.js";
import type { GraphEdge } from "./graph/graph-model.js";
import { resolveToNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class GraphAgentGateway implements GraphAnnotationProvider {
  constructor(
    private readonly _annotations: GraphAnnotationStore,
    private readonly _indexer: GraphIndexer,
    private readonly _relationships: RelationshipSnapshot,
    private readonly _roots: () => WorkspaceRoot[],
    /** Background symbol-layer edges (call/reference/supertype); empty when the
        opt-in sweep is off. See graph/symbol-indexer.ts. */
    private readonly _symbolEdges: () => readonly GraphEdge[] = () => [],
  ) {}

  async dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>> {
    if (op === "relationships") return this._relationshipsForFiles(payload);
    return this._annotations.dispatch(op, payload, ctx);
  }

  private async _relationshipsForFiles(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = collectRequestedPaths(payload);
    if (requested.length === 0) return { ok: false, error: "Provide a file path in `path`, or several in `paths`." };
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return { ok: false, error: "The Codebase Map has not finished indexing yet — try again shortly." };

    const roots = this._roots();
    const onMap = new Set(snapshot.nodes.map((node) => node.id));
    const importEdges = typeof this._indexer.importEdges === "function"
      ? this._indexer.importEdges()
      : snapshot.edges.filter((edge) => edge.kind === "import");
    /* The agent view is uncapped — relationship edges here are the full corpus
       set, not the render projection. */
    const serviceEdges = typeof this._relationships.fullAsync === "function"
      ? await this._relationships.fullAsync()
      : this._relationships.full();
    const symbolEdges = this._symbolEdges();
    const notes = this._annotations.list();
    const limit = clampLimit(payload.limit);

    const files: Record<string, unknown>[] = [];
    const unresolved: string[] = [];
    for (const raw of requested) {
      const id = resolveToNodeId(roots, raw);
      if (!id) { unresolved.push(raw); continue; }
      files.push(buildFileRelationships(id, onMap.has(id), importEdges, serviceEdges, symbolEdges, notes, limit));
    }
    return { ok: true, files, ...(unresolved.length ? { unresolved } : {}) };
  }
}

function collectRequestedPaths(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof payload.path === "string" && payload.path.trim()) out.push(payload.path.trim());
  if (Array.isArray(payload.paths)) {
    for (const value of payload.paths) if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return [...new Set(out)];
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function buildFileRelationships(
  id: string,
  onMap: boolean,
  importEdges: readonly GraphEdge[],
  serviceEdges: readonly GraphEdge[],
  symbolEdges: readonly GraphEdge[],
  notes: readonly GraphAnnotation[],
  limit: number,
): Record<string, unknown> {
  const imports = importEdges.filter((edge) => edge.from === id).map((edge) => edge.to);
  const importedBy = importEdges.filter((edge) => edge.to === id).map((edge) => edge.from);
  /* Symbol-layer edges are keyed by from/to (file paths), not the service
     source/target of relationship edges. */
  const symbolRelations = symbolEdges
    .filter((edge) => edge.from === id || edge.to === id)
    .map((edge) => ({
      kind: edge.kind,
      direction: edge.from === id ? "outbound" : "inbound",
      peerFile: edge.from === id ? edge.to : edge.from,
      symbol: edge.label,
    }));
  const serviceRelations = serviceEdges
    .filter((edge) => edge.sourcePath === id || edge.targetPath === id)
    .map((edge) => ({
      kind: edge.kind,
      label: edge.label,
      direction: edge.sourcePath === id ? "outbound" : "inbound",
      fromService: edge.serviceFrom,
      toService: edge.serviceTo,
      peerFile: edge.sourcePath === id ? edge.targetPath : edge.sourcePath,
      confidence: edge.confidence,
      detail: edge.detail,
      evidence: edge.evidence,
    }));
  const fileNotes = notes
    .filter((note) => note.from === id || note.to === id)
    .map((note) => ({ id: note.id, scope: note.scope, from: note.from, to: note.to, note: note.note }));
  return {
    path: id,
    onMap,
    importCount: imports.length,
    importedByCount: importedBy.length,
    serviceRelationCount: serviceRelations.length,
    symbolRelationCount: symbolRelations.length,
    imports: imports.slice(0, limit),
    importedBy: importedBy.slice(0, limit),
    serviceRelations: serviceRelations.slice(0, limit),
    symbolRelations: symbolRelations.slice(0, limit),
    notes: fileNotes,
    ...(onMap ? {} : { warning: "This file isn't on the rendered Codebase Map. Full indexed import and service facts are still queried when available; the file may be beyond the render cap or excluded by the indexing profile." }),
  };
}
