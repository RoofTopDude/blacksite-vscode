/* Host-side indexer for the Codebase Map: enumerates workspace files, scans
   imports, runs the seeded force layout in chunks, caches the result at
   .blacksite/graph-cache.json, and watches the workspace for incremental
   updates. Derived data only — annotations live in graph-annotation-store. */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  assignClusters,
  clusterDir,
  depthFromDegree,
  importEdgeId,
  incrementalClusterDir,
  langOf,
  normalizeGraphPath,
  sampleAcrossClusters,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./graph-model.js";
import { extractImports } from "./import-scan.js";
import { buildBasenameIndex, resolveSpecifierTargets, type ResolveContext } from "./resolve-imports.js";
import { buildAliasTable, mergeExtendsChain, parseTsconfig, resolveExtends, type TsAliasConfig } from "./tsconfig-paths.js";
import { buildGoDirIndex, parseGoMod, type GoModule } from "./go-modules.js";
import { buildCSharpIndex, referencedTypeNames } from "./csharp-index.js";
import { buildProjectTopology, type ProjectTopology } from "./project-topology.js";
import { assignNeighborhoods, shouldTerritorialize } from "./neighborhoods.js";
import { docReferences } from "./doc-links.js";
import { createLayout, placeNearCluster } from "./layout.js";
import { collectGitStats, normalizeAbsPath, type GitFileStat } from "./git-log.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./workspace-roots.js";
import { PROFILE_CAPS, type GraphConfig, type GraphPerformanceProfile } from "./config.js";
import { CORPUS_SCHEMA_VERSION } from "./corpus.js";
import { isGraphIndexablePath, isGraphManifestPath } from "./file-discovery.js";

const BLACKSITE_DIR = ".blacksite";
const CACHE_FILE = "graph-cache.json";
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
   until somebody happened to trigger a manual rebuild. */
const CACHE_SCHEMA_VERSION = 9;
/* How far back the git heat layer looks. Bounded so `git log` stays fast and
   its output fits maxBuffer on very active repos. */
const GIT_MAX_COMMITS = 4000;
const EXCLUDE_GLOB = "**/{node_modules,.git,.blacksite,dist,out,build,.next,coverage,__pycache__,.venv,venv}/**";
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".blacksite", "dist", "out", "build", ".next", "coverage", "__pycache__", ".venv", "venv"]);
/* Safety ceiling on the raw pre-filter directory scan per root — high enough
   that real projects (after EXCLUDE_GLOB prunes node_modules/dist/etc.) never
   hit it, so the full tree is seen before deciding what to display. Deciding
   truncation from a small raw cap instead of the true count is what starves
   deeply-nested folders off the map on large projects. */
const RAW_SCAN_CAP = 200_000;
const READ_BATCH = 50;
const TICK_CHUNK = 20;
const MAX_FILE_BYTES = 512_000;
/* The import scanner reads large files too (they're windowed, not truncated —
   see import-scan.ts), so a generated 3 MB client still contributes its edges.
   Bounded well above any hand-written source so a pathological huge blob can't
   stall a rebuild. */
const MAX_IMPORT_FILE_BYTES = 8_000_000;
/* Hard ceiling on outgoing edges from one `.cs` file. Even after type-precise
   resolution, a hub file can reference many types; this is a safety valve so no
   single file can spray a hairball back onto the map. Normal files stay well
   under it. */
const CSHARP_MAX_EDGES_PER_FILE = 64;

/** True when any path segment (including under a multi-root folder prefix)
    is one of the directories the map never indexes. */
function hasExcludedSegment(rel: string): boolean {
  return rel.split("/").some((seg) => EXCLUDED_SEGMENTS.has(seg));
}

function isTopologyManifest(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  return TOPOLOGY_MANIFEST_NAMES.has(name) || TOPOLOGY_MANIFEST_EXT_RE.test(name);
}

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
/* Manifests that affect host-side project topology. The wider corpus discovery
   policy (including service-only manifests and contracts) lives in
   file-discovery.ts. */
