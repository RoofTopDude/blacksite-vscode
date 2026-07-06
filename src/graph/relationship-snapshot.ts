/* Shared, cached service-relationship snapshot for the Codebase Map. Both the
   webview provider (Services lens) and the agent gateway (map_relationships
   tool) read from one instance, so the expensive buildServiceRelationships pass
   runs once per index generation instead of once per caller.

   The full relationship set is built over the whole CORPUS (every eligible file,
   not the rendered slice) and kept uncapped — the render/query cap is applied as
   a projection at read time (get()), while the agent sees the full set (full()).
   Host-only (uses fs) — never imported by webview code. */

import * as fs from "fs";
import type { GraphEdge } from "./graph-model.js";
import { buildServiceRelationships, type IndexedFileContent } from "./relationship-indexer.js";
import { rankRelationshipEdges } from "./corpus.js";
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
  private _allEdges: GraphEdge[] = [];

  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexer: GraphIndexer,
    private readonly _config: () => GraphConfig,
  ) {}

  /** Build the full, uncapped relationship set over the whole corpus, cached by
      the corpus file set + topology + index generation so repeated reads within
      one generation reuse the last computed edges. The output edge cap is NOT
      part of the key — the full set is cap-independent; caps are applied on read. */
  private _rebuildIfStale(): void {
    const corpusFiles = this._indexer.corpusFiles();
    const topology = this._indexer.topology();
    const key = [
      corpusFiles.length,
      corpusFiles[0] ?? "",
      corpusFiles[corpusFiles.length - 1] ?? "",
      this._indexer.snapshot()?.indexedAt ?? "",
      topology?.projects.length ?? 0,
      topology?.references.length ?? 0,
    ].join(":");
    if (key === this._key) return;
    const result = buildServiceRelationships(readIndexedContents(this._roots(), corpusFiles), Infinity, topology);
    this._key = key;
    this._allEdges = result.edges;
  }

  /** Every relationship edge in the corpus, uncapped — the agent (map_relationships)
      view. */
  full(): GraphEdge[] {
    this._rebuildIfStale();
    return this._allEdges;
  }

  /** Render projection: the highest-confidence edges up to the configured cap. */
  get(): RelationshipSnapshotResult {
    this._rebuildIfStale();
    return rankRelationshipEdges(this._allEdges, this._config().maxRelationshipEdges);
  }
}
