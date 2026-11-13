/* Questions answered from the Codebase Map index, for agents and anything else that reads it.
   One method per question:
     overview       — where am I? (projects, areas, hubs, flows, structure)
     find           — which files match this? (drill into an area/lang/churn)
     relationships  — what touches this file, one hop out?
     impact         — what does changing this file set reach, N hops out?
     routes         — how are these two files connected at all?
   plus the two prose blocks a host can put in an agent's context every turn (workspaceOverview,
   localOverview) and a few cheap synchronous lookups. Anything transitive goes through
   map-queries.ts, which normalizes the edge layers into one dependency-direction convention first.

   Inputs are validated at runtime, so tool-call arguments can be passed through as they arrive.
   A query that cannot be answered returns { ok: false, code, message }; hosts that need their own
   wording key it off `code` (src/graph-agent-gateway.ts does, to keep the extension's tool
   messages). */

import type { GraphAnnotation } from "./notes.js";
import type { MapIndexReader, ServiceRelationshipReader } from "./index-reader.js";
import type { StructuralSnapshotResult } from "./structural-snapshot.js";
import type { WorkspaceHierarchy } from "./hierarchy.js";
import type { GraphEdge, GraphNode } from "./graph-model.js";
import { resolveToNodeId, type WorkspaceRoot } from "./workspace-roots.js";
import { owningProjectForPath, type ProjectTopology } from "./project-topology.js";
import {
  buildAdjacency,
  findNodes,
  findRoutes,
  summarizeByArea,
  traverseImpact,
  MAP_LAYERS,
  type ImpactDirection,
  type MapLayer,
  type NodeHit,
  type NodeSortKey,
} from "./map-queries.js";

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

const NOT_INDEXED = "The index has not finished building yet — try again shortly.";

/* ── Results ────────────────────────────────────────────────────────────────────────────── */

export type QueryErrorCode =
  /** The index has not been built (or loaded from cache) yet. */
  | "not_indexed"
  /** The arguments cannot be answered as given (a required path is missing, or two are the same). */
  | "bad_request"
  /** None of the given paths resolve inside the workspace. */
  | "unresolved";

export interface QueryFailure {
  ok: false;
  code: QueryErrorCode;
  message: string;
  /** For not_indexed on an overview: whether a build is running now. */
  indexing?: boolean;
}

export type QueryResult<T> = T | QueryFailure;

export interface ProjectSummary { name: string; kind: string; root: string; manifests: string[]; containerRoot?: string }
export interface ProjectReferenceSummary { from: string; to: string; kind: string; evidence?: string }
export interface CodebaseSummary { name: string; root: string; files: number; kind?: string; dependsOn?: string[]; hiddenCouplingWith?: string[] }
export interface AreaSummary { area: string; files: number }
export interface HubSummary { path: string; inbound: number; outbound: number; area: string }
export interface ServiceFlowSummary { kind: string; from: string; to: string; occurrences: number; examples: string[] }
export interface StructureSummary {
  projectCycles?: Array<{ between: [string, string] }>;
  orphanCount?: number;
  orphans?: string[];
  pocketCount?: number;
  pockets?: string[];
  bridgeEdgeCount?: number;
  /** Present when the roles were computed over a render projection smaller than the index. */
  scopeNote?: string;
}
export interface NoteSummary { from: string; to?: string; title?: string; category?: string; relationKind?: string; note: string }

export interface OverviewResult {
  ok: true;
  indexedAt: string;
  indexing: boolean;
  coverage: { indexedFiles: number; renderedFiles: number; importEdges: number; serviceEdges: number; symbolEdges: number; truncated: boolean };
  projects: ProjectSummary[];
  projectReferences: ProjectReferenceSummary[];
  codebases?: CodebaseSummary[];
  dependencyFindings?: {
    declaredButUnused: Array<{ from: string; to: string; kind: string }>;
    usedButUndeclared: Array<{ from: string; to: string; imports: number }>;
  };
  areas: AreaSummary[];
  hubs: HubSummary[];
  serviceFlows: ServiceFlowSummary[];
  structure?: StructureSummary;
  recentNotes: NoteSummary[];
}

