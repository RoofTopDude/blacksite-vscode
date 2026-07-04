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
  langOf,
  normalizeGraphPath,
  sampleAcrossClusters,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./graph-model.js";
import { extractImports } from "./import-scan.js";
import { buildBasenameIndex, resolveSpecifier } from "./resolve-imports.js";
import { docReferences } from "./doc-links.js";
import { createLayout, placeNearCluster } from "./layout.js";
import { collectGitStats, normalizeAbsPath, type GitFileStat } from "./git-log.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./workspace-roots.js";
import type { GraphConfig } from "./config.js";

const BLACKSITE_DIR = ".blacksite";
const CACHE_FILE = "graph-cache.json";
/* v2: node ids became folder-qualified in multi-root workspaces and layout
   packing changed. v3: nodes carry git churn/lastCommitAt for the heat layer.
   v4: cache records separate indexed/rendered capacity metadata.
   Older caches are discarded (they'd render wrong/stale data and, worse, look
   "complete" enough to suppress a rebuild). */
const CACHE_SCHEMA_VERSION = 4;
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

/** True when any path segment (including under a multi-root folder prefix)
    is one of the directories the map never indexes. */
function hasExcludedSegment(rel: string): boolean {
  return rel.split("/").some((seg) => EXCLUDED_SEGMENTS.has(seg));
}
/* Extensions worth showing on the map — code + the docs/config that link it. */
const INCLUDE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "rb", "php", "cs", "c", "h", "cpp", "hpp",
  "cc", "cxx", "hxx", "hh",
  "css", "scss", "less", "html", "htm", "vue", "svelte", "cshtml", "razor",
  "json", "md", "yaml", "yml", "toml",
]);

