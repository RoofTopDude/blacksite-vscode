/* Shared, cached service-relationship snapshot for the Codebase Map. Both the
   webview provider (Services lens) and the agent gateway (map_relationships
   tool) read from one instance, so the expensive buildServiceRelationships pass
   runs once per index generation instead of once per caller. Host-only (uses
   fs) — never imported by webview code. */

import * as fs from "fs";
import type { GraphEdge } from "./graph-model.js";
import { buildServiceRelationships, type IndexedFileContent } from "./relationship-indexer.js";
import type { GraphConfig } from "./config.js";
import type { GraphIndexer } from "./graph-indexer.js";
import { fromNodeId, type WorkspaceRoot } from "./workspace-roots.js";

const MAX_FILE_BYTES = 512_000;

/** Read the on-disk contents of indexed files, skipping anything unreadable or
    over the size ceiling. Shared by the relationship snapshot and any other
    caller that needs file bodies keyed by node id. */
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

export interface RelationshipSnapshotResult {
  edges: GraphEdge[];
  truncated: boolean;
}

export class RelationshipSnapshot {
  private _key = "";
  private _edges: GraphEdge[] = [];
  private _truncated = false;

  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexer: GraphIndexer,
    private readonly _config: () => GraphConfig,
  ) {}

  /** Cached by the indexed file set + config + topology + index generation, so
      repeated reads within one index generation reuse the last computed edges. */
  get(): RelationshipSnapshotResult {
    const indexedFiles = this._indexer.indexedFiles();
    const config = this._config();
    const topology = this._indexer.topology();
    const key = [
      indexedFiles.length,
      indexedFiles[0] ?? "",
      indexedFiles[indexedFiles.length - 1] ?? "",
      config.maxRelationshipEdges,
      this._indexer.snapshot()?.indexedAt ?? "",
      topology?.projects.length ?? 0,
      topology?.references.length ?? 0,
    ].join(":");
    if (key === this._key) return { edges: this._edges, truncated: this._truncated };
    const result = buildServiceRelationships(readIndexedContents(this._roots(), indexedFiles), config.maxRelationshipEdges, topology);
    this._key = key;
    this._edges = result.edges;
    this._truncated = result.truncated;
    return { edges: result.edges, truncated: result.truncated };
  }
}
