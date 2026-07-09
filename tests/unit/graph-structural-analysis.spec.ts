import { describe, expect, it } from "vitest";
import {
  classifyStructuralRoles,
  connectedComponents,
  cyclicNeighborhoodPairs,
  findBridges,
  findCycles,
  neighborhoodForProject,
} from "../../src/graph/structural-analysis.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";
import type { ProjectNode, ProjectReference } from "../../src/graph/project-topology.js";

function project(root: string, containerRoot?: string): ProjectNode {
  return { id: root, root, name: root, kind: "npm", manifestFiles: [], containerRoot };
}
function ref(from: string, to: string): ProjectReference {
  return { from, to, kind: "package" };
}
function node(id: string, neighborhood?: string): GraphNode {
  return { id, dir: ".", neighborhood, lang: "ts", sizeBytes: 0, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0 };
}
function edge(from: string, to: string): GraphEdge {
  return { id: `imp:${from}->${to}`, from, to, kind: "import" };
}

describe("findCycles", () => {
  it("finds a simple A->B->C->A cycle and excludes a project only pointing into it", () => {
    const projects = [project("a"), project("b"), project("c"), project("d")];
    const references = [ref("a", "b"), ref("b", "c"), ref("c", "a"), ref("d", "a")];
    const cycles = findCycles(projects, references);
    expect(cycles).toEqual([["a", "b", "c"]]);
  });

  it("returns no cycles for a pure DAG", () => {
    const projects = [project("a"), project("b"), project("c")];
    const references = [ref("a", "b"), ref("b", "c")];
    expect(findCycles(projects, references)).toEqual([]);
  });
});

describe("neighborhoodForProject", () => {
  it("uses the container root when set", () => {
    expect(neighborhoodForProject({ root: "packages/a", containerRoot: "packages" })).toBe("packages");
  });
  it("falls back to its own root with no container", () => {
    expect(neighborhoodForProject({ root: "apps/foo" })).toBe("apps/foo");
  });
});

describe("cyclicNeighborhoodPairs", () => {
  it("reports a cycle that spans two neighborhoods", () => {
    const projects = [project("a", "nbA"), project("b", "nbB"), project("c", "nbA")];
    const cycles = [["a", "b", "c"]];
    expect(cyclicNeighborhoodPairs(cycles, projects)).toEqual([["nbA", "nbB"]]);
  });

  it("drops a cycle that collapses to a single neighborhood", () => {
    const projects = [project("a", "nbA"), project("b", "nbA"), project("c", "nbA")];
    const cycles = [["a", "b", "c"]];
    expect(cyclicNeighborhoodPairs(cycles, projects)).toEqual([]);
  });
});

describe("connectedComponents", () => {
  it("groups linked nodes and leaves the rest singleton", () => {
    const components = connectedComponents(["a", "b", "c", "d"], [{ from: "a", to: "b" }]);
    const sorted = components.map((c) => [...c].sort()).sort((x, y) => x.join().localeCompare(y.join()));
    expect(sorted).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});

describe("findBridges", () => {
  it("finds every edge in a linear chain as a bridge", () => {
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
    const bridges = findBridges(["a", "b", "c"], edges);
    expect(bridges).toHaveLength(2);
  });

  it("finds no bridges inside a triangle, but flags the pendant edge", () => {
    const edges = [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, // triangle: 2-edge-connected
      { from: "a", to: "d" }, // pendant
    ];
    const bridges = findBridges(["a", "b", "c", "d"], edges);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toEqual({ from: "a", to: "d" });
  });
});

describe("classifyStructuralRoles", () => {
  it("flags a fully disconnected pair as orphans, with no pockets in a plain chain", () => {
    const nodes = [node("a", "nb"), node("b", "nb"), node("c", "nb"), node("x", "nb"), node("y", "nb")];
    const edges = [edge("a", "b"), edge("b", "c"), edge("x", "y")];
    const { orphans, pockets } = classifyStructuralRoles(nodes, edges);
    expect(orphans).toEqual(new Set(["x", "y"]));
    expect(pockets.size).toBe(0);
  });

  it("respects minPocketSize as a boundary, not a suggestion", () => {
    // Main body a-b-c-d-e-f (clique-ish via a ring so it's 2-edge-connected,
    // no internal bridges), one bridge edge f->p1 hanging off a 3-file pocket
    // p1-p2-p3.
    const mainIds = ["a", "b", "c", "d", "e", "f"];
    const ring: GraphEdge[] = mainIds.map((id, i) => edge(id, mainIds[(i + 1) % mainIds.length]!));
    const pocketChain = [edge("f", "p1"), edge("p1", "p2"), edge("p2", "p3")];
    const nodes = [...mainIds, "p1", "p2", "p3"].map((id) => node(id, "nb"));
    const edges = [...ring, ...pocketChain];

    const withDefault = classifyStructuralRoles(nodes, edges); // minPocketSize = 4
    expect(withDefault.pockets.size).toBe(0);
    expect(withDefault.orphans.size).toBe(0); // everything is one connected component

    const withLower = classifyStructuralRoles(nodes, edges, 3);
    expect(withLower.pockets).toEqual(new Set(["p1", "p2", "p3"]));
    expect([...withLower.bridgeEdgeIds]).toContain(edge("f", "p1").id);
  });

  it("falls back to one __all__ bucket when no node carries a neighborhood", () => {
    const nodes = [node("a"), node("b"), node("x"), node("y")];
    const edges = [edge("a", "b")];
    const { orphans } = classifyStructuralRoles(nodes, edges);
    expect(orphans).toEqual(new Set(["x", "y"]));
  });

  it("ignores non-import edges and cluster/service super-nodes", () => {
    const nodes = [node("a", "nb"), node("b", "nb"), { ...node("▤cluster", "nb"), kind: "cluster" as const }];
    const edges: GraphEdge[] = [{ id: "note", from: "a", to: "b", kind: "user" }];
    const { orphans, pockets } = classifyStructuralRoles(nodes, edges);
    // The "user"-kind edge doesn't count for this analysis, and the cluster
    // super-node is excluded entirely — leaving "a" and "b" as two singleton
    // components with no import edge between them. One becomes the (arbitrary)
    // "largest", the other is the lone orphan.
    expect(orphans.size).toBe(1);
    expect(pockets.size).toBe(0);
  });
});