const TOPOLOGY_MANIFEST_NAMES = new Set([
  "package.json",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "go.work",
  /* JS/TS monorepo roots that carry no `workspaces` field of their own. */
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "rush.json",
  /* Rust, Python, Bazel. */
  "cargo.toml",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "workspace",
  "workspace.bazel",
  "module.bazel",
]);
const TOPOLOGY_MANIFEST_EXT_RE = /\.(?:csproj|sln)$/i;
const TOPOLOGY_GLOBS: ReadonlyArray<{ pattern: string; limit: number }> = [
  { pattern: "**/package.json", limit: 4000 },
  { pattern: "**/*.csproj", limit: 2000 },
  { pattern: "**/*.sln", limit: 500 },
  { pattern: "**/pom.xml", limit: 2000 },
  { pattern: "**/settings.gradle", limit: 1000 },
  { pattern: "**/settings.gradle.kts", limit: 1000 },
  { pattern: "**/build.gradle", limit: 2000 },
  { pattern: "**/build.gradle.kts", limit: 2000 },
  { pattern: "**/go.mod", limit: 2000 },
  { pattern: "**/go.work", limit: 500 },
  { pattern: "**/pnpm-workspace.{yaml,yml}", limit: 500 },
  { pattern: "**/lerna.json", limit: 500 },
  { pattern: "**/nx.json", limit: 500 },
  { pattern: "**/turbo.json", limit: 500 },
  { pattern: "**/rush.json", limit: 200 },
  { pattern: "**/Cargo.toml", limit: 4000 },
  { pattern: "**/pyproject.toml", limit: 4000 },
  { pattern: "**/setup.cfg", limit: 2000 },
  { pattern: "**/setup.py", limit: 2000 },
  { pattern: "**/{WORKSPACE,WORKSPACE.bazel,MODULE.bazel}", limit: 500 },
];

interface CacheDocument {
  schemaVersion: number;
  seed: number;
  indexedAt: string;
  truncated: boolean;
  indexedTruncated?: boolean;
  renderedTruncated?: boolean;
  indexedFileCount?: number;
  renderedNodeCount?: number;
  indexedImportEdgeCount?: number;
  renderedImportEdgeCount?: number;
  nodes: GraphNode[];
  importEdges: GraphEdge[];
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function normalizeCache(value: unknown): CacheDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  if (!Array.isArray(record.nodes) || !Array.isArray(record.importEdges)) return null;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    seed: typeof record.seed === "number" ? record.seed : 1,
    indexedAt: typeof record.indexedAt === "string" ? record.indexedAt : new Date().toISOString(),
    truncated: record.truncated === true,
    indexedTruncated: record.indexedTruncated === true,
    renderedTruncated: record.renderedTruncated === true,
    indexedFileCount: typeof record.indexedFileCount === "number" ? record.indexedFileCount : undefined,
    renderedNodeCount: typeof record.renderedNodeCount === "number" ? record.renderedNodeCount : undefined,
    indexedImportEdgeCount: typeof record.indexedImportEdgeCount === "number" ? record.indexedImportEdgeCount : undefined,
    renderedImportEdgeCount: typeof record.renderedImportEdgeCount === "number" ? record.renderedImportEdgeCount : undefined,
    nodes: record.nodes as GraphNode[],
    importEdges: record.importEdges as GraphEdge[],
  };
}

