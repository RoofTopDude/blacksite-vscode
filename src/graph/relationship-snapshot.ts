/* Shared, cached service-relationship snapshot for the Codebase Map. Both the
   webview provider (Services lens) and the agent gateway (map_relationships
   tool) read from one instance, so the expensive buildServiceRelationships pass
   runs once per index generation instead of once per caller.

   The full relationship set is built over every file admitted by the selected
   indexing profile, not the smaller render projection. The pass itself is the
   relationship job (relationship-job.ts), run by whatever the host passes in —
   the background worker in the extension — so this class never reads a file.
   Stale work runs in the background and notifies subscribers when ready, while
   get() remains a cheap snapshot read. This keeps large-workspace analysis off
   the graph_state posting path. */

import type { GraphEdge } from "./graph-model.js";
import { rankRelationshipEdges } from "./corpus.js";
import type { GraphConfig } from "./config.js";
import type { MapIndexReader, ServiceRelationshipReader } from "./index-reader.js";
import type { RelationshipJobInput, RelationshipJobResult } from "./relationship-job.js";

export interface RelationshipSnapshotResult {
  edges: GraphEdge[];
  truncated: boolean;
  indexing: boolean;
  totalEdgeCount: number;
}

/** Runs one relationship pass (relationship-job.ts) and resolves with its result. */
export type RelationshipJobRunner = (input: RelationshipJobInput) => Promise<RelationshipJobResult>;

export class RelationshipSnapshot implements ServiceRelationshipReader {
  private _key = "";
  private _allEdges: GraphEdge[] = [];
  private _buildingKey = "";
  private _building: Promise<void> | null = null;
  /** Generation whose build threw, retried only once the graph generation
      changes.

      Without this, the "still stale? rebuild" check at the end of a build
      restarts the identical failing build immediately: one reproducible
      exception becomes an unbounded loop that re-reads the whole corpus every
      pass, and if the throw happens before the first `await` the loop never
      yields at all and wedges the extension host. Failing to a retained
      previous generation is the intended degradation; failing into a spin is
      not. */
  private _failedKey = "";
  private readonly _listeners = new Set<() => void>();

  constructor(
    private readonly _index: MapIndexReader,
    private readonly _runJob: RelationshipJobRunner,
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
    const files = this._index.indexedFiles();
    const topology = this._index.topology();
    return [
      files.length,
      files[0] ?? "",
      files[files.length - 1] ?? "",
      this._index.snapshot()?.indexedAt ?? "",
      topology?.projects.length ?? 0,
      topology?.references.length ?? 0,
    ].join(":");
  }

  /** Ensure one background build for the current graph generation. Results
      from an older generation are discarded rather than briefly published. */
  private _ensureFresh(): Promise<void> {
    const key = this._currentKey();
    if (key === this._key) return Promise.resolve();
    /* This exact generation already failed; wait for the graph to change
       rather than rebuilding it on every get()/full() call. */
    if (key === this._failedKey) return Promise.resolve();
    if (this._building && this._buildingKey === key) return this._building;
    if (this._building) return this._building.then(() => this._ensureFresh());

    const files = this._index.indexedFiles();
    const topology = this._index.topology();
    this._buildingKey = key;
    this._building = (async () => {
      /* The job runner puts this pass in the background worker (and caches it
         against a corpus fingerprint), so reading every source file never
         happens on the extension host thread. */
      const edges = (await this._runJob({ files, topology })).edges;
      if (this._currentKey() !== key) return;
      this._key = key;
      this._failedKey = "";
      this._allEdges = edges;
    })().catch(() => {
      /* Best-effort analysis: retain the previous good generation on failure,
         and don't attempt this same generation again — see _failedKey. */
      this._failedKey = key;
    }).finally(() => {
      if (this._buildingKey !== key) return;
      this._building = null;
      this._buildingKey = "";
      this._emit();
      const next = this._currentKey();
      if (next !== this._key && next !== this._failedKey) void this._ensureFresh();
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
