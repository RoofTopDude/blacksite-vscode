import { describe, expect, it } from "vitest";
import { neighborhoodConnectivityStats } from "../../src/graph/connectivity-stats.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";

function node(id: string, neighborhood: string | undefined, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id, dir: id.slice(0, id.lastIndexOf("/")), neighborhood, lang: "py",
    sizeBytes: 100, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 1,
    ...overrides,
  };
}

function edge(from: string, to: string, kind: GraphEdge["kind"] = "import"): GraphEdge {
  return { id: `${kind}:${from}->${to}`, from, to, kind };
}

describe("neighborhoodConnectivityStats", () => {
  it("computes average degree and orphan ratio per neighborhood", () => {
    const nodes = [
      node("py/a.py", "py"),
      node("py/b.py", "py"),
      node("py/c.py", "py"), // orphan — no edges
      node("cs/a.cs", "cs"),
      node("cs/b.cs", "cs"),
    ];
    const edges = [
      edge("py/a.py", "py/b.py"),
      edge("cs/a.cs", "cs/b.cs"),
      edge("cs/b.cs", "cs/a.cs"),
    ];
    const stats = neighborhoodConnectivityStats(nodes, edges, new Set(["py/c.py"]));

    const py = stats.find((s) => s.neighborhood === "py")!;
    expect(py.fileCount).toBe(3);
    expect(py.averageDegree).toBeCloseTo((1 + 1 + 0) / 3);
    expect(py.orphanRatio).toBeCloseTo(1 / 3);

    const cs = stats.find((s) => s.neighborhood === "cs")!;
    expect(cs.fileCount).toBe(2);
    expect(cs.averageDegree).toBeCloseTo(2); // each side of a mutual edge pair has in+out = 2
    expect(cs.orphanRatio).toBe(0);
  });

  it("falls back to one __all__ bucket when no node carries a neighborhood", () => {
    const nodes = [node("a.py", undefined), node("b.py", undefined)];
    const stats = neighborhoodConnectivityStats(nodes, [edge("a.py", "b.py")], []);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.neighborhood).toBe("__all__");
    expect(stats[0]!.fileCount).toBe(2);
  });

  it("excludes cluster/service aggregate nodes and non-import edges", () => {
    const nodes = [
      node("a.py", "py"),
      node("▤py", "py", { kind: "cluster", fileCount: 5 }),
      node("svc:py", "py", { kind: "service" }),
    ];
    const edges = [edge("a.py", "b.py", "call")]; // not an import edge
    const stats = neighborhoodConnectivityStats(nodes, edges, []);
    expect(stats[0]!.fileCount).toBe(1);
    expect(stats[0]!.averageDegree).toBe(0);
  });

  it("returns an empty array for no nodes", () => {
    expect(neighborhoodConnectivityStats([], [], [])).toEqual([]);
  });
});
