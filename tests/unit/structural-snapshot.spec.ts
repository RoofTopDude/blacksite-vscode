import { describe, expect, it, vi } from "vitest";
import type { GraphIndexer } from "../../src/graph/graph-indexer.js";

/* Mirrors relationship-snapshot.spec.ts's containment tests: a throwing analysis pass
   must not escape get() and must not be retried on every call within one generation —
   get() is invoked directly from _postState()'s unguarded onDidChange listeners, so an
   uncaught exception there would abort the whole graph_state broadcast, not just this
   one lens. */

const analysis = vi.hoisted(() => ({ classifyStructuralRoles: vi.fn() }));
vi.mock("../../src/graph/structural-analysis.js", () => ({
  findCycles: () => [],
  cyclicNeighborhoodPairs: () => [],
  classifyStructuralRoles: analysis.classifyStructuralRoles,
}));

const { StructuralSnapshot } = await import("../../src/graph/structural-snapshot.js");

function fakeIndexer(indexedAt: string): GraphIndexer {
  return {
    snapshot: () => ({ indexedAt, nodes: [], edges: [] }),
    topology: () => null,
  } as unknown as GraphIndexer;
}

describe("StructuralSnapshot failure containment", () => {
  it("does not let a throwing analysis pass escape get()", () => {
    analysis.classifyStructuralRoles.mockImplementation(() => { throw new Error("boom"); });
    const snap = new StructuralSnapshot(fakeIndexer("T1"));
    expect(() => snap.get()).not.toThrow();
    expect(snap.get()).toEqual({
      cyclicNeighborhoodPairs: [], orphanNodeIds: [], pocketNodeIds: [], bridgeEdgeIds: [],
    });
  });

  it("does not re-run the analysis on every get() while the generation is unchanged", () => {
    analysis.classifyStructuralRoles.mockImplementation(() => { throw new Error("boom"); });
    const snap = new StructuralSnapshot(fakeIndexer("T1"));
    snap.get(); snap.get(); snap.get();
    expect(analysis.classifyStructuralRoles).toHaveBeenCalledTimes(1);
  });

  it("retries once the graph generation actually changes", () => {
    analysis.classifyStructuralRoles.mockImplementation(() => { throw new Error("boom"); });
    let indexedAt = "T1";
    const indexer = { snapshot: () => ({ indexedAt, nodes: [], edges: [] }), topology: () => null } as unknown as GraphIndexer;
    const snap = new StructuralSnapshot(indexer);
    snap.get();
    indexedAt = "T2";
    snap.get();
    expect(analysis.classifyStructuralRoles).toHaveBeenCalledTimes(2);
  });
});
