import { describe, expect, it } from "vitest";
import {
  assignNeighborhoods,
  distinctNeighborhoods,
  neighborhoodLabel,
  neighborhoodRoots,
  shouldTerritorialize,
} from "../../src/graph/neighborhoods.js";
import { createLayout, neighborhoodCenters, territorialClusterCentroids } from "../../src/graph/layout.js";
import { buildProjectTopology, type ProjectTopology } from "../../src/graph/project-topology.js";
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

  it("pulls an unowned file into the codebase it imports from (affinity over the segment fallback)", () => {
    /* tools/gen.cs isn't under any project, but it imports portal code — so it
       joins the portal territory instead of sitting in a lone "tools" bucket. */
    const edges = new Map<string, readonly string[]>([
      ["tools/gen.cs", ["portal/src/Core/Foo.cs"]],
    ]);
    const nb = assignNeighborhoods(
      ["portal/src/Core/Foo.cs", "tools/gen.cs"],
      topology,
      edges,
    );
    expect(nb.get("tools/gen.cs")).toBe("portal");
  });

  it("propagates affinity across a chain of unowned files, but islands keep the segment", () => {
    const edges = new Map<string, readonly string[]>([
      ["scripts/a.cs", ["scripts/b.cs"]],
      ["scripts/b.cs", ["cdm/Cdm/Baz.cs"]],
    ]);
    const nb = assignNeighborhoods(
      ["cdm/Cdm/Baz.cs", "scripts/a.cs", "scripts/b.cs", "loose/orphan.md"],
      topology,
      edges,
    );
    expect(nb.get("scripts/b.cs")).toBe("cdm"); // one hop from owned
    expect(nb.get("scripts/a.cs")).toBe("cdm"); // two hops, via b
    expect(nb.get("loose/orphan.md")).toBe("loose"); // no path to any codebase
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

  it("places clusters of the same subdivision (project) tighter than clusters of different projects", () => {
    /* One neighborhood "N" split into two topology sub-projects p1/p2. Folders
       of the same project should sit together within the territory. */
    const topology = buildProjectTopology([
      { path: "n/p1/package.json", content: JSON.stringify({ name: "p1" }) },
      { path: "n/p2/package.json", content: JSON.stringify({ name: "p2" }) },
    ]);
    const nodes: Array<Pick<GraphNode, "id" | "dir">> = [];
    for (const dir of ["n/p1/a", "n/p1/b", "n/p2/a", "n/p2/b"]) {
      for (let i = 0; i < 3; i += 1) nodes.push({ id: `${dir}/f${i}.ts`, dir });
    }
    const neighborhoods = new Map(nodes.map((n) => [n.id, "N"]));
    const c = territorialClusterCentroids(nodes, neighborhoods, 42, [], topology);
    const d = (a: string, b: string): number => Math.hypot(c.get(a)!.x - c.get(b)!.x, c.get(a)!.y - c.get(b)!.y);
    expect(d("n/p1/a", "n/p1/b")).toBeLessThan(d("n/p1/a", "n/p2/a"));
    expect(d("n/p2/a", "n/p2/b")).toBeLessThan(d("n/p2/a", "n/p1/a"));
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

describe("neighborhoodCenters", () => {
  const nbNodes = (spec: Record<string, number>): Array<Pick<GraphNode, "id">> => {
    const nodes: Array<Pick<GraphNode, "id">> = [];
    for (const [nb, count] of Object.entries(spec)) {
      for (let i = 0; i < count; i += 1) nodes.push({ id: `${nb}/f${i}.ts` });
    }
    return nodes;
  };
  const nbMap = (nodes: Array<Pick<GraphNode, "id">>): Map<string, string> =>
    new Map(nodes.map((n) => [n.id, n.id.split("/")[0]!]));
  const imp = (from: string, to: string): Pick<GraphEdge, "from" | "to" | "kind"> => ({ from, to, kind: "import" });
  const dist = (m: Map<string, { x: number; y: number }>, a: string, b: string): number =>
    Math.hypot(m.get(a)!.x - m.get(b)!.x, m.get(a)!.y - m.get(b)!.y);

  it("places a coupled neighborhood pair nearer each other than an uncoupled one", () => {
    const nodes = nbNodes({ A: 8, B: 8, C: 8 });
    const edges = Array.from({ length: 8 }, (_, i) => imp(`A/f${i}.ts`, `B/f${i}.ts`));
    const centers = neighborhoodCenters(nodes, edges, nbMap(nodes), 42);
    expect(dist(centers, "A", "B")).toBeLessThan(dist(centers, "A", "C"));
    expect(dist(centers, "A", "B")).toBeLessThan(dist(centers, "B", "C"));
  });

  it("draws a neighborhood pair closer once they share imports (edges aggregated upward)", () => {
    const nodes = nbNodes({ A: 5, B: 5 });
    const edges = Array.from({ length: 5 }, (_, i) => imp(`A/f${i}.ts`, `B/f${i}.ts`));
    const withEdges = neighborhoodCenters(nodes, edges, nbMap(nodes), 42);
    const without = neighborhoodCenters(nodes, [], nbMap(nodes), 42);
    expect(dist(withEdges, "A", "B")).toBeLessThan(dist(without, "A", "B"));
    expect(dist(withEdges, "A", "B")).toBeGreaterThan(0); // coupled, not collapsed
  });

  it("is deterministic for identical input", () => {
    const nodes = nbNodes({ A: 4, B: 4, C: 4 });
    const edges = [imp("A/f0.ts", "B/f0.ts"), imp("B/f1.ts", "C/f1.ts")];
    const first = neighborhoodCenters(nodes, edges, nbMap(nodes), 42);
    const second = neighborhoodCenters(nodes, edges, nbMap(nodes), 42);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });
});
