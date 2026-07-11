/* Shared, cached service-relationship snapshot for the Codebase Map. Both the
   webview provider (Services lens) and the agent gateway (map_relationships
   tool) read from one instance, so the expensive buildServiceRelationships pass
   runs once per index generation instead of once per caller.

   The full relationship set is built over every file admitted by the selected
   indexing profile, not the smaller render projection. Discovery is
   asynchronous: stale work reads files in bounded batches and notifies
   subscribers when ready, while get() remains a cheap snapshot read. This keeps
   large-workspace analysis off the graph_state posting path. */

import * as fs from "fs";
import type { GraphEdge } from "./graph-model.js";
import { buildServiceRelationships, type IndexedFileContent } from "./relationship-indexer.js";
import { rankRelationshipEdges } from "./corpus.js";
import type { GraphConfig } from "./config.js";
import type { GraphIndexer } from "./graph-indexer.js";
import { fromNodeId, type WorkspaceRoot } from "./workspace-roots.js";

const MAX_FILE_BYTES = 512_000;
const READ_BATCH = 48;

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Synchronous helper retained for focused callers/tests. Production snapshot
    rebuilds use readIndexedContentsAsync below. */
export function readIndexedContents(roots: readonly WorkspaceRoot[], files: readonly string[]): IndexedFileContent[] {
  const out: IndexedFileContent[] = [];
  for (const rel of files) {
    const absolute = fromNodeId(roots, rel);
    if (!absolute) continue;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      out.push({ path: rel, content: fs.readFileSync(absolute, "utf8") });
    } catch {
      /* best-effort relationship index */
    }
  }
  return out;
}

/** Read in bounded asynchronous batches. This avoids both a 100k-file Promise
    fan-out and long uninterrupted runs of synchronous filesystem calls. */
export async function readIndexedContentsAsync(
  roots: readonly WorkspaceRoot[],
  files: readonly string[],
): Promise<IndexedFileContent[]> {
  const out: IndexedFileContent[] = [];
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const rows = await Promise.all(files.slice(i, i + READ_BATCH).map(async (rel): Promise<IndexedFileContent | null> => {
      const absolute = fromNodeId(roots, rel);
      if (!absolute) return null;
      try {
        const stat = await fs.promises.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
        return { path: rel, content: await fs.promises.readFile(absolute, "utf8") };
      } catch {
        return null;
      }
    }));
    for (const row of rows) if (row) out.push(row);
    await yieldToLoop();
  }
  return out;
}

export interface RelationshipSnapshotResult {
  edges: GraphEdge[];
  truncated: boolean;
  indexing: boolean;
  totalEdgeCount: number;
}

export class RelationshipSnapshot {
  private _key = "";
  private _allEdges: GraphEdge[] = [];
  private _buildingKey = "";
  private _building: Promise<void> | null = null;
  private readonly _listeners = new Set<() => void>();

  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexer: GraphIndexer,
    private readonly _config: () => GraphConfig,
  ) {}

  onDidChange(listener: () => void): { dispose(): void } {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  isIndexing(): boolean {
    return this._building !== null;
  }

  private _emit(): void {
    for (const listener of this._listeners) listener();
  }

  private _currentKey(): string {
    const files = this._indexer.indexedFiles();
    const topology = this._indexer.topology();
    return [
      files.length,
      files[0] ?? "",
      files[files.length - 1] ?? "",
      this._indexer.snapshot()?.indexedAt ?? "",
      topology?.projects.length ?? 0,
      topology?.references.length ?? 0,
    ].join(":");
  }

  /** Ensure one background build for the current graph generation. Results
      from an older generation are discarded rather than briefly published. */
  private _ensureFresh(): Promise<void> {
    const key = this._currentKey();
    if (key === this._key) return Promise.resolve();
    if (this._building && this._buildingKey === key) return this._building;
    if (this._building) return this._building.then(() => this._ensureFresh());

    const files = this._indexer.indexedFiles();
    const topology = this._indexer.topology();
    this._buildingKey = key;
    this._building = (async () => {
      const contents = await readIndexedContentsAsync(this._roots(), files);
      await yieldToLoop();
      const result = buildServiceRelationships(contents, Infinity, topology);
      if (this._currentKey() !== key) return;
      this._key = key;
      this._allEdges = result.edges;
    })().catch(() => {
      /* Best-effort analysis: retain the previous good generation on failure. */
    }).finally(() => {
      if (this._buildingKey !== key) return;
      this._building = null;
      this._buildingKey = "";
      this._emit();
      if (this._currentKey() !== this._key) void this._ensureFresh();
    });
    this._emit();
    return this._building;
  }

  /** Latest full relationship set. Schedules a refresh without blocking. */
  full(): GraphEdge[] {
    void this._ensureFresh();
    return this._allEdges;
  }

  /** Agent queries may wait for the current generation to become available. */
  async fullAsync(): Promise<GraphEdge[]> {
    await this._ensureFresh();
    return this._allEdges;
  }

  /** Latest render projection; schedules stale work in the background. */
  get(): RelationshipSnapshotResult {
    void this._ensureFresh();
    const projection = rankRelationshipEdges(this._allEdges, this._config().maxRelationshipEdges);
    return {
      ...projection,
      indexing: this.isIndexing(),
      totalEdgeCount: this._allEdges.length,
    };
  }
}