interface CacheDocument {
  schemaVersion: number;
  seed: number;
  indexedAt: string;
  truncated: boolean;
  indexedTruncated?: boolean;
  renderedTruncated?: boolean;
  indexedFileCount?: number;
  renderedNodeCount?: number;
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
      };
      this._indexedFiles = cached.nodes.map((node) => node.id);
    }
    return this._snapshot;
  }

  indexedFiles(): string[] {
    if (!this._snapshot) this.snapshot();
    return [...this._indexedFiles];
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
    const ext = langOf(rel);
    if (!INCLUDE_EXTS.has(ext)) return;
    this._dirty.add(normalizeGraphPath(rel));
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
    const maxIndexedFiles = Math.max(100, config.maxIndexedFiles);
    const maxRenderedStars = Math.max(100, config.maxRenderedStars);
    const roots = this._roots();
    const seen = new Set<string>();
    for (const root of roots) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root.path, "**/*"),
        EXCLUDE_GLOB,
        Math.max(RAW_SCAN_CAP, maxIndexedFiles),
      );
      for (const uri of uris) {
        const rel = toNodeId(roots, uri.fsPath);
        if (!rel) continue;
        if (!INCLUDE_EXTS.has(langOf(rel))) continue;
        seen.add(normalizeGraphPath(rel));
      }
    }
    const indexedTruncated = seen.size > maxIndexedFiles;
    const indexedFiles = indexedTruncated ? sampleAcrossClusters([...seen], maxIndexedFiles) : [...seen].sort();
    const renderedTruncated = indexedFiles.length > maxRenderedStars;
    const files = renderedTruncated ? sampleAcrossClusters(indexedFiles, maxRenderedStars) : [...indexedFiles].sort();
    return { indexedFiles, files, truncated: indexedTruncated || renderedTruncated, indexedTruncated, renderedTruncated };
  }

  private async _scanImports(files: string[]): Promise<Map<string, string[]>> {
    const fileSet = new Set(files);
    /* Name-based resolution (Razor bare partial/component names) needs a
       basename index; built once per rebuild, reused across every file. */
    const resolveCtx = { byBasename: buildBasenameIndex(fileSet) };
    const edges = new Map<string, string[]>();
    for (let i = 0; i < files.length; i += READ_BATCH) {
      const batch = files.slice(i, i + READ_BATCH);
      for (const rel of batch) {
        const absolute = fromNodeId(this._roots(), rel);
        if (!absolute) continue;
        let content: string;
        try {
          const stat = fs.statSync(absolute);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(absolute, "utf8");
        } catch {
          continue;
        }
        const targets = new Set<string>();
        if (langOf(rel) === "md") {
          /* Docs link to the code they describe: relate the doc to the files
             it references, so it clusters near what it documents. */
          for (const target of docReferences(rel, content, fileSet, resolveCtx.byBasename)) targets.add(target);
        } else {
          for (const spec of extractImports(rel, content)) {
            const resolved = resolveSpecifier(rel, spec, fileSet, resolveCtx);
            if (resolved && resolved !== rel) targets.add(resolved);
          }
        }
        if (targets.size > 0) edges.set(rel, [...targets]);
      }
      await yieldToLoop();
    }
    return edges;
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
    const importsByFile = await this._scanImports(files);
    const gitByAbs = await this._collectGit();

    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const [from, targets] of importsByFile) {
      outDegree.set(from, targets.length);
      for (const to of targets) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
    let maxDegree = 0;
    for (const rel of files) {
      maxDegree = Math.max(maxDegree, (inDegree.get(rel) ?? 0) + (outDegree.get(rel) ?? 0));
    }

    /* Adaptive clustering: a top-level package with thousands of files across
       dozens of subdirectories gets split into finer clusters one level at a
       time, instead of rendering as one giant same-color blob. */
    const clusters = assignClusters(files);

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
        edges.push({ id: importEdgeId(from, to), from, to, kind: "import" });
      }
    }

    /* Keep the map stable across rebuilds: previous positions seed the layout. */
    const prevPositions = new Map<string, { x: number; y: number }>();
    for (const node of this._snapshot?.nodes ?? []) prevPositions.set(node.id, { x: node.x, y: node.y });

    const layout = createLayout(nodes, edges, { seed: this._seed, prevPositions });
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
    };
    this._snapshot = snapshot;
    this._changedSinceLayout = 0;
    this._writeCache(snapshot);
    this._emitter.fire(snapshot);
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
    this._changedSinceLayout += dirty.length;
    if (this._changedSinceLayout > Math.max(50, snapshot.nodes.length * 0.1)) {
      void this.rebuild();
      return;
    }

    const maxNodes = Math.max(100, this._config().maxRenderedStars);
    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const fileSet = new Set(nodesById.keys());
    let mutated = false;

    /* Drop edges originating from dirty files; they get rescanned below. */
    let edges = snapshot.edges.filter((edge) => !dirty.includes(edge.from));
    if (edges.length !== snapshot.edges.length) mutated = true;

    /* Basename index for Razor name resolution; built once for the whole dirty
       pass (a file added mid-pass just isn't a name-resolution target yet). */
    const resolveCtx = { byBasename: buildBasenameIndex(fileSet) };
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of snapshot.nodes) positions.set(node.id, { x: node.x, y: node.y });
    const nodesByDir = new Map<string, string[]>();
    for (const node of snapshot.nodes) {
      const list = nodesByDir.get(node.dir) ?? [];
      list.push(node.id);
      nodesByDir.set(node.dir, list);
    }

    for (const rel of dirty) {
      const absolute = fromNodeId(this._roots(), rel);
      let exists = false;
      let sizeBytes = 0;
      if (absolute) {
        try {
          const stat = fs.statSync(absolute);
          exists = stat.isFile();
          sizeBytes = stat.size;
        } catch { /* deleted */ }
      }

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
          void this.rebuild();
          return;
        }
        const dir = clusterDir(rel);
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

      if (sizeBytes <= MAX_FILE_BYTES) {
        let content = "";
        try {
          content = fs.readFileSync(absolute, "utf8");
        } catch { /* unreadable */ }
        const targets = new Set<string>();
        if (langOf(rel) === "md") {
          for (const target of docReferences(rel, content, fileSet, resolveCtx.byBasename)) targets.add(target);
        } else {
          for (const spec of extractImports(rel, content)) {
            const resolved = resolveSpecifier(rel, spec, fileSet, resolveCtx);
            if (resolved && resolved !== rel) targets.add(resolved);
          }
        }
        for (const to of targets) {
          edges.push({ id: importEdgeId(rel, to), from: rel, to, kind: "import" });
        }
        if (targets.size > 0) mutated = true;
      }
      await yieldToLoop();
    }

    if (!mutated) return;

    /* Recompute degrees + depth cues from the updated edge set. */
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const edge of edges) {
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
      indexedFileCount: snapshot.indexedFileCount,
      renderedNodeCount: snapshot.renderedNodeCount,
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