export class GraphIndexer implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<GraphSnapshot>();
  readonly onDidChange = this._emitter.event;

  private readonly _indexingEmitter = new vscode.EventEmitter<boolean>();
  readonly onIndexingChanged = this._indexingEmitter.event;

  private _snapshot: GraphSnapshot | null = null;
  private _seed = 1;
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
  /** tsconfig-alias/go-module/C# namespace context from the last full rebuild. Incremental
      passes reuse it (see `_resolveContextForDirty`) instead of re-parsing
      every config file on every debounced edit. */
  private _cachedResolveCtx: ResolveContext | null = null;
  /** Host-only project/workspace topology from the last full rebuild. */
  private _cachedTopology: ProjectTopology | null = null;
  /** The maxRenderedStars actually used to build `_snapshot`, which can be
      higher than `this._config().maxRenderedStars` when autoEscalatedProfile()
      raised it for this workspace (see `_enumerate`). `_applyDirty` must
      compare against this, not the raw config value — otherwise, once
      escalated, `nodesById.size` (already at the escalated count) reads as
      "at cap" against the un-escalated config number on every single
      incremental edit, forcing a full rebuild instead of the cheap
      incremental path this method exists for. */
  private _effectiveMaxRenderedStars = 100;

  private _foldersWatcher: vscode.Disposable | null = null;

  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _config: () => GraphConfig,
  ) {}

  dispose(): void {
    this._disposed = true;
    this._watcher?.dispose();
    this._foldersWatcher?.dispose();
    if (this._debounce) clearTimeout(this._debounce);
    this._emitter.dispose();
    this._indexingEmitter.dispose();
  }

  isIndexing(): boolean {
    return this._rebuilding;
  }

  snapshot(): GraphSnapshot | null {
    if (this._snapshot) return this._snapshot;
    const cachePath = this._cachePath();
    const cached = cachePath ? normalizeCache(readJsonFile(cachePath)) : null;
    if (cached) {
      this._seed = cached.seed;
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
      };
      this._indexedFiles = cached.nodes.map((node) => node.id);
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

  topology(): ProjectTopology | null {
    return this._cachedTopology;
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
       background — prevPositions pinning keeps the map visually stable. */
    void this.rebuild();
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
    } finally {
      this._rebuilding = false;
      this._indexingEmitter.fire(false);
      if (this._rebuildQueued && !this._disposed) {
        this._rebuildQueued = false;
        void this.rebuild();
      }
    }
  }

  /** Cache lives under the first workspace folder; derived data, so it's fine
      if that choice shifts across sessions when folders are reordered. */
  private _cachePath(): string | null {
    const root = this._roots()[0];
    return root ? path.join(root.path, BLACKSITE_DIR, CACHE_FILE) : null;
  }

  private _markDirty(uri: vscode.Uri): void {
    const rel = toNodeId(this._roots(), uri.fsPath);
    if (!rel || hasExcludedSegment(rel)) return;
    const normalized = normalizeGraphPath(rel);
    if (isTopologyManifest(normalized) || isGraphManifestPath(normalized)) {
      this._dirty.add(normalized);
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => void this._applyDirty(), 2000);
      return;
    }
    if (!isGraphIndexablePath(rel)) return;
    this._dirty.add(normalized);
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => void this._applyDirty(), 2000);
  }

  /** Scan every open workspace folder and merge into one node-id set — ids are
      folder-qualified by toNodeId() only when there's more than one root.
      Fetches the true full set (bounded only by RAW_SCAN_CAP) before deciding
      what to display, then samples fairly across clusters if that set is
      bigger than maxNodes — see sampleAcrossClusters for why. */
  private async _enumerate(): Promise<{ indexedFiles: string[]; files: string[]; truncated: boolean; indexedTruncated: boolean; renderedTruncated: boolean }> {
    const config = this._config();
    const configuredMaxIndexedFiles = Math.max(100, config.maxIndexedFiles);
    const roots = this._roots();
    const seen = new Set<string>();
    for (const root of roots) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root.path, "**/*"),
        EXCLUDE_GLOB,
        Math.max(RAW_SCAN_CAP, configuredMaxIndexedFiles),
      );
      for (const uri of uris) {
        const rel = toNodeId(roots, uri.fsPath);
        if (!rel) continue;
        if (!isGraphIndexablePath(rel)) continue;
        seen.add(normalizeGraphPath(rel));
      }
    }

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

  private async _scanImports(files: string[], fileSet: ReadonlySet<string>, resolveCtx: ResolveContext): Promise<Map<string, string[]>> {
    const edges = new Map<string, string[]>();
    for (let i = 0; i < files.length; i += READ_BATCH) {
      const batch = files.slice(i, i + READ_BATCH);
      for (const rel of batch) {
        const absolute = fromNodeId(this._roots(), rel);
        if (!absolute) continue;
        let content: string;
        try {
          const stat = fs.statSync(absolute);
          if (!stat.isFile() || stat.size > MAX_IMPORT_FILE_BYTES) continue;
          content = fs.readFileSync(absolute, "utf8");
        } catch {
          continue;
        }
        const targets = this._resolveFileTargets(rel, content, fileSet, resolveCtx);
        if (targets.size > 0) edges.set(rel, [...targets]);
      }
      await yieldToLoop();
    }
    return edges;
  }

  /** Resolve one file's outgoing import/reference targets (self excluded).
      Markdown links resolve to the code the doc references. For `.cs`, resolution
      is type-precise — a `using` on a large namespace links only to files whose
      declared type the file actually references (see resolveCSharpTargets) — and
      the whole file is capped so no single `.cs` file can spray a hairball.
      Shared by the full scan and the incremental pass so both apply the same
      precision + cap. */
  private _resolveFileTargets(rel: string, content: string, fileSet: ReadonlySet<string>, resolveCtx: ResolveContext): Set<string> {
    const targets = new Set<string>();
    if (langOf(rel) === "md") {
      /* Docs link to the code they describe: relate the doc to the files it
         references, so it clusters near what it documents. */
      for (const target of docReferences(rel, content, fileSet, resolveCtx.byBasename)) {
        if (target !== rel) targets.add(target);
      }
      return targets;
    }
    const isCsharp = langOf(rel) === "cs";
    const csharpRefs = isCsharp ? referencedTypeNames(content) : undefined;
    for (const spec of extractImports(rel, content)) {
      for (const resolved of resolveSpecifierTargets(rel, spec, fileSet, resolveCtx, csharpRefs)) {
        if (resolved !== rel) targets.add(resolved);
      }
    }
    if (isCsharp && targets.size > CSHARP_MAX_EDGES_PER_FILE) {
      const trimmed = [...targets].sort().slice(0, CSHARP_MAX_EDGES_PER_FILE);
      targets.clear();
      for (const target of trimmed) targets.add(target);
    }
    return targets;
  }

  /** Assemble the resolution context reused across a whole scan: the basename
      index (Razor/Java name lookups), tsconfig/jsconfig path aliases, the
      workspace's go.mod module prefixes, a directory→files index for Go, and
      a C# namespace/type index for resolving `using` references back to files
      package fan-out. Built once per full rebuild — resolving one specifier
      must be cheap because it runs for every import in the tree — and cached
      so an incremental pass can reuse it (see `_resolveContextForDirty`)
      instead of re-parsing every config file on every debounced edit. */
  private async _buildResolveContext(fileSet: ReadonlySet<string>): Promise<ResolveContext> {
    const ctx: ResolveContext = {
      byBasename: buildBasenameIndex(fileSet),
      aliases: this._loadTsAliases(fileSet),
      goModules: await this._loadGoModules(),
      goDirIndex: buildGoDirIndex(fileSet),
      csharp: this._loadCSharpIndex(fileSet),
    };
    this._cachedResolveCtx = ctx;
    return ctx;
  }

  /** Incremental-pass counterpart to `_buildResolveContext`: config files
      (tsconfig/jsconfig, go.mod) and the C# namespace index essentially never
      need a full refresh on the ~2s
      save-triggered debounce cadence `_applyDirty` runs on, so re-parsing every
      one of them on every keystroke-driven edit is pure waste. Reuse the last
      full rebuild's aliases/go-modules, refreshing only what a genuinely
      *inexpensive*, always-fresh check can justify: the basename index (cheap,
      in-memory, and fileSet changes every pass) and the alias table when the
      dirty batch itself touches a tsconfig/jsconfig (so editing paths/baseUrl
      takes effect on the very next pass, not just the next full rebuild),
      plus the C# namespace index when the dirty set includes a `.cs` file.
      go.mod isn't watched (it has no node-eligible extension — see
      the old extension-only discovery rule), so manifest edits now take the
      full rebuild path rather than leaving resolver context stale. */
  private _resolveContextForDirty(dirty: readonly string[], fileSet: ReadonlySet<string>): ResolveContext {
    const cached = this._cachedResolveCtx;
    const touchesTsconfig = dirty.some((rel) => {
      const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
      return base === "tsconfig.json" || base === "jsconfig.json";
    });
    const touchesCSharp = dirty.some((rel) => rel.toLowerCase().endsWith(".cs"));
    return {
      byBasename: buildBasenameIndex(fileSet),
      aliases: cached && !touchesTsconfig ? cached.aliases : this._loadTsAliases(fileSet),
      goModules: cached?.goModules ?? [],
      goDirIndex: buildGoDirIndex(fileSet),
      csharp: cached && !touchesCSharp ? cached.csharp : this._loadCSharpIndex(fileSet),
    };
  }

  /** Parse every tsconfig.json / jsconfig.json already in the indexed set into
      an alias table, following each one's `extends` chain (bounded, cycle-safe)
      so a shared base config — e.g. an Nx/Turborepo `tsconfig.base.json` that
      declares every path alias, extended by every package's own tsconfig.json
      with none of its own — actually contributes its paths/baseUrl instead of
      leaving the alias table empty for the common monorepo layout. */
  private _loadTsAliases(fileSet: ReadonlySet<string>): ReturnType<typeof buildAliasTable> {
    const configs: TsAliasConfig[] = [];
    for (const rel of fileSet) {
      const slash = rel.lastIndexOf("/");
      const base = rel.slice(slash + 1).toLowerCase();
      if (base !== "tsconfig.json" && base !== "jsconfig.json") continue;
      const cfg = this._readTsconfigChain(rel, slash === -1 ? "" : rel.slice(0, slash), fileSet);
      if (cfg) configs.push(cfg);
    }
    return buildAliasTable(configs);
  }

  /** Read one tsconfig/jsconfig and follow its `extends` chain, merging into
      one effective config (root-most first). Bounded to 8 hops and guarded
      against cycles; either just stops and merges whatever was read so far —
      a partial chain is still useful, not a reason to discard everything. */
  private _readTsconfigChain(rel: string, dir: string, fileSet: ReadonlySet<string>): TsAliasConfig | null {
    const chain: TsAliasConfig[] = [];
    const visited = new Set<string>();
    let currentRel: string | null = rel;
    let currentDir = dir;
    for (let hops = 0; currentRel !== null && hops < 8; hops += 1) {
      if (visited.has(currentRel)) break;
      visited.add(currentRel);
      const absolute = fromNodeId(this._roots(), currentRel);
      if (!absolute) break;
      let content: string;
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) break;
        content = fs.readFileSync(absolute, "utf8");
      } catch {
        break;
      }
      const cfg = parseTsconfig(currentDir, content);
      if (!cfg) break;
      chain.unshift(cfg);
      if (!cfg.extends) break;
      const next = resolveExtends(currentDir, cfg.extends, fileSet);
      if (!next) break;
      currentRel = next;
      const nextSlash = next.lastIndexOf("/");
      currentDir = nextSlash === -1 ? "" : next.slice(0, nextSlash);
    }
    return chain.length > 0 ? mergeExtendsChain(chain) : null;
  }

  /** Locate and parse go.mod files across every root (in parallel — each
      root's glob+read is independent I/O). go.mod carries no code extension
      so it isn't an indexed node; find it directly. Best-effort. */
  private async _loadGoModules(): Promise<GoModule[]> {
    const roots = this._roots();
    const perRoot = await Promise.all(roots.map(async (root): Promise<GoModule[]> => {
      if (this._disposed) return [];
      let uris: vscode.Uri[];
      try {
        uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root.path, "**/go.mod"), EXCLUDE_GLOB, 500);
      } catch {
        return [];
      }
      const mods: GoModule[] = [];
      for (const uri of uris) {
        const relId = toNodeId(roots, uri.fsPath);
        if (!relId) continue;
        let content: string;
        try {
          content = fs.readFileSync(uri.fsPath, "utf8");
        } catch {
          continue;
        }
        const slash = relId.lastIndexOf("/");
        const mod = parseGoMod(slash === -1 ? "" : relId.slice(0, slash), content);
        if (mod) mods.push(mod);
      }
      return mods;
    }));
    return perRoot.flat();
  }

  /** Build a best-effort namespace/type index across the rendered `.cs` files
      so plain `using Foo.Bar;` imports can resolve back into workspace files. */
  private _loadCSharpIndex(fileSet: ReadonlySet<string>): ReturnType<typeof buildCSharpIndex> {
    const sources: Array<{ path: string; content: string }> = [];
    for (const rel of fileSet) {
      if (!rel.toLowerCase().endsWith(".cs")) continue;
      const absolute = fromNodeId(this._roots(), rel);
      if (!absolute) continue;
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        sources.push({ path: rel, content: fs.readFileSync(absolute, "utf8") });
      } catch {
        /* unreadable C# file -> just omit it from the namespace index */
      }
    }
    return buildCSharpIndex(sources);
  }

  /** Manifest-driven project topology stays host-only: it improves layout and
      relationship scoring without adding a new graph layer or webview message.
      Build it from manifests whether or not those files render as stars. */
  private async _loadProjectTopology(): Promise<ProjectTopology> {
    const roots = this._roots();
    const manifests = new Map<string, string>();
    for (const root of roots) {
      if (this._disposed) break;
      for (const query of TOPOLOGY_GLOBS) {
        let uris: vscode.Uri[];
        try {
          uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root.path, query.pattern), EXCLUDE_GLOB, query.limit);
        } catch {
          continue;
        }
        for (const uri of uris) {
          const rel = toNodeId(roots, uri.fsPath);
          if (!rel) continue;
          const normalized = normalizeGraphPath(rel);
          if (manifests.has(normalized)) continue;
          try {
            const stat = fs.statSync(uri.fsPath);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
            manifests.set(normalized, fs.readFileSync(uri.fsPath, "utf8"));
          } catch {
            /* unreadable manifest -> just omit it from topology */
          }
        }
      }
    }
    const topology = buildProjectTopology([...manifests.entries()].map(([path, content]) => ({ path, content })));
    this._cachedTopology = topology;
    return topology;
  }

  /** Merge git churn/recency across every root (a root may be its own repo or
      nested in a shared one), keyed by normalized absolute path. Best-effort:
      any root that isn't a repo contributes nothing. */
  private async _collectGit(): Promise<Map<string, GitFileStat>> {
    const merged = new Map<string, GitFileStat>();
    for (const root of this._roots()) {
      if (this._disposed) break;
      try {
        const stats = await collectGitStats(root.path, GIT_MAX_COMMITS);
        for (const [abs, stat] of stats) merged.set(abs, stat);
      } catch { /* git unavailable / not a repo — skip this root */ }
    }
    return merged;
  }

  private async _rebuildOnce(): Promise<void> {
    const { indexedFiles, files, truncated, indexedTruncated, renderedTruncated } = await this._enumerate();
    this._indexedFiles = indexedFiles;
    /* Resolve and scan against the indexed corpus, never the smaller render
       projection. Otherwise a visible file cannot resolve an import merely
       because its target happened to fall beyond maxRenderedStars. */
    const indexedFileSet = new Set(indexedFiles);
    const [resolveCtx, topology, gitByAbs] = await Promise.all([
      this._buildResolveContext(indexedFileSet),
      this._loadProjectTopology(),
      this._collectGit(),
    ]);
    const indexedImportsByFile = await this._scanImports(indexedFiles, indexedFileSet, resolveCtx);
    const indexedImportEdges: GraphEdge[] = [];
    for (const [from, targets] of indexedImportsByFile) {
      for (const to of targets) {
        indexedImportEdges.push({ id: importEdgeId(from, to), from, to, kind: "import", provenance: "import" });
      }
    }
    this._indexedImportEdges = indexedImportEdges;

    /* The webview is a bounded projection. Keep only relationships it can
       actually draw, while retaining corpus-wide degrees on each rendered
       node so hubs do not look unimportant simply because many peers are off
       screen. */
    const renderedFileSet = new Set(files);
    const importsByFile = renderedImportProjection(indexedImportsByFile, renderedFileSet);

    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const [from, targets] of indexedImportsByFile) {
      outDegree.set(from, targets.length);
      for (const to of targets) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
    let maxDegree = 0;
    for (const rel of files) {
      maxDegree = Math.max(maxDegree, (inDegree.get(rel) ?? 0) + (outDegree.get(rel) ?? 0));
    }

    /* Adaptive clustering: a top-level package with thousands of files across
       dozens of subdirectories gets split into finer clusters one level at a
       time, instead of rendering as one giant same-color blob. Passing the
       just-scanned import graph lets a flat oversized folder (no deeper path
       segment to split by) fall back to import-community grouping instead of
       staying one blob — see assignClusters/splitByImportCommunity. */
    const clusters = assignClusters(files, undefined, undefined, importsByFile);

    const nodes: GraphNode[] = files.map((rel) => {
      const absolute = fromNodeId(this._roots(), rel);
      let sizeBytes = 0;
      try {
        if (absolute) sizeBytes = fs.statSync(absolute).size;
      } catch { /* deleted mid-scan */ }
      const git = absolute ? gitByAbs.get(normalizeAbsPath(absolute)) : undefined;
      const nIn = inDegree.get(rel) ?? 0;
      const nOut = outDegree.get(rel) ?? 0;
      return {
        id: rel,
        dir: clusters.get(rel) ?? clusterDir(rel),
        lang: langOf(rel),
        sizeBytes,
        inDegree: nIn,
        outDegree: nOut,
        x: 0,
        y: 0,
        z: depthFromDegree(nIn, nOut, maxDegree),
        churn: git?.churn,
        lastCommitAt: git?.lastAt,
      };
    });

    const edges: GraphEdge[] = [];
    for (const [from, targets] of importsByFile) {
      for (const to of targets) {
        edges.push({ id: importEdgeId(from, to), from, to, kind: "import", provenance: "import" });
      }
    }

    /* Neighborhood territories: separate distinct codebases into their own
       regions when the workspace is large/multi-codebase (or the user forced it
       on). node.neighborhood is set only when territorializing, so the renderer
       draws territory hulls/labels only for a map that's actually laid out that
       way. */
    const neighborhoods = assignNeighborhoods(files, topology, importsByFile);
    const mode = this._config().neighborhoods;
    const territorialize = mode !== "off" && (mode === "on" || shouldTerritorialize(neighborhoods, nodes.length));
    if (territorialize) {
      for (const node of nodes) {
        const nb = neighborhoods.get(node.id);
        if (nb) node.neighborhood = nb;
      }
    }

    /* Keep the map stable across rebuilds: previous positions seed the layout. */
    const prevPositions = new Map<string, { x: number; y: number }>();
    for (const node of this._snapshot?.nodes ?? []) prevPositions.set(node.id, { x: node.x, y: node.y });

    const layout = createLayout(nodes, edges, {
      seed: this._seed,
      prevPositions,
      topology,
      neighborhoods: territorialize ? neighborhoods : undefined,
    });
    while (layout.tick(TICK_CHUNK)) {
      if (this._disposed) return;
      await yieldToLoop();
    }
    const positions = layout.positions();
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (pos) {
        node.x = Math.round(pos.x * 100) / 100;
        node.y = Math.round(pos.y * 100) / 100;
      }
    }

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

  /** Incremental pass: rescan only dirty files; full rebuild past 10% churn. */
  private async _applyDirty(): Promise<void> {
    if (this._disposed || this._dirty.size === 0) return;
    const snapshot = this._snapshot;
    if (!snapshot || this._rebuilding) {
      this._dirty.clear();
      void this.rebuild();
      return;
    }

    const dirty = [...this._dirty];
    this._dirty.clear();
    if (dirty.some((rel) => isTopologyManifest(rel) || isGraphManifestPath(rel))) {
      void this.rebuild();
      return;
    }
    this._changedSinceLayout += dirty.length;
    if (this._changedSinceLayout > Math.max(50, snapshot.nodes.length * 0.1)) {
      void this.rebuild();
      return;
    }

    /* Must match the cap the current snapshot was actually built with, not a
       fresh config read — a raw config read here would be the un-escalated
       "balanced" default even after autoEscalatedProfile() raised the real
       cap for this workspace, making nodesById.size >= maxNodes true on
       essentially every edit once escalated (see _effectiveMaxRenderedStars). */
    const maxNodes = Math.max(100, this._effectiveMaxRenderedStars);
    const dirtySet = new Set(dirty);
    const fileInfo = new Map<string, { absolute: string | null; exists: boolean; sizeBytes: number }>();
    for (const rel of dirty) {
      const absolute = fromNodeId(this._roots(), rel);
      let exists = false;
      let sizeBytes = 0;
      if (absolute) {
        try {
          const stat = fs.statSync(absolute);
          exists = stat.isFile();
          sizeBytes = stat.size;
        } catch { /* deleted during the debounce window */ }
      }
      fileInfo.set(rel, { absolute, exists, sizeBytes });
    }

    /* Maintain indexed adjacency even for files outside the rendered star
       projection. At an active index cap, newly-created files wait for the
       next fair full re-sample; existing indexed files still update here. */
    const indexedFileSet = new Set(this._indexedFiles);
    let corpusMutated = false;
    for (const rel of dirty) {
      const info = fileInfo.get(rel)!;
      if (!info.exists) {
        if (indexedFileSet.delete(rel)) corpusMutated = true;
        const corpusIndex = this._corpusFiles.indexOf(rel);
        if (corpusIndex >= 0) this._corpusFiles.splice(corpusIndex, 1);
      } else {
        if (!this._corpusFiles.includes(rel)) this._corpusFiles.push(rel);
        if (!indexedFileSet.has(rel) && snapshot.indexedTruncated !== true) {
          indexedFileSet.add(rel);
          corpusMutated = true;
        }
      }
    }
    this._corpusFiles.sort();
    const previousIndexedEdgeCount = this._indexedImportEdges.length;
    let indexedEdges = this._indexedImportEdges.filter((edge) => !dirtySet.has(edge.from) && indexedFileSet.has(edge.from) && indexedFileSet.has(edge.to));
    const indexedResolveCtx = this._resolveContextForDirty(dirty, indexedFileSet);
    const indexedContent = new Map<string, string>();
    for (const rel of dirty) {
      const info = fileInfo.get(rel)!;
      if (!info.exists || !info.absolute || !indexedFileSet.has(rel) || info.sizeBytes > MAX_IMPORT_FILE_BYTES) continue;
      let content = "";
      try {
        content = fs.readFileSync(info.absolute, "utf8");
      } catch { /* unreadable */ }
      indexedContent.set(rel, content);
      const targets = this._resolveFileTargets(rel, content, indexedFileSet, indexedResolveCtx);
      for (const to of targets) {
        indexedEdges.push({ id: importEdgeId(rel, to), from: rel, to, kind: "import", provenance: "import" });
      }
    }
    if (indexedEdges.length !== previousIndexedEdgeCount || dirty.some((rel) => indexedFileSet.has(rel))) corpusMutated = true;
    this._indexedImportEdges = indexedEdges;
    this._indexedFiles = [...indexedFileSet].sort();

    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const fileSet = new Set(nodesById.keys());
    let mutated = false;

    /* Drop edges originating from dirty files; they get rescanned below. */
    let edges = snapshot.edges.filter((edge) => !dirtySet.has(edge.from));
    if (edges.length !== snapshot.edges.length) mutated = true;

    /* Resolution context reused for the whole dirty pass (a file added mid-pass
       just isn't a name-resolution target yet) — see _resolveContextForDirty
       for why this is cheap rather than a full config re-parse. */
    const resolveCtx = this._resolveContextForDirty(dirty, fileSet);
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of snapshot.nodes) positions.set(node.id, { x: node.x, y: node.y });
    const nodesByDir = new Map<string, string[]>();
    for (const node of snapshot.nodes) {
      const list = nodesByDir.get(node.dir) ?? [];
      list.push(node.id);
      nodesByDir.set(node.dir, list);
    }

    for (const rel of dirty) {
      const { absolute, exists, sizeBytes } = fileInfo.get(rel)!;

      if (!absolute || !exists) {
        if (nodesById.delete(rel)) {
          fileSet.delete(rel);
          edges = edges.filter((edge) => edge.from !== rel && edge.to !== rel);
          mutated = true;
        }
        continue;
      }

      let node = nodesById.get(rel);
      if (!node) {
        /* Already at the display cap: adding another node needs a fair
           re-sample across clusters, not an uncapped incremental append —
           let a full rebuild handle it instead of growing past maxNodes. */
        if (nodesById.size >= maxNodes) {
          continue;
        }
        const dirCounts = new Map<string, number>();
        for (const [cluster, ids] of nodesByDir) dirCounts.set(cluster, ids.length);
        const dir = incrementalClusterDir(rel, dirCounts);
        const pos = placeNearCluster(dir, positions, nodesByDir, this._seed + nodesById.size);
        node = {
          id: rel, dir, lang: langOf(rel), sizeBytes,
          inDegree: 0, outDegree: 0,
          x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: 0.15,
        };
        nodesById.set(rel, node);
        fileSet.add(rel);
        mutated = true;
      } else {
        node.sizeBytes = sizeBytes;
      }

      if (sizeBytes <= MAX_IMPORT_FILE_BYTES) {
        let content = indexedContent.get(rel) ?? "";
        if (!indexedContent.has(rel)) {
          try {
            content = fs.readFileSync(absolute, "utf8");
          } catch { /* unreadable */ }
        }
        const targets = this._resolveFileTargets(rel, content, fileSet, resolveCtx);
        for (const to of targets) {
          edges.push({ id: importEdgeId(rel, to), from: rel, to, kind: "import", provenance: "import" });
        }
        if (targets.size > 0) mutated = true;
      }
      await yieldToLoop();
    }

    if (corpusMutated) mutated = true;
    if (!mutated) return;

    /* Recompute degrees + depth cues from the updated edge set. */
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const edge of this._indexedImportEdges) {
      outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
    const nodes = [...nodesById.values()];
    let maxDegree = 0;
    for (const node of nodes) {
      node.inDegree = inDegree.get(node.id) ?? 0;
      node.outDegree = outDegree.get(node.id) ?? 0;
      maxDegree = Math.max(maxDegree, node.inDegree + node.outDegree);
    }
    for (const node of nodes) node.z = depthFromDegree(node.inDegree, node.outDegree, maxDegree);

    const next: GraphSnapshot = {
      nodes,
      edges,
      indexedAt: new Date().toISOString(),
      truncated: snapshot.truncated,
      indexedTruncated: snapshot.indexedTruncated,
      renderedTruncated: snapshot.renderedTruncated,
      relationshipTruncated: snapshot.relationshipTruncated,
      indexedFileCount: snapshot.indexedFileCount,
      renderedNodeCount: nodes.length,
      relationshipEdgeCount: snapshot.relationshipEdgeCount,
      indexedImportEdgeCount: this._indexedImportEdges.length || snapshot.indexedImportEdgeCount,
      renderedImportEdgeCount: edges.filter((edge) => edge.kind === "import").length,
    };
    this._snapshot = next;
    this._writeCache(next);
    this._emitter.fire(next);
  }

  private _writeCache(snapshot: GraphSnapshot): void {
    const document: CacheDocument = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      seed: this._seed,
      indexedAt: snapshot.indexedAt,
      truncated: snapshot.truncated,
      indexedTruncated: snapshot.indexedTruncated,
      renderedTruncated: snapshot.renderedTruncated,
      indexedFileCount: this._indexedFiles.length,
      renderedNodeCount: snapshot.renderedNodeCount,
      indexedImportEdgeCount: snapshot.indexedImportEdgeCount,
      renderedImportEdgeCount: snapshot.renderedImportEdgeCount,
      nodes: snapshot.nodes,
      importEdges: snapshot.edges.filter((edge) => edge.kind === "import"),
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
