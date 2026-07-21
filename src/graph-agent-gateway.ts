/* Agent-facing dispatch surface for the Codebase Map ("graph.*" runtime types).
   Routes note ops (add/list/update/remove) to the durable annotation store and
   map_overview / map_relationships queries to the live index + shared service-
   relationship snapshot, so agent-session.ts can keep dispatching every graph.*
   op to one object without knowing which subsystem answers it. */

import type { GraphAnnotationContext, GraphAnnotationProvider, GraphAnnotation, GraphAnnotationStore } from "./graph-annotation-store.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import type { RelationshipSnapshot } from "./graph/relationship-snapshot.js";
import type { GraphEdge } from "./graph/graph-model.js";
import { resolveToNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";
import type { ProjectTopology } from "./graph/project-topology.js";

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
    if (op === "overview") return this._overview(payload, { waitForRelationships: true });
    if (op === "relationships") return this._relationshipsForFiles(payload);
    return this._annotations.dispatch(op, payload, ctx);
  }

  /** Compact prose form injected into the live workspace context on every model turn. */
  async workspaceOverview(): Promise<string> {
    // Automatic context must never wait for a corpus-wide relationship rebuild.
    // `full()` schedules stale work in the background and returns the latest good
    // generation; an explicit map_overview call may await the fresh generation.
    const overview = await this._overview({ limit: 8 }, { waitForRelationships: false });
    if (overview.ok !== true) return String(overview.error ?? "The Codebase Map is not ready yet.");
    return formatWorkspaceOverview(overview);
  }

  private async _overview(
    payload: Record<string, unknown>,
    options: { waitForRelationships: boolean },
  ): Promise<Record<string, unknown>> {
    const snapshot = this._indexer.snapshot();
    if (!snapshot) {
      return {
        ok: false,
        indexing: this._indexer.isIndexing(),
        error: "The Codebase Map has not finished indexing yet. Continue with code intelligence and call map_overview again once the index is ready.",
      };
    }

    const limit = clampOverviewLimit(payload.limit);
    const topology = this._indexer.topology();
    const importEdges = this._indexer.importEdges();
    const serviceEdges = options.waitForRelationships && typeof this._relationships.fullAsync === "function"
      ? await this._relationships.fullAsync()
      : this._relationships.full();
    const symbolEdges = this._symbolEdges();
    const notes = this._annotations.list();

    return {
      ok: true,
      indexedAt: snapshot.indexedAt,
      indexing: this._indexer.isIndexing(),
      coverage: {
        indexedFiles: snapshot.indexedFileCount ?? this._indexer.indexedFiles().length,
        renderedFiles: snapshot.renderedNodeCount ?? snapshot.nodes.length,
        importEdges: snapshot.indexedImportEdgeCount ?? importEdges.length,
        serviceEdges: serviceEdges.length,
        symbolEdges: symbolEdges.length,
        truncated: snapshot.indexedTruncated === true || snapshot.truncated === true,
      },
      projects: summarizeProjects(topology, limit),
      projectReferences: summarizeProjectReferences(topology, limit),
      areas: summarizeAreas(snapshot.nodes, limit),
      hubs: [...snapshot.nodes]
        .sort((left, right) => (right.inDegree + right.outDegree) - (left.inDegree + left.outDegree) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((node) => ({ path: node.id, inbound: node.inDegree, outbound: node.outDegree, area: node.neighborhood ?? node.dir })),
      serviceFlows: summarizeServiceFlows(serviceEdges, limit),
      recentNotes: [...notes]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, limit)
        .map((note) => ({
          from: note.from,
          ...(note.to ? { to: note.to } : {}),
          ...(note.title ? { title: note.title } : {}),
          ...(note.category ? { category: note.category } : {}),
          ...(note.relationKind ? { relationKind: note.relationKind } : {}),
          note: note.note,
        })),
    };
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
    /* The symbol layer is an opt-in background LSP sweep. When it's off it
       produces no edges at all, so an empty `symbolRelations` on a file would
       otherwise be indistinguishable from "this file genuinely has no symbol
       relations". Surface which it is so a caller doesn't read absence as fact. */
    const symbolLayerActive = symbolEdges.length > 0;
    const notes = this._annotations.list();
    const limit = clampLimit(payload.limit);

    const files: Record<string, unknown>[] = [];
    const unresolved: string[] = [];
    for (const raw of requested) {
      const id = resolveToNodeId(roots, raw);
      if (!id) { unresolved.push(raw); continue; }
      files.push(buildFileRelationships(id, onMap.has(id), importEdges, serviceEdges, symbolEdges, notes, limit, symbolLayerActive));
    }
    return {
      ok: true,
      files,
      symbolLayer: symbolLayerActive ? "active" : "inactive",
      ...(unresolved.length ? { unresolved } : {}),
    };
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

function clampOverviewLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(30, Math.floor(n));
}

