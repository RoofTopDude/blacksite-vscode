/* Shared, cached structural-role snapshot for the Codebase Map: cross-project
   cycles and per-neighborhood cul-de-sacs (orphans + single-access pockets).
   Mirrors relationship-snapshot.ts's caching shape, but needs no fs reads —
   everything it operates on (topology, the rendered node/edge set) already
   lives on GraphIndexer. Deliberately not persisted to the render cache — see
   graph/structural-analysis.ts's header — recomputed whenever the indexer's
   generation changes, the same precedent ProjectTopology itself already sets. */

import { classifyStructuralRoles, cyclicNeighborhoodPairs, findCycles } from "./structural-analysis.js";
import type { GraphIndexer } from "./graph-indexer.js";

export interface StructuralSnapshotResult {
  cyclicNeighborhoodPairs: Array<[string, string]>;
  orphanNodeIds: string[];
  pocketNodeIds: string[];
  bridgeEdgeIds: string[];
}

const EMPTY_RESULT: StructuralSnapshotResult = {
  cyclicNeighborhoodPairs: [],
  orphanNodeIds: [],
  pocketNodeIds: [],
  bridgeEdgeIds: [],
};

export class StructuralSnapshot {
  private _key = "";
  private _result: StructuralSnapshotResult = EMPTY_RESULT;

  constructor(private readonly _indexer: GraphIndexer) {}

  /** Cached by index generation + topology size, mirroring RelationshipSnapshot's
      key shape — cheap to recompute (linear-time graph algorithms over the
      already-capped rendered node/edge set), but no reason to redo it on every
      _postState() call within one generation. */
  private _rebuildIfStale(): void {
    const snapshot = this._indexer.snapshot();
    const topology = this._indexer.topology();
    const key = [
      snapshot?.indexedAt ?? "",
      snapshot?.nodes.length ?? 0,
      topology?.projects.length ?? 0,
      topology?.references.length ?? 0,
    ].join(":");
    if (key === this._key) return;
    this._key = key;
    if (!snapshot) {
      this._result = EMPTY_RESULT;
      return;
    }
    const cycles = topology ? findCycles(topology.projects, topology.references) : [];
    const pairs = topology ? cyclicNeighborhoodPairs(cycles, topology.projects) : [];
    const { orphans, pockets, bridgeEdgeIds } = classifyStructuralRoles(snapshot.nodes, snapshot.edges);
    this._result = {
      cyclicNeighborhoodPairs: pairs,
      orphanNodeIds: [...orphans],
      pocketNodeIds: [...pockets],
      bridgeEdgeIds: [...bridgeEdgeIds],
    };
  }

  get(): StructuralSnapshotResult {
    this._rebuildIfStale();
    return this._result;
  }
}
