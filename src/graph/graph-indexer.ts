/* Host-side indexer for the Codebase Map: enumerates workspace files, scans
   imports, runs the seeded force layout in chunks, caches the result at
   .blacksite/graph-cache.json, and watches the workspace for incremental
   updates. Derived data only — annotations live in graph-annotation-store. */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  clusterDir,
  depthFromDegree,
  importEdgeId,
  langOf,
  normalizeGraphPath,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./graph-model.js";
import { extractImports } from "./import-scan.js";
import { resolveSpecifier } from "./resolve-imports.js";
import { createLayout, placeNearCluster } from "./layout.js";

const BLACKSITE_DIR = ".blacksite";
const CACHE_FILE = "graph-cache.json";
const CACHE_SCHEMA_VERSION = 1;
const EXCLUDE_GLOB = "**/{node_modules,.git,.blacksite,dist,out,build,.next,coverage,__pycache__,.venv,venv}/**";
const READ_BATCH = 50;
const TICK_CHUNK = 20;
const MAX_FILE_BYTES = 512_000;
/* Extensions worth showing on the map — code + the docs/config that link it. */
const INCLUDE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "rb", "php", "cs", "c", "h", "cpp", "hpp",
  "css", "scss", "less", "html", "vue", "svelte",
  "json", "md", "yaml", "yml", "toml",
]);

interface CacheDocument {
  schemaVersion: number;
  seed: number;
  indexedAt: string;
  truncated: boolean;
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

  constructor(
    private readonly _workspaceRoot: string,
    private readonly _maxNodes: () => number,
  ) {}

  dispose(): void {
    this._disposed = true;
    this._watcher?.dispose();
    if (this._debounce) clearTimeout(this._debounce);
    this._emitter.dispose();
    this._indexingEmitter.dispose();
  }

  isIndexing(): boolean {
    return this._rebuilding;
  }

  snapshot(): GraphSnapshot | null {
    if (this._snapshot) return this._snapshot;
    const cached = normalizeCache(readJsonFile(this._cachePath()));
    if (cached) {
      this._seed = cached.seed;
      this._snapshot = {
        nodes: cached.nodes,
        edges: cached.importEdges,
        indexedAt: cached.indexedAt,
        truncated: cached.truncated,
      };
    }
    return this._snapshot;
  }

  start(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceRoot, "**/*"),
      false, false, false,
    );
    const onTouch = (uri: vscode.Uri) => this._markDirty(uri);
    watcher.onDidCreate(onTouch);
    watcher.onDidChange(onTouch);
    watcher.onDidDelete(onTouch);
    this._watcher = watcher;
    if (!this.snapshot()) void this.rebuild();
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

  private _cachePath(): string {
    return path.join(this._workspaceRoot, BLACKSITE_DIR, CACHE_FILE);
  }

  private _markDirty(uri: vscode.Uri): void {
    const rel = path.relative(this._workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return;
    if (rel.startsWith(".blacksite/") || rel.includes("/node_modules/") || rel.startsWith("node_modules/")) return;
    const ext = langOf(rel);
    if (!INCLUDE_EXTS.has(ext)) return;
    this._dirty.add(normalizeGraphPath(rel));
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => void this._applyDirty(), 2000);
  }

  private async _enumerate(): Promise<{ files: string[]; truncated: boolean }> {
    const maxNodes = Math.max(100, this._maxNodes());
    const uris = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, maxNodes + 1);
    const files: string[] = [];
    for (const uri of uris) {
      const rel = path.relative(this._workspaceRoot, uri.fsPath).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..")) continue;
      if (!INCLUDE_EXTS.has(langOf(rel))) continue;
      files.push(normalizeGraphPath(rel));
    }
    files.sort();
    const truncated = uris.length > maxNodes;
    return { files: files.slice(0, maxNodes), truncated };
  }

  private async _scanImports(files: string[]): Promise<Map<string, string[]>> {
    const fileSet = new Set(files);
    const edges = new Map<string, string[]>();
    for (let i = 0; i < files.length; i += READ_BATCH) {
      const batch = files.slice(i, i + READ_BATCH);
      for (const rel of batch) {
        const absolute = path.join(this._workspaceRoot, rel);
        let content: string;
        try {
          const stat = fs.statSync(absolute);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(absolute, "utf8");
        } catch {
          continue;
        }
        const targets = new Set<string>();
        for (const spec of extractImports(rel, content)) {
          const resolved = resolveSpecifier(rel, spec, fileSet);
          if (resolved && resolved !== rel) targets.add(resolved);
        }
        if (targets.size > 0) edges.set(rel, [...targets]);
      }
      await yieldToLoop();
    }
    return edges;
  }

  private async _rebuildOnce(): Promise<void> {
    const { files, truncated } = await this._enumerate();
    const importsByFile = await this._scanImports(files);

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

    const nodes: GraphNode[] = files.map((rel) => {
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(path.join(this._workspaceRoot, rel)).size;
      } catch { /* deleted mid-scan */ }
      const nIn = inDegree.get(rel) ?? 0;
      const nOut = outDegree.get(rel) ?? 0;
      return {
        id: rel,
        dir: clusterDir(rel),
        lang: langOf(rel),
        sizeBytes,
        inDegree: nIn,
        outDegree: nOut,
        x: 0,
        y: 0,
        z: depthFromDegree(nIn, nOut, maxDegree),
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

    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const fileSet = new Set(nodesById.keys());
    let mutated = false;

    /* Drop edges originating from dirty files; they get rescanned below. */
    let edges = snapshot.edges.filter((edge) => !dirty.includes(edge.from));
    if (edges.length !== snapshot.edges.length) mutated = true;

    const positions = new Map<string, { x: number; y: number }>();
    for (const node of snapshot.nodes) positions.set(node.id, { x: node.x, y: node.y });
    const nodesByDir = new Map<string, string[]>();
    for (const node of snapshot.nodes) {
      const list = nodesByDir.get(node.dir) ?? [];
      list.push(node.id);
      nodesByDir.set(node.dir, list);
    }

    for (const rel of dirty) {
      const absolute = path.join(this._workspaceRoot, rel);
      let exists = false;
      let sizeBytes = 0;
      try {
        const stat = fs.statSync(absolute);
        exists = stat.isFile();
        sizeBytes = stat.size;
      } catch { /* deleted */ }

      if (!exists) {
        if (nodesById.delete(rel)) {
          fileSet.delete(rel);
          edges = edges.filter((edge) => edge.from !== rel && edge.to !== rel);
          mutated = true;
        }
        continue;
      }

      let node = nodesById.get(rel);
      if (!node) {
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
        for (const spec of extractImports(rel, content)) {
          const resolved = resolveSpecifier(rel, spec, fileSet);
          if (resolved && resolved !== rel) targets.add(resolved);
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
      nodes: snapshot.nodes,
      importEdges: snapshot.edges,
    };
    try {
      const dir = path.join(this._workspaceRoot, BLACKSITE_DIR);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._cachePath(), JSON.stringify(document), "utf8");
    } catch { /* cache is best-effort; unwritable workspaces still get a live map */ }
  }
}