export interface ServiceRelation {
  kind: string;
  label?: string;
  /** outbound: this file depends on the peer; inbound: the peer depends on it. */
  direction: "outbound" | "inbound";
  fromService?: string;
  toService?: string;
  peerFile?: string;
  confidence?: number;
  detail?: string;
  evidence?: string[];
}
export interface SymbolRelation { kind: string; direction: "outbound" | "inbound"; peerFile: string; symbol?: string }
export interface FileNote {
  id: string;
  scope?: "edge" | "node";
  from: string;
  to?: string;
  title?: string;
  category?: string;
  relationKind?: string;
  note: string;
}
export interface FileRelationships {
  path: string;
  onMap: boolean;
  area?: string;
  lang?: string;
  codebase?: string;
  recentCommits?: number;
  importCount: number;
  importedByCount: number;
  serviceRelationCount: number;
  symbolRelationCount: number;
  imports: string[];
  importedBy: string[];
  serviceRelations: ServiceRelation[];
  symbolRelations: SymbolRelation[];
  /** The optional symbol layer is off, so an empty symbolRelations means "not analyzed". */
  symbolRelationsUnavailable?: true;
  notes: FileNote[];
  warning?: string;
  /** Files that keep changing in the same commits (git co-change). */
  changedWith?: Array<{ peerFile: string; commits?: number; confidence?: number }>;
}
export interface RelationshipsResult {
  ok: true;
  files: FileRelationships[];
  symbolLayer: "active" | "inactive";
  unresolved?: string[];
}

export interface ImpactFile { path: string; depth: number; relation: "dependent" | "dependency"; seed: string; area: string; via: string[] }
export interface ImpactQueryResult {
  ok: true;
  seeds: string[];
  direction: ImpactDirection;
  depth: number;
  layers: MapLayer[];
  symbolLayer: "active" | "inactive";
  reachedCount: number;
  truncated: boolean;
  byDepth: Array<{ depth: number; files: number }>;
  areas: Array<{ area: string; files: number }>;
  files: ImpactFile[];
  unresolved?: string[];
  truncationHint?: string;
}

export interface RouteStepSummary { from: string; to: string; kind: string; layer: MapLayer; alsoLinkedBy?: string[]; label?: string }
export interface RoutesResult {
  ok: true;
  from: string;
  to: string;
  layers: MapLayer[];
  maxHops: number;
  directedOnly: boolean;
  routeCount: number;
  searchTruncated: boolean;
  routes: Array<{ hops: number; path: string[]; steps: RouteStepSummary[] }>;
  hint?: string;
}

export interface FindResult {
  ok: true;
  sortBy: NodeSortKey;
  matched: number;
  returned: number;
  renderedNodeCount: number;
  indexedFileCount: number;
  files: NodeHit[];
  /** churn/recency rankings are meaningless without git history. */
  gitLayerUnavailable?: true;
  more?: number;
  hint?: string;
  coverageNote?: string;
}

/* ── Queries ────────────────────────────────────────────────────────────────────────────── */

export interface OverviewQuery { limit?: number }
export interface PathsQuery { path?: string; paths?: readonly string[]; limit?: number }
export interface ImpactQuery { path?: string; paths?: readonly string[]; direction?: ImpactDirection; depth?: number; layers?: readonly MapLayer[]; limit?: number }
export interface RoutesQuery { from?: string; to?: string; maxHops?: number; maxRoutes?: number; layers?: readonly MapLayer[]; directedOnly?: boolean }
export interface FindQuery {
  area?: string;
  codebase?: string;
  contains?: string;
  glob?: string;
  langs?: readonly string[];
  minDegree?: number;
  minChurn?: number;
  sortBy?: NodeSortKey;
  limit?: number;
}

export interface NoteSource {
  list(): readonly GraphAnnotation[];
}

