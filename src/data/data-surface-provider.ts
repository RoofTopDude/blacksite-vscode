// The one adapter every Data consumer goes through.
//
// Both the webview (`data-provider.ts`) and the agent tools (`data.*`) call this
// surface — never the stores directly — so embedded SQLite and the optional pgvector
// sidecar present one identical product API. Switching vector backends swaps the
// injected `VectorProvider` and nothing else.

import type { DatabaseManager } from "./database-manager.js";
import { CatalogStore, type CatalogTree, type ObjectDescription, type PreviewOptions, type PreviewResult } from "./catalog-store.js";
import { QueryService, type QueryResult, type RunQueryOptions, type SavedQuery } from "./query-service.js";
import type { VectorProvider, VectorSearchHit, VectorStats } from "./vector-provider.js";

export interface DataSurfaceStatus {
  available: boolean;
  engine: string | null;
  schemaVersion: number;
  vectorBackend: string;
  reason?: string;
}

export interface VectorSearchInput {
  vector: number[];
  topK?: number;
  collection?: string;
}

/**
 * Composes the catalog store, query service, and vector provider into the stable
 * `DataSurfaceProvider` capability layer described in BLA-80/81.
 */
export class DataSurfaceProvider {
  private readonly catalog: CatalogStore;
  private readonly queries: QueryService;

  constructor(
    private readonly db: DatabaseManager,
    private vectors: VectorProvider,
  ) {
    this.catalog = new CatalogStore(db);
    this.queries = new QueryService(db);
  }

  /** Swap the active vector backend (exact_local ⇄ pgvector_container). */
  setVectorProvider(provider: VectorProvider): void {
    this.vectors = provider;
  }

  status(): DataSurfaceStatus {
    return {
      available: this.db.isOpen,
      engine: this.db.engine,
      schemaVersion: this.db.migrationResult?.toVersion ?? 0,
      vectorBackend: this.vectors.mode,
    };
  }

  // ── Catalog ────────────────────────────────────────────────────────────────

  getCatalog(): CatalogTree {
    return this.catalog.getCatalogTree();
  }

  describeObject(name: string): ObjectDescription {
    return this.catalog.describeObject(name);
  }

  previewRows(name: string, options?: PreviewOptions): PreviewResult {
    return this.catalog.previewRows(name, options);
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult> {
    return this.queries.run(sql, options);
  }

  previewQuery(sql: string): { classification: ReturnType<QueryService["preview"]>["classification"]; message: string } {
    return this.queries.preview(sql);
  }

  listSavedQueries(): SavedQuery[] {
    return this.queries.listSavedQueries();
  }

  getSavedQuery(id: string): SavedQuery | undefined {
    return this.queries.getSavedQuery(id);
  }

  saveQuery(input: { id?: string; name: string; sql: string; description?: string }): Promise<SavedQuery> {
    return this.queries.saveQuery(input);
  }

  deleteSavedQuery(id: string): Promise<boolean> {
    return this.queries.deleteSavedQuery(id);
  }

  markSavedQueryRun(id: string): Promise<void> {
    return this.queries.markSavedQueryRun(id);
  }

  // ── Vectors ────────────────────────────────────────────────────────────────

  vectorSearch(input: VectorSearchInput): Promise<VectorSearchHit[]> {
    return this.vectors.search(input.vector, { topK: input.topK, collection: input.collection });
  }

  vectorStats(): Promise<VectorStats> {
    return this.vectors.stats();
  }

  vectorRebuild(): Promise<void> {
    return this.vectors.rebuild();
  }
}
