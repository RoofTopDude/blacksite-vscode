/* Host-side indexer for the Codebase Map: discovers workspace files, runs the
   full rebuild as a background job (graph/index-job.ts, in the worker when one
   is available), caches the result at .blacksite/graph-cache.json, and watches
   the workspace for incremental updates. Derived data only — annotations live
   in graph-annotation-store.

   What stays on this (extension host) thread is what needs the VS Code API or
   is cheap: discovery, git, the watcher, small incremental passes over cached
   per-file facts, and the render projection. Reading, extracting, resolving,
   and laying out tens of thousands of files happens in the worker. */

import * as fs from "fs";
import * as path from "path";
// The plain reader, not readJsonDocument: this cache is derived from the workspace, so an
// unreadable one correctly means "re-index" rather than "recover the previous copy".
import { readJsonFile } from "../shared/durable-file.js";
import * as vscode from "vscode";
import {
  clusterDir,
  depthFromDegree,
  importEdgeId,
  incrementalClusterDir,
  langOf,
  normalizeGraphPath,
  sampleAcrossClusters,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./graph-model.js";
import type { ResolveContext } from "./resolve-imports.js";
import { placeNearCluster } from "./layout.js";
import { collectGitHistory, normalizeAbsPath, type GitFileStat } from "./git-log.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./workspace-roots.js";
import { PROFILE_CAPS, type GraphConfig, type GraphPerformanceProfile } from "./config.js";
import { CORPUS_SCHEMA_VERSION } from "./corpus.js";
import { isGraphIndexablePath, isGraphManifestPath } from "./file-discovery.js";
import {
  buildExcludeGlob,
  exclusionPolicy,
  exclusionPolicyKey,
  hasExcludedSegment,
  type ExclusionPolicy,
} from "./exclusions.js";
import type { ProjectTopology } from "./project-topology.js";
import { gitToplevel, groupRootsByRepo, ignoredPaths, listRepoFiles } from "./git-discovery.js";
import { GraphWorkerClient, JobCancelledError, type RunningJob } from "./graph-worker-client.js";
import { isTopologyManifest, MAX_IMPORT_FILE_BYTES, type IndexJobResult, type IndexPhase } from "./index-job.js";
import type { RelationshipJobResult } from "./relationship-job.js";
import { declaredTypeNames, extractFileFacts, finalizeRefs, type FileFacts } from "./file-facts.js";
import { buildResolveContextFromFacts, isResolverManifest, resolveTargetsFromFacts } from "./scan-pipeline.js";
import { cochangeEdges, cochangePairs } from "./cochange.js";

const BLACKSITE_DIR = ".blacksite";
const CACHE_FILE = "graph-cache.json";
const FACTS_FILE = "graph-facts.json";
const RELATIONSHIP_CACHE_FILE = "graph-relationships.json";
/* The canonical corpus manifest — the full file set + true counts, persisted
   separately from the render cache so the render cache stays a cheap derived
   artifact. See graph/corpus.ts. */
const CORPUS_FILE = "corpus.json";
/* v2: node ids became folder-qualified in multi-root workspaces and layout
   packing changed. v3: nodes carry git churn/lastCommitAt for the heat layer.
   v4: cache records separate indexed/rendered capacity metadata.
   v5: import resolution gained C# namespace/type edges and relation-aware
   cluster layout targets, so older caches would paint a materially different
   map before the background rebuild catches up.
   v6: host-side project topology now biases layout, so pre-topology caches
   would paint a materially different map before the background rebuild.
   v7: nodes carry a neighborhood key and large multi-codebase workspaces lay
   out as separated territories, so a pre-neighborhood cache paints a materially
   different (flat) map before the rebuild catches up.
   v9: import resolution/scanning moved from the rendered star sample to the
   full indexed corpus; rendered degrees and edges are now a projection of
   that canonical adjacency.
   Older caches are discarded (they'd render wrong/stale data and, worse, look
   "complete" enough to suppress a rebuild). */
/* v8 refreshes persisted positions for the degree-aware hub layout. Keeping a
   v7 cache would leave upgraded workspaces on the old uniform-spring knot
   until somebody happened to trigger a manual rebuild.
   v10: import scanning gained Rust `use` edges, Python source-root/absolute and
   __init__.py re-export resolution, and manifest/orchestration dependency edges
   (Cargo/requirements/Makefile/compose), and file discovery now admits
   requirements.txt/Makefile/*.mk nodes — a v9 cache would paint a materially
   sparser map until the background rebuild catches up.
   v11: file discovery admits .env* and nginx-style conf files (client-config
   evidence for the service lens), and service relationships are rebuilt on
   verified HTTP-client matching — a v10 corpus lacks the config files the new
   detector reads.
   v12: API edges moved to segment-level path-shape matching (literal vs
   dynamic segments on both sides) and route/client detection gained Flask
   methods=/Django/PHP/Rust/gorilla/JAX-RS providers plus fetch-options/axios-
   config/httpx/Guzzle/reqwest/java.net.http consumers; routes compose their
   controller/group/mount/basePath prefixes, compose published ports resolve
   localhost clients, gRPC stub variables bind to their proto service, and
   test files no longer feed the service lens — a v11 cache carries edges the
   new matcher would score differently and misses whole languages.
   v13: file discovery excludes dot-directories by default, so a v12 cache
   carries tooling/fixture nodes the new corpus does not — it would paint a
   materially denser map, and its layout was solved against a node set that no
   longer exists. The cache also carries `policyKey` from here on: a version
   bump alone can't catch a user *changing* the policy, and a cache built under
   a different one describes a file set that no longer exists. */
/* v14: keep cross-folder springs at the folder level and separate the final
   occupied folder bounds, including room for their visible outlines.
   v15: discovery honours .gitignore (git ls-files), bare specifiers resolve to
   workspace packages across roots, the layout covers every indexed file (not
   just the rendered sample), and nodes carry `codebase`. A v14 cache describes
   a different corpus with sparser cross-project edges. */
const CACHE_SCHEMA_VERSION = 15;
/* How far back the git heat layer looks. Bounded so `git log` stays fast and
   its output fits maxBuffer on very active repos. */
const GIT_MAX_COMMITS = 4000;
/* Safety ceiling on the raw pre-filter directory scan per root — high enough
   that real projects (after the exclude glob prunes node_modules/dist/etc.) never
   hit it, so the full tree is seen before deciding what to display. Deciding
   truncation from a small raw cap instead of the true count is what starves
   deeply-nested folders off the map on large projects. */
const RAW_SCAN_CAP = 200_000;

/** When the user hasn't explicitly picked a capacity profile (still on the
    "balanced" default), a workspace bigger than "balanced" was tuned for —
    several sub-project folders under one parent, 15k+ files — would
    otherwise render as a heavily truncated sliver with no obvious way to
    know a bigger tier exists. Auto-escalate to the smallest tier that
    comfortably covers the true file count instead. Any explicit profile
    choice (including deliberately staying on "safe" for a slower machine)
    is left alone — this only ever moves the implicit default upward. */
export function autoEscalatedProfile(trueFileCount: number): Extract<GraphPerformanceProfile, "large" | "extreme"> | null {
  if (trueFileCount > PROFILE_CAPS.large.maxIndexedFiles) return "extreme";
  if (trueFileCount > PROFILE_CAPS.balanced.maxIndexedFiles) return "large";
  return null;
}

/** Project indexed imports onto the rendered star set without mutating the
    canonical map. Corpus-wide callers keep the original map for accurate
    degree, agent, and relationship queries. */
export function renderedImportProjection(
  indexedImports: ReadonlyMap<string, readonly string[]>,
  renderedFiles: ReadonlySet<string>,
): Map<string, string[]> {
  const projected = new Map<string, string[]>();
  for (const [from, targets] of indexedImports) {
    if (!renderedFiles.has(from)) continue;
    const visibleTargets = targets.filter((to) => renderedFiles.has(to));
    if (visibleTargets.length > 0) projected.set(from, visibleTargets);
  }
  return projected;
}

/** Diff two rendered projections into a patch the webview can apply. Pure. */
export function diffSnapshots(
  base: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
  next: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
  baseSeq: number,
): GraphDelta {
  const before = new Map(base.nodes.map((node) => [node.id, node]));
  const upsertNodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const node of next.nodes) {
    seen.add(node.id);
    const prior = before.get(node.id);
    if (!prior
      || prior.inDegree !== node.inDegree
      || prior.outDegree !== node.outDegree
      || prior.sizeBytes !== node.sizeBytes
      || prior.z !== node.z
      || prior.x !== node.x
      || prior.y !== node.y
      || prior.dir !== node.dir) {
      upsertNodes.push(node);
    }
  }
  const removeNodeIds = base.nodes.filter((node) => !seen.has(node.id)).map((node) => node.id);
  const beforeEdges = new Set(base.edges.map((edge) => edge.id));
  const afterEdges = new Set(next.edges.map((edge) => edge.id));
  return {
    baseSeq,
    upsertNodes,
    removeNodeIds,
    addEdges: next.edges.filter((edge) => !beforeEdges.has(edge.id)),
    removeEdgeIds: base.edges.filter((edge) => !afterEdges.has(edge.id)).map((edge) => edge.id),
  };
}