export interface MapQueryServiceOptions {
  index: MapIndexReader;
  relationships: ServiceRelationshipReader;
  roots: () => readonly WorkspaceRoot[];
  notes: NoteSource;
  /** Symbol-layer edges (call/reference/supertype); empty when no symbol source runs. */
  symbolEdges?: () => readonly GraphEdge[];
  /** Cycles / orphans / pockets / bridges. Without it the overview has no structure section. */
  structure?: { get(): StructuralSnapshotResult } | null;
  /** Codebase-level relationships and dependency findings. Without it the overview has neither. */
  hierarchy?: { get(): WorkspaceHierarchy } | null;
}

function fail(code: QueryErrorCode, message: string, indexing?: boolean): QueryFailure {
  return indexing === undefined ? { ok: false, code, message } : { ok: false, code, message, indexing };
}

export class MapQueryService {
  private readonly _indexer: MapIndexReader;
  private readonly _relationships: ServiceRelationshipReader;
  private readonly _roots: () => readonly WorkspaceRoot[];
  private readonly _notes: NoteSource;
  private readonly _symbolEdges: () => readonly GraphEdge[];
  private readonly _structure: { get(): StructuralSnapshotResult } | null;
  private readonly _hierarchy: { get(): WorkspaceHierarchy } | null;
  private _fileSet: { source: GraphNode[]; ids: Set<string> } | undefined;

  constructor(options: MapQueryServiceOptions) {
    this._indexer = options.index;
    this._relationships = options.relationships;
    this._roots = options.roots;
    this._notes = options.notes;
    this._symbolEdges = options.symbolEdges ?? (() => []);
    this._structure = options.structure ?? null;
    this._hierarchy = options.hierarchy ?? null;
  }

  /** Every indexed file as a node — a superset of the rendered projection
      whenever the render cap truncates. An empty node index falls back to the
      rendered snapshot. */
  private _nodes(): GraphNode[] {
    const index = this._indexer.nodeIndex();
    if (index.length > 0) return index;
    return this._indexer.snapshot()?.nodes ?? [];
  }

  private _cochange(): GraphEdge[] {
    return this._indexer.cochangeEdges();
  }