function summarizeProjects(topology: ProjectTopology | null, limit: number): Record<string, unknown>[] {
  if (!topology) return [];
  return topology.projects.slice(0, limit).map((project) => ({
    name: project.name,
    kind: project.kind,
    root: project.root,
    manifests: project.manifestFiles,
    ...(project.containerRoot ? { containerRoot: project.containerRoot } : {}),
  }));
}

function summarizeProjectReferences(topology: ProjectTopology | null, limit: number): Record<string, unknown>[] {
  if (!topology) return [];
  return topology.references.slice(0, limit).map((reference) => ({
    from: reference.from,
    to: reference.to,
    kind: reference.kind,
    ...(reference.evidence ? { evidence: reference.evidence } : {}),
  }));
}

function summarizeAreas(
  nodes: ReadonlyArray<{ id: string; dir: string; neighborhood?: string }>,
  limit: number,
): Array<{ area: string; files: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const area = node.neighborhood ?? node.dir ?? node.id.split("/")[0] ?? ".";
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts]
    .map(([area, files]) => ({ area, files }))
    .sort((left, right) => right.files - left.files || left.area.localeCompare(right.area))
    .slice(0, limit);
}

function summarizeServiceFlows(edges: readonly GraphEdge[], limit: number): Record<string, unknown>[] {
  const grouped = new Map<string, { kind: string; from: string; to: string; occurrences: number; examples: string[] }>();
  for (const edge of edges) {
    const from = edge.serviceFrom ?? edge.from;
    const to = edge.serviceTo ?? edge.to;
    const key = `${edge.kind}\u0000${from}\u0000${to}`;
    const current = grouped.get(key) ?? { kind: edge.kind, from, to, occurrences: 0, examples: [] };
    current.occurrences += edge.occurrenceCount ?? 1;
    if (edge.label && !current.examples.includes(edge.label) && current.examples.length < 3) current.examples.push(edge.label);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .sort((left, right) => right.occurrences - left.occurrences || left.from.localeCompare(right.from))
    .slice(0, limit);
}

function formatWorkspaceOverview(overview: Record<string, unknown>): string {
  const lines: string[] = [];
  const coverage = overview.coverage as Record<string, unknown> | undefined;
  if (coverage) {
    const partial = coverage.truncated === true ? " (partial index)" : "";
    lines.push(
      `Index: ${coverage.indexedFiles ?? 0} files, ${coverage.importEdges ?? 0} import edges, ${coverage.serviceEdges ?? 0} service edges, ${coverage.symbolEdges ?? 0} symbol edges${partial}.`,
    );
  }

  const addSection = (label: string, values: unknown, render: (row: Record<string, unknown>) => string): void => {
    if (!Array.isArray(values) || values.length === 0) return;
    lines.push(`${label}:`);
    for (const row of values as Record<string, unknown>[]) lines.push(`  - ${render(row)}`);
  };

  addSection("Projects", overview.projects, (row) => `${row.name} [${row.kind}] at ${row.root}`);
  addSection("Project links", overview.projectReferences, (row) => `${row.from} -> ${row.to} (${row.kind})`);
  addSection("Major areas", overview.areas, (row) => `${row.area}: ${row.files} files`);
  addSection("Dependency hubs", overview.hubs, (row) => `${row.path} (${row.inbound} in / ${row.outbound} out)`);
  addSection("Cross-service flows", overview.serviceFlows, (row) => {
    const examples = Array.isArray(row.examples) && row.examples.length > 0 ? `; ${row.examples.join(", ")}` : "";
    return `${row.from} -> ${row.to} [${row.kind}, ${row.occurrences} occurrence(s)${examples}]`;
  });
  addSection("Recent map knowledge", overview.recentNotes, (row) => {
    const tag = row.category ? `[${row.category}] ` : "";
    const heading = row.title ? `${row.title} — ` : "";
    return `${row.from}${row.to ? ` -> ${row.to}` : ""}: ${tag}${heading}${row.note}`;
  });
  return lines.join("\n");
}

function buildFileRelationships(
  id: string,
  onMap: boolean,
  importEdges: readonly GraphEdge[],
  serviceEdges: readonly GraphEdge[],
  symbolEdges: readonly GraphEdge[],
  notes: readonly GraphAnnotation[],
  limit: number,
  symbolLayerActive: boolean,
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
    .map((note) => ({
      id: note.id,
      scope: note.scope,
      from: note.from,
      to: note.to,
      title: note.title,
      category: note.category,
      relationKind: note.relationKind,
      note: note.note,
    }));
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
    ...(symbolLayerActive ? {} : { symbolRelationsUnavailable: true }),
    notes: fileNotes,
    ...(onMap ? {} : { warning: "This file isn't on the rendered Codebase Map. Full indexed import and service facts are still queried when available; the file may be beyond the render cap or excluded by the indexing profile." }),
  };
}
