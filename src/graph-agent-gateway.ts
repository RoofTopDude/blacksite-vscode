/* Agent-facing dispatch surface for the Codebase Map ("graph.*" runtime types).
   Routes note ops (add/list/update/remove) to the durable annotation store and
   the map query ops (overview / relationships / impact / routes / find) to the
   live index + shared service-relationship and structural snapshots, so
   agent-session.ts can keep dispatching every graph.* op to one object without
   knowing which subsystem answers it.

   The query ops divide by question, not by data source:
     overview       — where am I? (projects, areas, hubs, flows, structure)
     find           — which files match this? (drill into an area/lang/churn)
     relationships  — what touches this file, one hop out?
     impact         — what does changing this file set reach, N hops out?
     routes         — how are these two files connected at all?
   Anything transitive lives in graph/map-queries.ts, which normalizes the four
   edge layers into one dependency-direction convention first. */

import type { GraphAnnotationContext, GraphAnnotationProvider, GraphAnnotation, GraphAnnotationStore } from "./graph-annotation-store.js";
import type { GraphIndexer } from "./graph/graph-indexer.js";
import type { RelationshipSnapshot } from "./graph/relationship-snapshot.js";
import type { StructuralSnapshot } from "./graph/structural-snapshot.js";
import type { GraphEdge, GraphNode } from "./graph/graph-model.js";
import { resolveToNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";
import type { ProjectTopology } from "./graph/project-topology.js";
import {
  buildAdjacency,
  findNodes,
  findRoutes,
  summarizeByArea,
  traverseImpact,
  MAP_LAYERS,
  type ImpactDirection,
  type MapLayer,
  type NodeSortKey,
} from "./graph/map-queries.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_IMPACT_DEPTH = 3;
const MAX_IMPACT_DEPTH = 6;
const DEFAULT_IMPACT_NODES = 200;
const MAX_IMPACT_NODES = 1000;
const DEFAULT_ROUTE_HOPS = 5;
const MAX_ROUTE_HOPS = 8;
const DEFAULT_ROUTES = 3;
const MAX_ROUTES = 10;

const NODE_SORT_KEYS: readonly NodeSortKey[] = ["degree", "dependents", "dependencies", "churn", "recency", "size", "path"];

/* Per-turn local context budget. This block is rebuilt on every model turn, so
   it is capped hard: enough to orient, never enough to crowd out the work. */
const LOCAL_CONTEXT_FILES = 4;
const LOCAL_CONTEXT_NOTES = 2;
const LOCAL_CONTEXT_PEERS = 5;

export class GraphAgentGateway implements GraphAnnotationProvider {
  constructor(
    private readonly _annotations: GraphAnnotationStore,
    private readonly _indexer: GraphIndexer,
    private readonly _relationships: RelationshipSnapshot,
    private readonly _roots: () => WorkspaceRoot[],
    /** Background symbol-layer edges (call/reference/supertype); empty when the
        opt-in sweep is off. See graph/symbol-indexer.ts. */
    private readonly _symbolEdges: () => readonly GraphEdge[] = () => [],
    /** Cycles / orphans / pockets / bridges. Optional because the same analysis
        already backs the Map webview; when it isn't wired the query ops still
        answer, just without the structural section. */
    private readonly _structure: StructuralSnapshot | null = null,
  ) {}

  async dispatch(op: string, payload: Record<string, unknown>, ctx: GraphAnnotationContext): Promise<Record<string, unknown>> {
    if (op === "overview") return this._overview(payload, { waitForRelationships: true });
    if (op === "relationships") return this._relationshipsForFiles(payload);
    if (op === "impact") return this._impact(payload);
    if (op === "routes") return this._routes(payload);
    if (op === "find") return this._find(payload);
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

  /**
   * Per-turn map neighbourhood for the files the user currently has open.
   *
   * Deliberately import-layer only and synchronous against the already-built
   * index: this runs on every turn, so it must not schedule a relationship
   * rebuild or wait on the symbol sweep the way an explicit map query may.
   * The point is a zero-tool-call answer to "what am I standing next to" —
   * area, both directions of the immediate blast radius, and the durable notes
   * on the file — for the handful of files a turn is most likely to be about.
   */
  async localOverview(paths: readonly string[]): Promise<string> {
    const snapshot = this._indexer.snapshot();
    if (!snapshot || paths.length === 0) return "";
    const roots = this._roots();
    const notes = this._annotations.list();

    /* Resolve the handful of wanted ids up front, then make exactly one pass
       over the nodes and one over the edges. This runs on every model turn, so
       it is deliberately linear in the corpus with a tiny constant rather than
       `filter`-per-file: at the large/extreme profiles the edge array reaches
       six figures, and a scan per file per direction (plus a full node Map
       built and thrown away each turn) is real blocking time on the extension
       host's single thread for a block that is only ever a few lines long. */
    const wanted: string[] = [];
    for (const raw of paths.slice(0, LOCAL_CONTEXT_FILES)) {
      const id = resolveToNodeId(roots, raw);
      if (id && !wanted.includes(id)) wanted.push(id);
    }
    if (wanted.length === 0) return "";
    const wantedSet = new Set(wanted);

    const nodesById = new Map<string, GraphNode>();
    for (const node of snapshot.nodes) {
      if (wantedSet.has(node.id)) nodesById.set(node.id, node);
    }
    const dependenciesById = new Map<string, string[]>();
    const dependentsById = new Map<string, string[]>();
    for (const edge of this._indexer.importEdges()) {
      if (wantedSet.has(edge.from)) pushInto(dependenciesById, edge.from, edge.to);
      if (wantedSet.has(edge.to)) pushInto(dependentsById, edge.to, edge.from);
    }

    const blocks: string[] = [];
    for (const id of wanted) {
      const node = nodesById.get(id);
      // Not on the map (unindexed, excluded, or beyond the render cap) — saying
      // nothing is better than implying the file has no relationships.
      if (!node) continue;

      const dependencies = dependenciesById.get(id) ?? [];
      const dependents = dependentsById.get(id) ?? [];
      const fileNotes = notes.filter((note) => note.from === id || note.to === id);

      const header = [
        `${id} [${node.neighborhood ?? node.dir}]`,
        `${dependents.length} dependents / ${dependencies.length} dependencies`,
        node.churn === undefined ? "" : `${node.churn} recent commits`,
      ].filter(Boolean).join(" · ");

      const lines = [`  ${header}`];
      if (dependents.length > 0) lines.push(`    depended on by: ${previewList(dependents)}`);
      if (dependencies.length > 0) lines.push(`    depends on: ${previewList(dependencies)}`);
      for (const note of fileNotes.slice(0, LOCAL_CONTEXT_NOTES)) {
        const tag = note.category ? `[${note.category}] ` : "";
        const heading = note.title ? `${note.title} — ` : "";
        lines.push(`    note: ${tag}${heading}${truncate(note.note, 160)}`);
      }
      blocks.push(lines.join("\n"));
    }
    return blocks.join("\n");
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
    const indexedFiles = snapshot.indexedFileCount ?? this._indexer.indexedFiles().length;
    const renderedFiles = snapshot.renderedNodeCount ?? snapshot.nodes.length;
    const structure = this._structureSummary(topology, limit, indexedFiles > renderedFiles);

    return {
      ok: true,
      indexedAt: snapshot.indexedAt,
      indexing: this._indexer.isIndexing(),
      coverage: {
        indexedFiles,
        renderedFiles,
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
      ...(structure ? { structure } : {}),
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
    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
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
      files.push(buildFileRelationships(id, nodesById.get(id), importEdges, serviceEdges, symbolEdges, notes, limit, symbolLayerActive));
    }
    return {
      ok: true,
      files,
      symbolLayer: symbolLayerActive ? "active" : "inactive",
      ...(unresolved.length ? { unresolved } : {}),
    };
  }

  /** Cross-project cycles and per-neighborhood structural roles — the same
      analysis the Map renders for the user. Returns undefined when the snapshot
      isn't wired or found nothing worth reporting, so the section stays absent
      rather than showing up as a row of empty arrays. */
  private _structureSummary(
    topology: ProjectTopology | null,
    limit: number,
    /** True when the workspace indexes more files than the map renders, so the
        roles below are computed over a projection rather than the whole corpus. */
    partialProjection: boolean,
  ): Record<string, unknown> | undefined {
    const result = this._structure?.get();
    if (!result) return undefined;
    const projectName = new Map((topology?.projects ?? []).map((project) => [project.root, project.name]));
    const cycles = result.cyclicNeighborhoodPairs
      .slice(0, limit)
      .map(([left, right]) => ({ between: [projectName.get(left) ?? left, projectName.get(right) ?? right] }));
    const summary: Record<string, unknown> = {};
    if (cycles.length > 0) summary.projectCycles = cycles;
    if (result.orphanNodeIds.length > 0) {
      summary.orphanCount = result.orphanNodeIds.length;
      summary.orphans = result.orphanNodeIds.slice(0, limit);
    }
    if (result.pocketNodeIds.length > 0) {
      summary.pocketCount = result.pocketNodeIds.length;
      summary.pockets = result.pocketNodeIds.slice(0, limit);
    }
    if (result.bridgeEdgeIds.length > 0) summary.bridgeEdgeCount = result.bridgeEdgeIds.length;
    /* "Orphan" and "single-access pocket" are claims about the whole codebase,
       but they are computed over the rendered node/edge projection. When the
       index is larger than that projection a file whose only importer fell
       outside it looks stranded when it isn't — and an agent may well delete or
       inline something on that basis. Say which one this is, matching how
       map_find flags the same limit and map_relationships flags an inactive
       symbol layer. */
    if (partialProjection && (summary.orphans || summary.pockets)) {
      summary.scopeNote = "Computed over the rendered map projection, which is smaller than the indexed corpus — verify an 'orphan' with map_relationships before treating it as unreferenced.";
    }
    return Object.keys(summary).length > 0 ? summary : undefined;
  }

  /** Direction-normalized adjacency across the requested layers. Rebuilt per
      query rather than cached: the underlying edge sets are already memoized by
      their own snapshots, and the layer mix varies call to call. */
  private async _adjacency(layers: readonly MapLayer[]) {
    const importEdges = this._indexer.importEdges();
    const needsService = layers.includes("service");
    const serviceEdges = needsService
      ? (typeof this._relationships.fullAsync === "function"
        ? await this._relationships.fullAsync()
        : this._relationships.full())
      : [];
    const symbolEdges = layers.includes("symbol") ? this._symbolEdges() : [];
    const noteEdges = layers.includes("note")
      ? this._annotations.list().map((note) => ({ from: note.from, to: note.to, title: note.title }))
      : [];
    return { adjacency: buildAdjacency({ importEdges, serviceEdges, symbolEdges, noteEdges, layers }), symbolEdges };
  }

  /**
   * Transitive blast radius. This is the query one-hop map_relationships can't
   * answer without the caller fanning out call-by-call — the thing to run before
   * changing a shared contract, not after.
   */
  private async _impact(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = collectRequestedPaths(payload);
    if (requested.length === 0) return { ok: false, error: "Provide a file path in `path`, or several in `paths`." };
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return { ok: false, error: "The Codebase Map has not finished indexing yet — try again shortly." };

    const roots = this._roots();
    const seeds: string[] = [];
    const unresolved: string[] = [];
    for (const raw of requested) {
      const id = resolveToNodeId(roots, raw);
      if (id) seeds.push(id);
      else unresolved.push(raw);
    }
    if (seeds.length === 0) {
      return { ok: false, error: `None of the requested paths resolve inside the workspace: ${unresolved.join(", ")}` };
    }

    const layers = resolveLayers(payload.layers);
    const { adjacency, symbolEdges } = await this._adjacency(layers);
    const direction = resolveDirection(payload.direction);
    const depth = clampInt(payload.depth, DEFAULT_IMPACT_DEPTH, 1, MAX_IMPACT_DEPTH);
    const maxNodes = clampInt(payload.limit, DEFAULT_IMPACT_NODES, 1, MAX_IMPACT_NODES);

    const { hits, truncated } = traverseImpact(adjacency, seeds, { direction, maxDepth: depth, maxNodes });
    const areaOf = buildAreaLookup(snapshot.nodes);
    const degreeOf = new Map(snapshot.nodes.map((node) => [node.id, node.inDegree + node.outDegree]));

    const byDepth = new Map<number, number>();
    for (const hit of hits) byDepth.set(hit.depth, (byDepth.get(hit.depth) ?? 0) + 1);

    return {
      ok: true,
      seeds,
      direction,
      depth,
      layers,
      symbolLayer: symbolEdges.length > 0 ? "active" : "inactive",
      reachedCount: hits.length,
      truncated,
      byDepth: [...byDepth].sort((left, right) => left[0] - right[0]).map(([d, files]) => ({ depth: d, files })),
      areas: summarizeByArea(hits, areaOf),
      /* Hubs inside the radius first: those are where a change is most likely to
         ripple further, so they are what a reader should look at before the tail. */
      files: [...hits]
        .sort((left, right) =>
          left.depth - right.depth
          || (degreeOf.get(right.id) ?? 0) - (degreeOf.get(left.id) ?? 0)
          || left.id.localeCompare(right.id))
        .map((hit) => ({
          path: hit.id,
          depth: hit.depth,
          relation: hit.relation,
          seed: hit.seed,
          area: areaOf(hit.id),
          via: hit.via.map((step) => `${step.from} -${step.kind}-> ${step.to}`),
        })),
      ...(unresolved.length ? { unresolved } : {}),
      ...(truncated ? { truncationHint: "Raise `limit`, lower `depth`, or narrow `layers` to see the rest." } : {}),
    };
  }

  /** Concrete connection routes between two files — "how does this reach that",
      answered with the actual edge chain rather than a yes/no. */
  private async _routes(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const roots = this._roots();
    const rawFrom = typeof payload.from === "string" ? payload.from.trim() : "";
    const rawTo = typeof payload.to === "string" ? payload.to.trim() : "";
    if (!rawFrom || !rawTo) return { ok: false, error: "Provide both `from` and `to` workspace-relative file paths." };
    if (!this._indexer.snapshot()) return { ok: false, error: "The Codebase Map has not finished indexing yet — try again shortly." };

    const from = resolveToNodeId(roots, rawFrom);
    const to = resolveToNodeId(roots, rawTo);
    const unresolved = [
      ...(from ? [] : [rawFrom]),
      ...(to ? [] : [rawTo]),
    ];
    if (!from || !to) return { ok: false, error: `Path does not resolve inside the workspace: ${unresolved.join(", ")}` };
    if (from === to) return { ok: false, error: "`from` and `to` are the same file." };

    const layers = resolveLayers(payload.layers);
    const { adjacency } = await this._adjacency(layers);
    const maxHops = clampInt(payload.maxHops, DEFAULT_ROUTE_HOPS, 1, MAX_ROUTE_HOPS);
    const maxRoutes = clampInt(payload.maxRoutes, DEFAULT_ROUTES, 1, MAX_ROUTES);
    const directedOnly = payload.directedOnly === true;

    const { routes, truncated } = findRoutes(adjacency, from, to, {
      maxHops,
      maxRoutes,
      undirected: !directedOnly,
    });

    return {
      ok: true,
      from,
      to,
      layers,
      maxHops,
      directedOnly,
      routeCount: routes.length,
      searchTruncated: truncated,
      routes: routes.map((route) => ({
        hops: route.hops,
        path: route.path,
        steps: route.steps.map((step) => ({
          from: step.from,
          to: step.to,
          kind: step.kind,
          layer: step.layer,
          ...(step.kinds && step.kinds.length > 1 ? { alsoLinkedBy: step.kinds.filter((kind) => kind !== step.kind) } : {}),
          ...(step.label ? { label: step.label } : {}),
        })),
      })),
      ...(routes.length === 0
        ? {
          hint: directedOnly
            ? `No directed dependency path within ${maxHops} hops. Retry without directedOnly, raise maxHops, or add layers (e.g. service/symbol/note) — the connection may not be an import chain.`
            : `No connection within ${maxHops} hops over layers [${layers.join(", ")}]. Raise maxHops or add layers; these files may genuinely be unrelated on the map.`,
        }
        : {}),
    };
  }

  /** Filtered drill-down into the indexed node set — the enumeration behind
      map_overview's ranked-and-truncated summaries. */
  private async _find(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return { ok: false, error: "The Codebase Map has not finished indexing yet — try again shortly." };

    const roots = this._roots();
    const rawArea = typeof payload.area === "string" && payload.area.trim() ? payload.area.trim() : undefined;
    /* An area may be given as an absolute path or a bare workspace-relative
       directory; resolveToNodeId handles files, but a directory that isn't a
       node still needs the same root-prefix normalization. */
    const area = rawArea ? (resolveToNodeId(roots, rawArea) ?? rawArea) : undefined;
    const sortBy = NODE_SORT_KEYS.includes(payload.sortBy as NodeSortKey) ? (payload.sortBy as NodeSortKey) : "degree";
    const langs = Array.isArray(payload.langs)
      ? (payload.langs as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined;

    const result = findNodes(snapshot.nodes, {
      area,
      contains: typeof payload.contains === "string" ? payload.contains.trim() : undefined,
      glob: typeof payload.glob === "string" ? payload.glob.trim() : undefined,
      langs,
      minDegree: typeof payload.minDegree === "number" ? payload.minDegree : undefined,
      minChurn: typeof payload.minChurn === "number" ? payload.minChurn : undefined,
      sortBy,
      limit: clampInt(payload.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    });

    const gitLayerActive = snapshot.nodes.some((node) => node.churn !== undefined);
    return {
      ok: true,
      sortBy,
      matched: result.matched,
      returned: result.files.length,
      renderedNodeCount: snapshot.renderedNodeCount ?? snapshot.nodes.length,
      indexedFileCount: snapshot.indexedFileCount ?? snapshot.nodes.length,
      files: result.files,
      /* churn/recency sorts are meaningless without the git layer; say so rather
         than returning a confidently-ordered list built from missing data. */
      ...(gitLayerActive ? {} : { gitLayerUnavailable: true }),
      ...(result.matched > result.files.length
        ? { more: result.matched - result.files.length, hint: "Raise `limit` or narrow the filter to see the rest." }
        : {}),
      ...(snapshot.renderedNodeCount !== undefined && snapshot.indexedFileCount !== undefined
        && snapshot.indexedFileCount > snapshot.renderedNodeCount
        ? { coverageNote: "Search covers the rendered node projection; the workspace indexes more files than the map renders." }
        : {}),
    };
  }
}

function resolveDirection(value: unknown): ImpactDirection {
  return value === "dependencies" || value === "both" ? value : "dependents";
}

function resolveLayers(value: unknown): MapLayer[] {
  if (!Array.isArray(value)) return ["import", "service", "symbol"];
  const picked = value.filter((entry): entry is MapLayer => MAP_LAYERS.includes(entry as MapLayer));
  return picked.length > 0 ? [...new Set(picked)] : ["import", "service", "symbol"];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Area (neighborhood, else cluster dir) for any id, falling back to the path's
    own leading segment for files that were reached through the uncapped edge
    sets but aren't in the rendered node list. */
function buildAreaLookup(nodes: readonly GraphNode[]): (id: string) => string {
  const byId = new Map(nodes.map((node) => [node.id, node.neighborhood ?? node.dir]));
  return (id: string) => byId.get(id) || id.split("/").slice(0, -1).join("/") || ".";
}

function collectRequestedPaths(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof payload.path === "string" && payload.path.trim()) out.push(payload.path.trim());
  if (Array.isArray(payload.paths)) {
    for (const value of payload.paths) if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return [...new Set(out)];
}

/** First few peers plus an honest "+N more", so a hub file's line stays short
    without implying its fan-out is smaller than it is. */
function previewList(paths: readonly string[]): string {
  const shown = paths.slice(0, LOCAL_CONTEXT_PEERS).join(", ");
  const rest = paths.length - LOCAL_CONTEXT_PEERS;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
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
  node: GraphNode | undefined,
  importEdges: readonly GraphEdge[],
  serviceEdges: readonly GraphEdge[],
  symbolEdges: readonly GraphEdge[],
  notes: readonly GraphAnnotation[],
  limit: number,
  symbolLayerActive: boolean,
): Record<string, unknown> {
  const onMap = node !== undefined;
  const imports = importEdges.filter((edge) => edge.from === id).map((edge) => edge.to);
  const importedBy = importEdges.filter((edge) => edge.to === id).map((edge) => edge.from);
  /* Symbol-layer edges are keyed by from/to (file paths), not the service
     source/target of relationship edges — and `reference` edges are stored
     definition→referencer (symbol-indexer asks "who references MY symbol"),
     which is the opposite of every other layer. Normalize here so `direction`
     always means the same thing: outbound = this file depends on the peer. */
  const symbolRelations = symbolEdges
    .filter((edge) => edge.from === id || edge.to === id)
    .map((edge) => {
      const dependsOnPeer = edge.kind === "reference" ? edge.to === id : edge.from === id;
      return {
        kind: edge.kind,
        direction: dependsOnPeer ? "outbound" : "inbound",
        peerFile: edge.from === id ? edge.to : edge.from,
        symbol: edge.label,
      };
    });
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
    /* Where the file sits and how hot it is — the map already knows both, and a
       caller deciding how carefully to touch a file shouldn't need a second
       call (or a git log) to find out. */
    ...(node ? { area: node.neighborhood ?? node.dir, lang: node.lang } : {}),
    ...(node?.churn === undefined ? {} : { recentCommits: node.churn }),
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