  /** Whether a workspace-relative file is on the map. Synchronous, against the index already built. */
  hasFile(path: string): boolean {
    const nodes = this._nodes();
    if (this._fileSet?.source !== nodes) this._fileSet = { source: nodes, ids: new Set(nodes.map((node) => node.id)) };
    return this._fileSet.ids.has(path.replace(/\\/g, "/").replace(/^\.\//, ""));
  }

  /**
   * Files that import any of these, one hop, from the import layer already indexed. Synchronous and
   * best-effort: it never schedules a rebuild, so a file indexed since the last pass may be missed.
   */
  importDependents(paths: readonly string[]): string[] {
    const snapshot = this._indexer.snapshot();
    if (!snapshot || paths.length === 0) return [];
    const wanted = new Set(paths.map((entry) => entry.replace(/\\/g, "/")));
    const out = new Set<string>();
    for (const edge of snapshot.edges) {
      if (edge.kind === "import" && wanted.has(edge.to) && !wanted.has(edge.from)) out.add(edge.from);
    }
    return [...out].sort();
  }

  async syncIndex(): Promise<{ appliedChanges: number }> {
    return { appliedChanges: await this._indexer.flushPending() };
  }

  projectRootOf(value: string): string | undefined {
    const topology = this._indexer.topology();
    if (!topology) return undefined;
    const id = resolveToNodeId(this._roots(), value);
    if (!id) return undefined;
    return owningProjectForPath(topology, id)?.root ?? "";
  }

  isMapIndexable(value: string): boolean {
    const id = resolveToNodeId(this._roots(), value);
    if (!id) return false;
    return !this._indexer.isExcludedPath(id);
  }

  /** Compact prose form of the overview, for an agent's context on every turn. Never waits for a
      relationship rebuild: it reports the latest good generation. */
  async workspaceOverview(): Promise<string> {
    const overview = await this.overview({ limit: 8 }, { waitForRelationships: false });
    return overview.ok ? formatWorkspaceOverview(overview) : overview.message;
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
    const notes = this._notes.list();

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
    for (const node of this._nodes()) {
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

  /** Where am I: projects, codebases, areas, hubs, service flows, structure, recent notes.
      `waitForRelationships: false` reports the latest good relationship generation instead of
      waiting for a fresh one (what the per-turn context block wants). */
  async overview(
    query: OverviewQuery = {},
    options: { waitForRelationships?: boolean } = {},
  ): Promise<QueryResult<OverviewResult>> {
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return fail("not_indexed", NOT_INDEXED, this._indexer.isIndexing());

    const limit = clampOverviewLimit(query.limit);
    const topology = this._indexer.topology();
    const importEdges = this._indexer.importEdges();
    const serviceEdges = options.waitForRelationships !== false
      ? await this._relationships.fullAsync()
      : this._relationships.full();
    const symbolEdges = this._symbolEdges();
    const notes = this._notes.list();
    const indexedFiles = snapshot.indexedFileCount ?? this._indexer.indexedFiles().length;
    const renderedFiles = snapshot.renderedNodeCount ?? snapshot.nodes.length;
    const structure = this._structureSummary(topology, limit, indexedFiles > renderedFiles);
    const nodes = this._nodes();
    const hierarchy = this._hierarchy?.get();
    const codebases = hierarchy ? summarizeCodebases(hierarchy, limit) : [];

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
      ...(codebases.length > 0 ? { codebases } : {}),
      ...(hierarchy && (hierarchy.declaredUnused.length > 0 || hierarchy.usedUndeclared.length > 0)
        ? {
          dependencyFindings: {
            declaredButUnused: hierarchy.declaredUnused.slice(0, limit).map((f) => ({ from: f.fromName, to: f.toName, kind: f.kind })),
            usedButUndeclared: hierarchy.usedUndeclared.slice(0, limit).map((f) => ({ from: f.fromName, to: f.toName, imports: f.imports })),
          },
        }
        : {}),
      areas: summarizeAreas(nodes, limit),
      hubs: [...nodes]
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

  /** One hop out from each file, every layer, plus the file's own area, language and churn. */
  async relationships(query: PathsQuery): Promise<QueryResult<RelationshipsResult>> {
    const payload = query as Readonly<Record<string, unknown>>;
    const requested = collectRequestedPaths(payload);
    if (requested.length === 0) return fail("bad_request", "Provide a file path in `path`, or several in `paths`.");
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return fail("not_indexed", NOT_INDEXED);

    const roots = this._roots();
    const nodesById = new Map(this._nodes().map((node) => [node.id, node]));
    const renderedIds = new Set(snapshot.nodes.map((node) => node.id));
    const cochange = this._cochange();
    const importEdges = this._indexer.importEdges();
    /* The agent view is uncapped — relationship edges here are the full corpus
       set, not the render projection. */
    const serviceEdges = await this._relationships.fullAsync();
    const symbolEdges = this._symbolEdges();
    /* The symbol layer is an opt-in background LSP sweep. When it's off it
       produces no edges at all, so an empty `symbolRelations` on a file would
       otherwise be indistinguishable from "this file genuinely has no symbol
       relations". Surface which it is so a caller doesn't read absence as fact. */
    const symbolLayerActive = symbolEdges.length > 0;
    const notes = this._notes.list();
    const limit = clampLimit(payload.limit);

    const files: FileRelationships[] = [];
    const unresolved: string[] = [];
    for (const raw of requested) {
      const id = resolveToNodeId(roots, raw);
      if (!id) { unresolved.push(raw); continue; }
      const entry = buildFileRelationships(id, nodesById.get(id), importEdges, serviceEdges, symbolEdges, notes, limit, symbolLayerActive, renderedIds.has(id));
      const changedWith = cochange
        .filter((edge) => edge.from === id || edge.to === id)
        .sort((a, b) => (b.occurrenceCount ?? 0) - (a.occurrenceCount ?? 0))
        .slice(0, limit)
        .map((edge) => ({ peerFile: edge.from === id ? edge.to : edge.from, commits: edge.occurrenceCount, confidence: edge.confidence }));
      if (changedWith.length > 0) entry.changedWith = changedWith;
      files.push(entry);
    }
    return {
      ok: true,
      files,
      symbolLayer: symbolLayerActive ? "active" : "inactive",
      ...(unresolved.length ? { unresolved } : {}),
    };
  }

  /**
   * Transitive blast radius. This is the query one-hop relationships() can't
   * answer without the caller fanning out call-by-call — the thing to run before
   * changing a shared contract, not after.
   */
  async impact(query: ImpactQuery): Promise<QueryResult<ImpactQueryResult>> {
    const payload = query as Readonly<Record<string, unknown>>;
    const requested = collectRequestedPaths(payload);
    if (requested.length === 0) return fail("bad_request", "Provide a file path in `path`, or several in `paths`.");
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return fail("not_indexed", NOT_INDEXED);

    const roots = this._roots();
    const seeds: string[] = [];
    const unresolved: string[] = [];
    for (const raw of requested) {
      const id = resolveToNodeId(roots, raw);
      if (id) seeds.push(id);
      else unresolved.push(raw);
    }
    if (seeds.length === 0) {
      return fail("unresolved", `None of the requested paths resolve inside the workspace: ${unresolved.join(", ")}`);
    }

    const layers = resolveLayers(payload.layers);
    const { adjacency, symbolEdges } = await this._adjacency(layers);
    const direction = resolveDirection(payload.direction);
    const depth = clampInt(payload.depth, DEFAULT_IMPACT_DEPTH, 1, MAX_IMPACT_DEPTH);
    const maxNodes = clampInt(payload.limit, DEFAULT_IMPACT_NODES, 1, MAX_IMPACT_NODES);

    const { hits, truncated } = traverseImpact(adjacency, seeds, { direction, maxDepth: depth, maxNodes });
    const indexNodes = this._nodes();
    const areaOf = buildAreaLookup(indexNodes);
    const degreeOf = new Map(indexNodes.map((node) => [node.id, node.inDegree + node.outDegree]));

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
  async routes(query: RoutesQuery): Promise<QueryResult<RoutesResult>> {
    const payload = query as Readonly<Record<string, unknown>>;
    const roots = this._roots();
    const rawFrom = typeof payload.from === "string" ? payload.from.trim() : "";
    const rawTo = typeof payload.to === "string" ? payload.to.trim() : "";
    if (!rawFrom || !rawTo) return fail("bad_request", "Provide both `from` and `to` workspace-relative file paths.");
    if (!this._indexer.snapshot()) return fail("not_indexed", NOT_INDEXED);

    const from = resolveToNodeId(roots, rawFrom);
    const to = resolveToNodeId(roots, rawTo);
    const unresolved = [
      ...(from ? [] : [rawFrom]),
      ...(to ? [] : [rawTo]),
    ];
    if (!from || !to) return fail("unresolved", `Path does not resolve inside the workspace: ${unresolved.join(", ")}`);
    if (from === to) return fail("bad_request", "`from` and `to` are the same file.");

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
      overview's ranked-and-truncated summaries. */
  async find(query: FindQuery = {}): Promise<QueryResult<FindResult>> {
    const payload = query as Readonly<Record<string, unknown>>;
    const snapshot = this._indexer.snapshot();
    if (!snapshot) return fail("not_indexed", NOT_INDEXED);

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

    const indexNodes = this._nodes();
    const result = findNodes(indexNodes, {
      area,
      codebase: typeof payload.codebase === "string" && payload.codebase.trim() ? payload.codebase.trim() : undefined,
      contains: typeof payload.contains === "string" ? payload.contains.trim() : undefined,
      glob: typeof payload.glob === "string" ? payload.glob.trim() : undefined,
      langs,
      minDegree: typeof payload.minDegree === "number" ? payload.minDegree : undefined,
      minChurn: typeof payload.minChurn === "number" ? payload.minChurn : undefined,
      sortBy,
      limit: clampInt(payload.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    });

    const gitLayerActive = indexNodes.some((node) => node.churn !== undefined);
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
      ...(gitLayerActive ? {} : { gitLayerUnavailable: true as const }),
      ...(result.matched > result.files.length
        ? { more: result.matched - result.files.length, hint: "Raise `limit` or narrow the filter to see the rest." }
        : {}),
      ...(indexNodes.length < (snapshot.indexedFileCount ?? 0)
        ? { coverageNote: "Search covers the files laid out so far; the background index has not finished every indexed file yet." }
        : {}),
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
  ): StructureSummary | undefined {
    const result = this._structure?.get();
    if (!result) return undefined;
    const projectName = new Map((topology?.projects ?? []).map((project) => [project.root, project.name]));
    const cycles = result.cyclicNeighborhoodPairs
      .slice(0, limit)
      .map(([left, right]): { between: [string, string] } => ({ between: [projectName.get(left) ?? left, projectName.get(right) ?? right] }));
    const summary: StructureSummary = {};
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
       find() flags the same limit and relationships() flags an inactive
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
    const serviceEdges = needsService ? await this._relationships.fullAsync() : [];
    const symbolEdges = layers.includes("symbol") ? this._symbolEdges() : [];
    const noteEdges = layers.includes("note")
      ? this._notes.list().map((note) => ({ from: note.from, to: note.to, title: note.title }))
      : [];
    const cochangeEdges = layers.includes("history") ? this._cochange() : [];
    return { adjacency: buildAdjacency({ importEdges, serviceEdges, symbolEdges, noteEdges, cochangeEdges, layers }), symbolEdges };
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

function collectRequestedPaths(payload: Readonly<Record<string, unknown>>): string[] {
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

function summarizeProjects(topology: ProjectTopology | null, limit: number): ProjectSummary[] {
  if (!topology) return [];
  return topology.projects.slice(0, limit).map((project) => ({
    name: project.name,
    kind: project.kind,
    root: project.root,
    manifests: project.manifestFiles,
    ...(project.containerRoot ? { containerRoot: project.containerRoot } : {}),
  }));
}

function summarizeProjectReferences(topology: ProjectTopology | null, limit: number): ProjectReferenceSummary[] {
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
): AreaSummary[] {
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

function summarizeServiceFlows(edges: readonly GraphEdge[], limit: number): ServiceFlowSummary[] {
  const grouped = new Map<string, ServiceFlowSummary>();
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

/** The overview as the compact prose block an agent gets in its context each turn. */
export function formatWorkspaceOverview(overview: OverviewResult): string {
  const lines: string[] = [];
  const coverage = overview.coverage;
  if (coverage) {
    const partial = coverage.truncated === true ? " (partial index)" : "";
    lines.push(
      `Index: ${coverage.indexedFiles ?? 0} files, ${coverage.importEdges ?? 0} import edges, ${coverage.serviceEdges ?? 0} service edges, ${coverage.symbolEdges ?? 0} symbol edges${partial}.`,
    );
  }

  const addSection = <T>(label: string, values: readonly T[] | undefined, render: (row: T) => string): void => {
    if (!Array.isArray(values) || values.length === 0) return;
    lines.push(`${label}:`);
    for (const row of values) lines.push(`  - ${render(row)}`);
  };

  addSection("Codebases", overview.codebases, (row) => {
    const links = Array.isArray(row.dependsOn) && row.dependsOn.length > 0 ? `; depends on ${row.dependsOn.join(", ")}` : "";
    return `${row.name} (${row.files} files${row.root ? ` in ${row.root}` : ""})${links}`;
  });
  addSection("Projects", overview.projects, (row) => `${row.name} [${row.kind}] at ${row.root}`);
  addSection("Project links", overview.projectReferences, (row) => `${row.from} -> ${row.to} (${row.kind})`);
  const findings = overview.dependencyFindings;
  addSection("Imports no manifest declares", findings?.usedButUndeclared, (row) => `${row.from} -> ${row.to} (${row.imports} imports)`);
  addSection("Declared dependencies with no imports", findings?.declaredButUnused, (row) => `${row.from} -> ${row.to} (${row.kind})`);
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
  rendered = node !== undefined,
): FileRelationships {
  const onMap = rendered;
  const imports = importEdges.filter((edge) => edge.from === id).map((edge) => edge.to);
  const importedBy = importEdges.filter((edge) => edge.to === id).map((edge) => edge.from);
  /* Symbol-layer edges are keyed by from/to (file paths), not the service
     source/target of relationship edges — and `reference` edges are stored
     definition→referencer (symbol-indexer asks "who references MY symbol"),
     which is the opposite of every other layer. Normalize here so `direction`
     always means the same thing: outbound = this file depends on the peer. */
  const symbolRelations = symbolEdges
    .filter((edge) => edge.from === id || edge.to === id)
    .map((edge): SymbolRelation => {
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
    .map((edge): ServiceRelation => ({
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
    .map((note): FileNote => ({
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
    ...(node?.codebase ? { codebase: node.codebase } : {}),
    ...(node?.churn === undefined ? {} : { recentCommits: node.churn }),
    importCount: imports.length,
    importedByCount: importedBy.length,
    serviceRelationCount: serviceRelations.length,
    symbolRelationCount: symbolRelations.length,
    imports: imports.slice(0, limit),
    importedBy: importedBy.slice(0, limit),
    serviceRelations: serviceRelations.slice(0, limit),
    symbolRelations: symbolRelations.slice(0, limit),
    ...(symbolLayerActive ? {} : { symbolRelationsUnavailable: true as const }),
    notes: fileNotes,
    ...(onMap ? {} : { warning: node
      ? "This file is indexed but outside the rendered Codebase Map sample; its import and service facts above are complete."
      : "This file isn't on the Codebase Map index. Full indexed import and service facts are still queried when available; the file may be beyond the index cap or excluded by the indexing profile." }),
  };
}

/** Codebases from the hierarchy, largest first, each with the codebases it
    depends on (imports, routes, or declared references at its own level) and
    any hidden coupling (co-change no structural link explains). */
function summarizeCodebases(hierarchy: WorkspaceHierarchy, limit: number): CodebaseSummary[] {
  const hasCodebaseChild = new Set(hierarchy.groups.filter((g) => g.level === "codebase" && g.parent).map((g) => g.parent!));
  const top = hierarchy.groups.filter((group) => group.level === "codebase" || (group.level === "root" && !hasCodebaseChild.has(group.id)));
  if (top.length < 2) return [];
  const label = new Map(hierarchy.groups.map((group) => [group.id, group.label]));
  return top.slice(0, limit).map((group) => {
    const outgoing = hierarchy.edges
      .filter((edge) => edge.from === group.id && edge.kind !== "cochange" && edge.level === "systems")
      .sort((a, b) => b.count - a.count);
    const dependsOn = [...new Set(outgoing.map((edge) => label.get(edge.to) ?? edge.to))].slice(0, 6);
    const coupled = hierarchy.edges
      .filter((edge) => edge.kind === "cochange" && edge.unexplained && edge.level === "systems" && (edge.from === group.id || edge.to === group.id))
      .map((edge) => label.get(edge.from === group.id ? edge.to : edge.from) ?? "");
    return {
      name: group.label,
      root: group.key,
      files: group.fileCount,
      ...(group.projectKind ? { kind: group.projectKind } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(coupled.length > 0 ? { hiddenCouplingWith: [...new Set(coupled)].slice(0, 6) } : {}),
    };
  });
}