interface CacheDocument {
  schemaVersion: number;
  /** Identity of the exclusion policy this cache was built under. A mismatch
      means the corpus it describes no longer exists — see exclusionPolicyKey. */
  policyKey?: string;
  seed: number;
  indexedAt: string;
  hiddenByPolicyCount?: number;
  truncated: boolean;
  indexedTruncated?: boolean;
  renderedTruncated?: boolean;
  indexedFileCount?: number;
  renderedNodeCount?: number;
  indexedImportEdgeCount?: number;
  renderedImportEdgeCount?: number;
  gitignoreApplied?: boolean;
  nodes: GraphNode[];
  importEdges: GraphEdge[];
  /** Positions for indexed files outside the render sample (id, x, y), so a
      scope can show them before the first background rebuild finishes. */
  offMapPositions?: Array<[string, number, number]>;
}

/** Read a persisted cache, rejecting anything that no longer describes this
    workspace: a stale schema, or — since v13 — one built under a different
    exclusion policy. Both cases must rebuild rather than render, because a
    kept cache looks "complete" enough to suppress the rebuild that would fix
    it, leaving the user staring at a map their setting change did not move. */
export function normalizeCache(value: unknown, expectedPolicyKey?: string): CacheDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (!Array.isArray(record.nodes) || !Array.isArray(record.importEdges)) return null;
  const policyKey = typeof record.policyKey === "string" ? record.policyKey : undefined;
  if (expectedPolicyKey !== undefined && policyKey !== expectedPolicyKey) return null;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    policyKey,
    seed: typeof record.seed === "number" ? record.seed : 1,
    indexedAt: typeof record.indexedAt === "string" ? record.indexedAt : new Date().toISOString(),
    hiddenByPolicyCount: typeof record.hiddenByPolicyCount === "number" ? record.hiddenByPolicyCount : undefined,
    truncated: record.truncated === true,
    indexedTruncated: record.indexedTruncated === true,
    renderedTruncated: record.renderedTruncated === true,
    indexedFileCount: typeof record.indexedFileCount === "number" ? record.indexedFileCount : undefined,
    renderedNodeCount: typeof record.renderedNodeCount === "number" ? record.renderedNodeCount : undefined,
    indexedImportEdgeCount: typeof record.indexedImportEdgeCount === "number" ? record.indexedImportEdgeCount : undefined,
    renderedImportEdgeCount: typeof record.renderedImportEdgeCount === "number" ? record.renderedImportEdgeCount : undefined,
    gitignoreApplied: record.gitignoreApplied === true,
    nodes: record.nodes as GraphNode[],
    importEdges: record.importEdges as GraphEdge[],
    offMapPositions: Array.isArray(record.offMapPositions) ? record.offMapPositions as Array<[string, number, number]> : undefined,
  };
}

