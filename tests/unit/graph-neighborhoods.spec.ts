import { describe, expect, it } from "vitest";
import {
  assignNeighborhoods,
  distinctNeighborhoods,
  neighborhoodLabel,
  neighborhoodRoots,
  shouldTerritorialize,
} from "../../src/graph/neighborhoods.js";
import { createLayout, territorialClusterCentroids } from "../../src/graph/layout.js";
import type { ProjectTopology } from "../../src/graph/project-topology.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";

const topology: ProjectTopology = {
  projects: [
    { id: "portal/src/Core", root: "portal/src/Core", name: "Core", kind: "dotnet", manifestFiles: [], containerRoot: "portal" },
    { id: "portal/src/Api", root: "portal/src/Api", name: "Api", kind: "dotnet", manifestFiles: [], containerRoot: "portal" },
    { id: "cdm/Cdm", root: "cdm/Cdm", name: "Cdm", kind: "dotnet", manifestFiles: [], containerRoot: "cdm" },
  ],
  references: [],
};

describe("assignNeighborhoods", () => {
  it("groups files by their project's solution/workspace container (manifests where present)", () => {
    const nb = assignNeighborhoods(
      ["portal/src/Core/Foo.cs", "portal/src/Api/Bar.cs", "cdm/Cdm/Baz.cs"],
      topology,
    );
    expect(nb.get("portal/src/Core/Foo.cs")).toBe("portal");
    expect(nb.get("portal/src/Api/Bar.cs")).toBe("portal");
    expect(nb.get("cdm/Cdm/Baz.cs")).toBe("cdm");
  });

  it("falls back to the top path segment for files under no project (folders otherwise)", () => {
    const nb = assignNeighborhoods(["docs/readme.md", "scripts/build.sh"], topology);
    expect(nb.get("docs/readme.md")).toBe("docs");
    expect(nb.get("scripts/build.sh")).toBe("scripts");
  });

  it("derives neighborhood roots from project containers", () => {
    expect(neighborhoodRoots(topology).sort()).toEqual(["cdm", "portal"]);
  });
});

describe("shouldTerritorialize", () => {
  const nb = (values: string[]): Map<string, string> => new Map(values.map((v, i) => [`f${i}`, v]));

  it("territorializes any workspace with 4+ distinct codebases", () => {
    expect(shouldTerritorialize(nb(["a", "b", "c", "d"]), 50)).toBe(true);
  });

  it("territorializes a sizable 2-3 codebase workspace but not a small one", () => {
    expect(shouldTerritorialize(nb(["a", "b", "c"]), 5000)).toBe(true);
    expect(shouldTerritorialize(nb(["a", "b"]), 100)).toBe(false);
  });

  it("ignores the loose root bucket when counting codebases", () => {
    expect(distinctNeighborhoods(nb(["a", ".", "."]))).toEqual(new Set(["a"]));
    expect(shouldTerritorialize(nb(["a", ".", ".", ".", "."]), 5000)).toBe(false);
  });
});

describe("neighborhoodLabel", () => {
  it("prefers the most specific non-generic trailing segment", () => {
    expect(neighborhoodLabel("Working Repos/Dev Portal Repo/Main/q2-portal-develop")).toBe("q2-portal-develop");
    expect(neighborhoodLabel("apps/web/src")).toBe("web");
    expect(neighborhoodLabel(".")).toBe("workspace");
  });
});

describe("territorial layout", () => {
  const nodes: Array<Pick<GraphNode, "id" | "dir">> = [
    { id: "A/x/1", dir: "A/x" }, { id: "A/x/2", dir: "A/x" }, { id: "A/y/1", dir: "A/y" },
    { id: "B/x/1", dir: "B/x" }, { id: "B/x/2", dir: "B/x" }, { id: "B/y/1", dir: "B/y" },
  ];
  const neighborhoods = new Map(nodes.map((n) => [n.id, n.id[0]!]));
  const dist = (m: Map<string, { x: number; y: number }>, a: string, b: string): number =>
    Math.hypot(m.get(a)!.x - m.get(b)!.x, m.get(a)!.y - m.get(b)!.y);

  it("places clusters of different codebases farther apart than clusters within one", () => {
    const centroids = territorialClusterCentroids(nodes, neighborhoods, 42);
    expect(dist(centroids, "A/x", "B/x")).toBeGreaterThan(dist(centroids, "A/x", "A/y"));
  });

  it("keeps codebases separated even when cross-codebase imports exist", () => {
    const fullNodes: GraphNode[] = nodes.map((n) => ({
      ...n, lang: "cs", sizeBytes: 1, inDegree: 1, outDegree: 1, x: 0, y: 0, z: 0.5,
    }));
    /* A cross-codebase import that would drag territories together in a flat layout. */
    const edges: GraphEdge[] = [{ id: "imp:A/x/1->B/x/1", from: "A/x/1", to: "B/x/1", kind: "import" }];
    const positions = createLayout(fullNodes, edges, { seed: 1, neighborhoods }).positions();
    const mean = (ids: string[]): { x: number; y: number } => {
      const pts = ids.map((id) => positions.get(id)!);
      return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    };
    const a = mean(["A/x/1", "A/x/2", "A/y/1"]);
    const b = mean(["B/x/1", "B/x/2", "B/y/1"]);
    const between = Math.hypot(a.x - b.x, a.y - b.y);
    /* The two codebases' centres stay well separated, not collapsed to a blob. */
    expect(between).toBeGreaterThan(100);
  });
});