export interface GraphIndexerOptions {
  /** Absolute path of out/graph-worker.js. Null/absent runs jobs inline. */
  workerScript?: string | null;
}

export interface IndexingProgress {
  phase: "discover" | IndexPhase;
  fraction: number;
}

export class GraphIndexer implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<GraphSnapshot>();
  readonly onDidChange = this._emitter.event;

  private readonly _indexingEmitter = new vscode.EventEmitter<boolean>();
  readonly onIndexingChanged = this._indexingEmitter.event;

  private readonly _progressEmitter = new vscode.EventEmitter<IndexingProgress>();
  readonly onProgress = this._progressEmitter.event;

  private _snapshot: GraphSnapshot | null = null;
  private _seed = 1;
  private _seq = 0;
  private _watcher: vscode.Disposable | null = null;
  private _debounce: ReturnType<typeof setTimeout> | undefined;
  private _rebuilding = false;
  private _rebuildQueued = false;
  private _disposed = false;
  /** Paths touched since the last incremental pass. */
  private readonly _dirty = new Set<string>();
  private _changedSinceLayout = 0;
  private _indexedFiles: string[] = [];
  /** Every import edge discovered across `_indexedFiles`, including edges
      whose endpoints are outside the rendered star projection. The render
      snapshot intentionally keeps only edges with two visible endpoints;
      agent queries and future projections read this canonical adjacency. */
  private _indexedImportEdges: GraphEdge[] = [];
  /** The full corpus file set — every eligible file (bounded only by
      RAW_SCAN_CAP), before any render/relationship projection. Relationship
      indexing and the persisted corpus read from this, so "all relationships"
      means all of the workspace, not just the rendered slice. */
  private _corpusFiles: string[] = [];
  /** Every indexed file as a laid-out node (the render snapshot is a sample of
      these). Scope fill-in, the hierarchy, and agent queries read this. */
  private _indexNodes = new Map<string, GraphNode>();
  /** Per-file facts from the last job, kept current by the incremental pass. */
  private _facts = new Map<string, FileFacts>();
  private _resolveCtx: ResolveContext | null = null;
  /** Host-only project/workspace topology from the last full rebuild. */
  private _cachedTopology: ProjectTopology | null = null;
  private _cochange: GraphEdge[] = [];
  /** Repo toplevel per root path (null = not a repo), from the last discovery. */
  private _toplevels = new Map<string, string | null>();
  private _gitignoreApplied = false;
  /** The maxRenderedStars actually used to build `_snapshot`, which can be
      higher than `this._config().maxRenderedStars` when autoEscalatedProfile()
      raised it for this workspace (see `_enumerate`). `_applyDirty` must
      compare against this, not the raw config value — otherwise, once
      escalated, `nodesById.size` (already at the escalated count) reads as
      "at cap" against the un-escalated config number on every single
      incremental edit, forcing a full rebuild instead of the cheap
      incremental path this method exists for. */
  private _effectiveMaxRenderedStars = 100;
  /** Indexable files the exclusion policy dropped on the last enumerate.
      Reported on the snapshot so the map can say what it is not showing. */
  private _hiddenByPolicyCount = 0;
  private _runningJob: RunningJob<IndexJobResult> | null = null;
  private readonly _worker: GraphWorkerClient;

  private _foldersWatcher: vscode.Disposable | null = null;

  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _config: () => GraphConfig,
    options: GraphIndexerOptions = {},
  ) {
    this._worker = new GraphWorkerClient(options.workerScript ?? null);
  }

  dispose(): void {
    this._disposed = true;
    this._runningJob?.cancel();
    this._watcher?.dispose();
    this._foldersWatcher?.dispose();
    if (this._debounce) clearTimeout(this._debounce);
    this._emitter.dispose();
    this._indexingEmitter.dispose();
    this._progressEmitter.dispose();
  }

  isIndexing(): boolean {
    return this._rebuilding;
  }

  /** Whether heavy passes run in the background worker (vs. inline). */
  usesWorker(): boolean {
    return this._worker.usesWorker;
  }

  snapshot(): GraphSnapshot | null {
    if (this._snapshot) return this._snapshot;
    const cachePath = this._cachePath();
    const cached = cachePath
      ? normalizeCache(readJsonFile(cachePath), exclusionPolicyKey(this._exclusions()))
      : null;
    if (cached) {
      this._seed = cached.seed;
      this._hiddenByPolicyCount = cached.hiddenByPolicyCount ?? 0;
      this._gitignoreApplied = cached.gitignoreApplied === true;
      this._seq += 1;
      this._snapshot = {
        nodes: cached.nodes,
        edges: cached.importEdges,
        indexedAt: cached.indexedAt,
        truncated: cached.truncated,
        indexedTruncated: cached.indexedTruncated,
        renderedTruncated: cached.renderedTruncated,
        indexedFileCount: cached.indexedFileCount ?? cached.nodes.length,
        renderedNodeCount: cached.renderedNodeCount ?? cached.nodes.length,
        indexedImportEdgeCount: cached.indexedImportEdgeCount ?? cached.importEdges.length,
        renderedImportEdgeCount: cached.renderedImportEdgeCount ?? cached.importEdges.length,
        hiddenByPolicyCount: cached.hiddenByPolicyCount,
        gitignoreApplied: cached.gitignoreApplied,
        seq: this._seq,
      };
      this._indexedFiles = cached.nodes.map((node) => node.id);
      for (const node of cached.nodes) this._indexNodes.set(node.id, node);
      for (const [id, x, y] of cached.offMapPositions ?? []) {
        if (this._indexNodes.has(id)) continue;
        this._indexNodes.set(id, { id, dir: clusterDir(id), lang: langOf(id), sizeBytes: 0, inDegree: 0, outDegree: 0, x, y, z: 0.15 });
      }
    }
    return this._snapshot;
  }

  indexedFiles(): string[] {
    if (!this._snapshot) this.snapshot();
    return [...this._indexedFiles];
  }

  /** Full indexed import adjacency. A cache loaded before the background
      reconciliation finishes only contains the rendered projection, so fall
      back to that rather than reporting no relationships during startup. */
  importEdges(): GraphEdge[] {
    if (this._indexedImportEdges.length > 0) return this._indexedImportEdges;
    return (this.snapshot()?.edges ?? []).filter((edge) => edge.kind === "import");
  }

  /** The full corpus file set — relationship indexing runs over this, not the
      rendered slice, so relationships cover the whole workspace. Falls back to
      the indexed set before the first rebuild has populated the corpus. */
  corpusFiles(): string[] {
    if (this._corpusFiles.length > 0) return [...this._corpusFiles];
    return this.indexedFiles();
  }

  /** Every indexed file as a node (positions, degrees, area, codebase, git) —
      a superset of the rendered snapshot whenever the render cap truncates.
      Before the first rebuild it is whatever the cache held. */
  nodeIndex(): GraphNode[] {
    if (!this._snapshot) this.snapshot();
    return [...this._indexNodes.values()];
  }

  indexNode(id: string): GraphNode | undefined {
    if (!this._snapshot) this.snapshot();
    return this._indexNodes.get(id);
  }

  topology(): ProjectTopology | null {
    return this._cachedTopology;
  }

  /** Logical-coupling edges from git history (graph/cochange.ts), over indexed files. */
  cochangeEdges(): GraphEdge[] {
    return this._cochange;
  }

  /** Run the service-relationship pass through the same worker/inline runner
      the rebuild uses, cached at .blacksite/graph-relationships.json. */
  runRelationshipJob(files: readonly string[], topology: ProjectTopology | null): RunningJob<RelationshipJobResult> {
    const root = this._roots()[0];
    return this._worker.run("relationships", { files, topology }, {
      roots: this._roots(),
      cachePath: root ? path.join(root.path, BLACKSITE_DIR, RELATIONSHIP_CACHE_FILE) : null,
    });
  }

  start(): void {
    /* A bare string pattern (not anchored via RelativePattern) watches every
       open workspace folder, current and future. */
    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    const onTouch = (uri: vscode.Uri) => this._markDirty(uri);
    watcher.onDidCreate(onTouch);
    watcher.onDidChange(onTouch);
    watcher.onDidDelete(onTouch);
    this._watcher = watcher;
    this._foldersWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rebuild());
    /* A cached snapshot paints the view instantly, but it may be stale in
       ways the watcher never saw (files changed while the editor was closed,
       an older extension version wrote it). Always reconcile in the
       background — prevPositions pinning keeps the map visually stable, and
       the facts cache makes an unchanged workspace a stat-only pass. */
    void this.rebuild();
  }

  /**
   * Apply the watcher's pending changes now rather than after the debounce, for a caller about to
   * read the index that needs it to reflect what just happened on disk (the agent's
   * workspace_refresh). Returns how many changed paths were waiting. A change large enough to hand
   * off to a full rebuild is scheduled, not awaited.
   */
  async flushPending(): Promise<number> {
    if (this._debounce) {
      clearTimeout(this._debounce);
      this._debounce = undefined;
    }
    const pending = this._dirty.size;
    await this._applyDirty();
    return pending;
  }

  /** Full scan + layout. Safe to call while a rebuild runs (queues one more). */
  async rebuild(): Promise<void> {
    if (this._rebuilding) {
      this._rebuildQueued = true;
      return;
    }
    this._rebuilding = true;
    this._indexingEmitter.fire(true);
    try {
      await this._rebuildOnce();
    } catch (error) {
      if (!(error instanceof JobCancelledError) && !this._disposed) {
        console.error("Blacksite: Codebase Map rebuild failed", error);
      }
    } finally {
      this._rebuilding = false;
      this._runningJob = null;
      this._indexingEmitter.fire(false);
      if (this._rebuildQueued && !this._disposed) {
        this._rebuildQueued = false;
        void this.rebuild();
      }
    }
  }

  /** Cache lives under the first workspace folder; derived data, so it's fine
      if that choice shifts across sessions when folders are reordered. */
  private _cachePath(file = CACHE_FILE): string | null {
    const root = this._roots()[0];
    return root ? path.join(root.path, BLACKSITE_DIR, file) : null;
  }

  /** The exclusion policy in force. Resolved per call rather than cached: a
      settings change must take effect on the next scan, and this is a Set
      build over a handful of entries. */
  private _exclusions(): ExclusionPolicy {
    return exclusionPolicy(this._config());
  }

  /** Whether a map id sits under a directory the map never indexes (a dot directory, a virtualenv,
      node_modules, .blacksite …), by the same rule the scan applies. */
  isExcludedPath(id: string): boolean {
    return hasExcludedSegment(id, this._exclusions());
  }

  private _markDirty(uri: vscode.Uri): void {
    const rel = toNodeId(this._roots(), uri.fsPath);
    /* The watcher matters as much as the enumerate path: without this, a file
       created under an excluded directory mid-session would re-add itself to a
       corpus the full scan deliberately left out. */
    if (!rel || hasExcludedSegment(rel, this._exclusions())) return;
    const normalized = normalizeGraphPath(rel);
    if (!isTopologyManifest(normalized) && !isGraphManifestPath(normalized) && !isGraphIndexablePath(rel)) return;
    this._dirty.add(normalized);
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => void this._applyDirty(), 2000);
  }

  /** Discovery: `git ls-files` per repository when .gitignore is honoured,
      findFiles otherwise (and for roots that are not in a repo). Returns
      node ids that pass the corpus and exclusion policy. */
  private async _discover(): Promise<Set<string>> {
    const roots = this._roots();
    const policy = this._exclusions();
    const seen = new Set<string>();
    let hiddenByPolicy = 0;
    const admit = (absolute: string): void => {
      const rel = toNodeId(roots, absolute);
      if (!rel || !isGraphIndexablePath(rel)) return;
      /* The dot rule can't live in the findFiles exclude glob — VS Code's
         pattern has no way to express "any segment starting with a dot" — so
         it is enforced here, after enumeration, for both discovery paths. */
      if (hasExcludedSegment(rel, policy)) {
        hiddenByPolicy += 1;
        return;
      }
      seen.add(normalizeGraphPath(rel));
    };

    const viaFindFiles: string[] = [];
    this._toplevels = new Map();
    this._gitignoreApplied = false;
    if (policy.respectGitignore) {
      await Promise.all(roots.map(async (root) => {
        this._toplevels.set(root.path, await gitToplevel(root.path));
      }));
      const { groups, ungrouped } = groupRootsByRepo(roots.map((root) => root.path), this._toplevels);
      viaFindFiles.push(...ungrouped);
      for (const group of groups) {
        if (this._disposed) break;
        const files = await listRepoFiles(group);
        if (!files) {
          viaFindFiles.push(...group.roots);
          continue;
        }
        this._gitignoreApplied = true;
        for (const abs of files) admit(abs);
      }
    } else {
      viaFindFiles.push(...roots.map((root) => root.path));
    }

    const config = this._config();
    for (const rootPath of viaFindFiles) {
      if (this._disposed) break;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootPath, "**/*"),
        buildExcludeGlob(policy),
        Math.max(RAW_SCAN_CAP, Math.max(100, config.maxIndexedFiles)),
      );
      for (const uri of uris) admit(uri.fsPath);
    }
    /* Reported to the map so removing a large slice of a workspace is never
       silent — see GraphSnapshot.hiddenByPolicyCount. */
    this._hiddenByPolicyCount = hiddenByPolicy;
    return seen;
  }

  /** Scan every open workspace folder and merge into one node-id set — ids are
      folder-qualified by toNodeId() only when there's more than one root.
      Fetches the true full set (bounded only by RAW_SCAN_CAP) before deciding
      what to display, then samples fairly across clusters if that set is
      bigger than maxNodes — see sampleAcrossClusters for why. */
  private async _enumerate(): Promise<{ indexedFiles: string[]; files: string[]; truncated: boolean; indexedTruncated: boolean; renderedTruncated: boolean }> {
    const config = this._config();
    const configuredMaxIndexedFiles = Math.max(100, config.maxIndexedFiles);
    const seen = await this._discover();

    /* Auto-escalate the implicit "balanced" default once the true file count
       (now known) shows it's a bigger workspace than that tier was tuned
       for — see autoEscalatedProfile(). An explicit profile choice is never
       overridden. */
    const escalated = config.performanceProfile === "balanced" ? autoEscalatedProfile(seen.size) : null;
    const maxIndexedFiles = escalated ? PROFILE_CAPS[escalated].maxIndexedFiles : configuredMaxIndexedFiles;
    const maxRenderedStars = escalated ? PROFILE_CAPS[escalated].maxRenderedStars : Math.max(100, config.maxRenderedStars);
    /* _applyDirty's incremental path needs this exact number, not a fresh
       read of config — see the field doc comment on _effectiveMaxRenderedStars. */
    this._effectiveMaxRenderedStars = maxRenderedStars;

    /* The corpus keeps the full eligible set (bounded only by RAW_SCAN_CAP);
       relationship indexing and the persisted corpus read from it, so nothing
       downstream of here loses truth to a cap. */
    this._corpusFiles = [...seen].sort();

    const indexedTruncated = seen.size > maxIndexedFiles;
    const indexedFiles = indexedTruncated ? sampleAcrossClusters([...seen], maxIndexedFiles) : [...seen].sort();
    const renderedTruncated = indexedFiles.length > maxRenderedStars;
    const files = renderedTruncated ? sampleAcrossClusters(indexedFiles, maxRenderedStars) : [...indexedFiles].sort();
    return { indexedFiles, files, truncated: indexedTruncated || renderedTruncated, indexedTruncated, renderedTruncated };
  }

  /** Git churn/recency and per-commit file sets, one `git log` per repository
      (roots sharing a repo share it). Best-effort: a root that isn't a repo
      contributes nothing. */
  private async _collectGit(indexedFiles: readonly string[]): Promise<{ byId: Record<string, [number, number]>; cochange: GraphEdge[] }> {
    const roots = this._roots();
    const toplevels = new Map<string, string>();
    for (const root of roots) {
      if (this._disposed) break;
      const known = this._toplevels.get(root.path);
      const top = known === undefined ? await gitToplevel(root.path) : known;
      if (top) toplevels.set(top.toLowerCase(), root.path);
    }
    const stats = new Map<string, GitFileStat>();
    const commits: string[][] = [];
    for (const rootPath of toplevels.values()) {
      if (this._disposed) break;
      try {
        const history = await collectGitHistory(rootPath, GIT_MAX_COMMITS);
        if (!history) continue;
        for (const [abs, stat] of history.stats) stats.set(abs, stat);
        commits.push(...history.commits);
      } catch { /* git unavailable / not a repo — skip */ }
    }
    const idByAbs = new Map<string, string>();
    const byId: Record<string, [number, number]> = {};
    for (const rel of indexedFiles) {
      const absolute = fromNodeId(roots, rel);
      if (!absolute) continue;
      const key = normalizeAbsPath(absolute);
      idByAbs.set(key, rel);
      const stat = stats.get(key);
      if (stat) byId[rel] = [stat.churn, stat.lastAt];
    }
    const mapped = commits
      .map((files) => files.map((abs) => idByAbs.get(abs)).filter((id): id is string => Boolean(id)))
      .filter((files) => files.length > 1);
    return { byId, cochange: cochangeEdges(cochangePairs(mapped)) };
  }

  private async _rebuildOnce(): Promise<void> {
    this._progressEmitter.fire({ phase: "discover", fraction: 0 });
    const { indexedFiles, files, truncated, indexedTruncated, renderedTruncated } = await this._enumerate();
    if (this._disposed) return;
    const git = await this._collectGit(indexedFiles);
    const roots = this._roots();

    /* Keep the map stable across rebuilds: previous positions seed the layout. */
    const prevPositions: Array<[string, number, number]> = [];
    for (const node of this._indexNodes.values()) prevPositions.push([node.id, node.x, node.y]);

    const job = this._worker.run("index", {
      corpusFiles: this._corpusFiles,
      indexedFiles,
      renderedFiles: files,
      rootNames: roots.length > 1 ? roots.map((root) => root.name) : [],
      seed: this._seed,
      prevPositions,
      neighborhoods: this._config().neighborhoods,
      git: git.byId,
    }, {
      roots,
      cachePath: this._cachePath(FACTS_FILE),
      onProgress: (phase, fraction) => this._progressEmitter.fire({ phase, fraction }),
    });
    this._runningJob = job;
    const result = await job.promise;
    if (this._disposed) return;

    this._facts = new Map(result.facts);
    this._resolveCtx = result.resolveContext;
    this._cachedTopology = result.topology;
    this._indexNodes = new Map(result.indexNodes.map((node) => [node.id, node]));
    this._indexedFiles = result.indexNodes.map((node) => node.id);
    const indexedImportEdges: GraphEdge[] = [];
    for (const [from, targets] of result.imports) {
      for (const to of targets) indexedImportEdges.push({ id: importEdgeId(from, to), from, to, kind: "import", provenance: "import" });
    }
    this._indexedImportEdges = indexedImportEdges;
    this._cochange = git.cochange;

    /* The webview is a bounded projection. Keep only relationships it can
       actually draw, while retaining corpus-wide degrees on each rendered
       node so hubs do not look unimportant simply because many peers are off
       screen. */
    const nodes = files.map((rel) => this._indexNodes.get(rel)).filter((node): node is GraphNode => Boolean(node));
    const renderedSet = new Set(nodes.map((node) => node.id));
    const edges = indexedImportEdges.filter((edge) => renderedSet.has(edge.from) && renderedSet.has(edge.to));

    this._seq += 1;
    const snapshot: GraphSnapshot = {
      nodes,
      edges,
      indexedAt: new Date().toISOString(),
      truncated,
      indexedTruncated,
      renderedTruncated,
      indexedFileCount: indexedFiles.length,
      renderedNodeCount: nodes.length,
      indexedImportEdgeCount: indexedImportEdges.length,
      renderedImportEdgeCount: edges.length,
      hiddenByPolicyCount: this._hiddenByPolicyCount,
      gitignoreApplied: this._gitignoreApplied,
      seq: this._seq,
    };
    this._snapshot = snapshot;
    this._changedSinceLayout = 0;
    this._writeCache(snapshot);
    this._writeCorpus(nodes.length);
    this._emitter.fire(snapshot);
  }

  /** Persist the canonical corpus manifest: the full eligible file set and the
      true counts, separate from the (derived) render cache. Best-effort — the
      map still works from the render cache if this can't be written. */
  private _writeCorpus(renderedCount: number): void {
    const root = this._roots()[0];
    if (!root) return;
    const document = {
      schemaVersion: CORPUS_SCHEMA_VERSION,
      indexedAt: new Date().toISOString(),
      fileCount: this._corpusFiles.length,
      renderedCount,
      files: this._corpusFiles,
    };
    try {
      const dir = path.join(root.path, BLACKSITE_DIR);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CORPUS_FILE), JSON.stringify(document), "utf8");
    } catch { /* corpus manifest is best-effort */ }
  }

  /** Drop dirty paths git ignores. Only files new to the corpus need the
      check (a tracked or already-admitted file is by definition not ignored),
      and one `git check-ignore` runs per repository per batch. */
  private async _dropIgnored(dirty: string[]): Promise<string[]> {
    if (!this._exclusions().respectGitignore || !this._gitignoreApplied) return dirty;
    const corpus = new Set(this._corpusFiles);
    const roots = this._roots();
    const candidates = new Map<string, string[]>();
    for (const rel of dirty) {
      if (corpus.has(rel)) continue;
      const abs = fromNodeId(roots, rel);
      if (!abs) continue;
      const root = roots.find((r) => abs.toLowerCase().startsWith(`${r.path.toLowerCase()}/`));
      const top = root ? this._toplevels.get(root.path) : null;
      if (!top) continue;
      const list = candidates.get(top) ?? [];
      list.push(abs.replace(/\\/g, "/"));
      candidates.set(top, list);
    }
    if (candidates.size === 0) return dirty;
    const ignored = new Set<string>();
    for (const [top, abs] of candidates) {
      for (const hit of await ignoredPaths(top, abs)) ignored.add(hit);
    }
    if (ignored.size === 0) return dirty;
    return dirty.filter((rel) => {
      const abs = fromNodeId(roots, rel);
      return !abs || !ignored.has(abs.replace(/\\/g, "/").toLowerCase());
    });
  }

  /** Incremental pass: re-extract facts for dirty files only, re-resolve them
      against the cached context, and patch both the node index and the render
      projection. Past ~10% churn, or when a manifest changes, a full rebuild. */
  private async _applyDirty(): Promise<void> {
    if (this._disposed || this._dirty.size === 0) return;
    const snapshot = this._snapshot;
    if (!snapshot || this._rebuilding || !this._resolveCtx) {
      this._dirty.clear();
      void this.rebuild();
      return;
    }

    let dirty = [...this._dirty];
    this._dirty.clear();
    if (dirty.some((rel) => isTopologyManifest(rel) || isGraphManifestPath(rel) || isResolverManifest(rel))) {
      void this.rebuild();
      return;
    }
    this._changedSinceLayout += dirty.length;
    if (this._changedSinceLayout > Math.max(50, snapshot.nodes.length * 0.1)) {
      void this.rebuild();
      return;
    }
    dirty = await this._dropIgnored(dirty);
    if (dirty.length === 0) return;

    const roots = this._roots();
    const maxRendered = Math.max(100, this._effectiveMaxRenderedStars);
    const indexedSet = new Set(this._indexedFiles);
    const corpus = new Set(this._corpusFiles);
    const renderedIds = new Set(snapshot.nodes.map((node) => node.id));
    let contextChanged = false;
    const touched: string[] = [];

    for (const rel of dirty) {
      const absolute = fromNodeId(roots, rel);
      let stat: fs.Stats | null = null;
      try {
        stat = absolute ? fs.statSync(absolute) : null;
      } catch { /* deleted during the debounce window */ }
      if (!stat || !stat.isFile()) {
        corpus.delete(rel);
        if (indexedSet.delete(rel)) contextChanged = true;
        this._facts.delete(rel);
        this._indexNodes.delete(rel);
        renderedIds.delete(rel);
        continue;
      }
      corpus.add(rel);
      if (!indexedSet.has(rel)) {
        /* At an active index cap, a new file waits for the next fair full
           re-sample rather than growing the index past it. */
        if (snapshot.indexedTruncated === true) continue;
        indexedSet.add(rel);
        contextChanged = true;
      }
      let content = "";
      if (stat.size <= MAX_IMPORT_FILE_BYTES) {
        try { content = fs.readFileSync(absolute!, "utf8"); } catch { /* unreadable */ }
      }
      const previous = this._facts.get(rel);
      const facts = extractFileFacts(rel, content, Math.trunc(stat.mtimeMs), stat.size);
      if (declarationsChanged(previous, facts)) contextChanged = true;
      this._facts.set(rel, facts);
      touched.push(rel);

      let node = this._indexNodes.get(rel);
      if (!node) {
        const nodesByDir = new Map<string, string[]>();
        const dirCounts = new Map<string, number>();
        const positions = new Map<string, { x: number; y: number }>();
        for (const existing of this._indexNodes.values()) {
          (nodesByDir.get(existing.dir) ?? nodesByDir.set(existing.dir, []).get(existing.dir)!).push(existing.id);
          dirCounts.set(existing.dir, (dirCounts.get(existing.dir) ?? 0) + 1);
          positions.set(existing.id, { x: existing.x, y: existing.y });
        }
        const dir = incrementalClusterDir(rel, dirCounts);
        const pos = placeNearCluster(dir, positions, nodesByDir, this._seed + this._indexNodes.size);
        const sibling = nodesByDir.get(dir)?.[0];
        const codebase = sibling ? this._indexNodes.get(sibling)?.codebase : undefined;
        const neighborhood = sibling ? this._indexNodes.get(sibling)?.neighborhood : undefined;
        node = {
          id: rel, dir, lang: langOf(rel), sizeBytes: stat.size,
          inDegree: 0, outDegree: 0,
          x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: 0.15,
          ...(codebase ? { codebase } : {}),
          ...(neighborhood ? { neighborhood } : {}),
        };
        this._indexNodes.set(rel, node);
        if (renderedIds.size < maxRendered) renderedIds.add(rel);
      } else if (node.sizeBytes !== stat.size) {
        /* Copy-on-write, so the previous snapshot still holds the old size and
           the delta below reports the change. */
        this._indexNodes.set(rel, { ...node, sizeBytes: stat.size });
      }
      await yieldToLoop();
    }

    finalizeRefs(this._facts, declaredTypeNames(this._facts));
    if (contextChanged) {
      this._resolveCtx = buildResolveContextFromFacts(this._facts, indexedSet, roots.length > 1 ? roots.map((r) => r.name) : []);
    }
    const touchedSet = new Set(touched);
    const indexedEdges = this._indexedImportEdges.filter((edge) =>
      !touchedSet.has(edge.from) && indexedSet.has(edge.from) && indexedSet.has(edge.to));
    for (const rel of touched) {
      for (const to of resolveTargetsFromFacts(rel, this._facts.get(rel), indexedSet, this._resolveCtx!)) {
        indexedEdges.push({ id: importEdgeId(rel, to), from: rel, to, kind: "import", provenance: "import" });
      }
    }
    this._indexedImportEdges = indexedEdges;
    this._indexedFiles = [...indexedSet].sort();
    this._corpusFiles = [...corpus].sort();

    /* Recompute degrees + depth cues over the index from the updated edges. */
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const edge of indexedEdges) {
      outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
    let maxDegree = 0;
    const renderedNodes: GraphNode[] = [];
    const nextIndex = new Map<string, GraphNode>();
    for (const [id, node] of this._indexNodes) {
      const nIn = inDegree.get(id) ?? 0;
      const nOut = outDegree.get(id) ?? 0;
      maxDegree = Math.max(maxDegree, nIn + nOut);
      /* Copy-on-write: the previous snapshot's node objects must keep their
         old values so the delta below can see what changed. */
      nextIndex.set(id, nIn === node.inDegree && nOut === node.outDegree ? node : { ...node, inDegree: nIn, outDegree: nOut });
    }
    for (const [id, node] of nextIndex) {
      const z = depthFromDegree(node.inDegree, node.outDegree, maxDegree);
      const current = z === node.z ? node : { ...node, z };
      nextIndex.set(id, current);
      if (renderedIds.has(id)) renderedNodes.push(current);
    }
    this._indexNodes = nextIndex;
    renderedNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const renderedSet = new Set(renderedNodes.map((node) => node.id));
    const edges = indexedEdges.filter((edge) => renderedSet.has(edge.from) && renderedSet.has(edge.to));

    const delta = diffSnapshots(snapshot, { nodes: renderedNodes, edges }, snapshot.seq ?? 0);
    if (delta.upsertNodes.length === 0 && delta.removeNodeIds.length === 0 && delta.addEdges.length === 0 && delta.removeEdgeIds.length === 0) {
      return;
    }
    this._seq += 1;
    const next: GraphSnapshot = {
      nodes: renderedNodes,
      edges,
      indexedAt: new Date().toISOString(),
      truncated: snapshot.truncated,
      indexedTruncated: snapshot.indexedTruncated,
      renderedTruncated: snapshot.renderedTruncated,
      relationshipTruncated: snapshot.relationshipTruncated,
      indexedFileCount: this._indexedFiles.length,
      renderedNodeCount: renderedNodes.length,
      relationshipEdgeCount: snapshot.relationshipEdgeCount,
      indexedImportEdgeCount: indexedEdges.length,
      renderedImportEdgeCount: edges.length,
      hiddenByPolicyCount: this._hiddenByPolicyCount,
      gitignoreApplied: this._gitignoreApplied,
      seq: this._seq,
      delta,
    };
    this._snapshot = next;
    this._writeCache(next);
    this._emitter.fire(next);
  }

  private _writeCache(snapshot: GraphSnapshot): void {
    const rendered = new Set(snapshot.nodes.map((node) => node.id));
    const offMapPositions: Array<[string, number, number]> = [];
    for (const node of this._indexNodes.values()) {
      if (!rendered.has(node.id)) offMapPositions.push([node.id, node.x, node.y]);
    }
    const document: CacheDocument = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      policyKey: exclusionPolicyKey(this._exclusions()),
      seed: this._seed,
      indexedAt: snapshot.indexedAt,
      hiddenByPolicyCount: snapshot.hiddenByPolicyCount,
      truncated: snapshot.truncated,
      indexedTruncated: snapshot.indexedTruncated,
      renderedTruncated: snapshot.renderedTruncated,
      indexedFileCount: this._indexedFiles.length,
      renderedNodeCount: snapshot.renderedNodeCount,
      indexedImportEdgeCount: snapshot.indexedImportEdgeCount,
      renderedImportEdgeCount: snapshot.renderedImportEdgeCount,
      gitignoreApplied: snapshot.gitignoreApplied,
      nodes: snapshot.nodes,
      importEdges: snapshot.edges.filter((edge) => edge.kind === "import"),
      ...(offMapPositions.length > 0 ? { offMapPositions } : {}),
    };
    const cachePath = this._cachePath();
    if (!cachePath) return;
    try {
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(document), "utf8");
    } catch { /* cache is best-effort; unwritable workspaces still get a live map */ }
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Whether a fact change can alter how *other* files resolve (declarations,
    re-exports, module names) — the cue to rebuild the resolve context. */
function declarationsChanged(previous: FileFacts | undefined, next: FileFacts): boolean {
  if (!previous) return true;
  return JSON.stringify([previous.cs, previous.php, previous.py, previous.pyRe])
    !== JSON.stringify([next.cs, next.php, next.py, next.pyRe]);
}
