import { describe, expect, it } from "vitest";
import {
  assignNeighborhoods,
  distinctNeighborhoods,
  neighborhoodLabel,
  neighborhoodRoots,
  shouldTerritorialize,
} from "../../src/graph/neighborhoods.js";
import { createLayout, estimateClusterRadius, folderTreeGap, territorialClusterCentroids } from "../../src/graph/layout.js";
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

  it("keeps a file in its own folder's codebase even when it imports another codebase", () => {
    /* Directory first: tools/gen.cs imports portal code but lives in tools/, so
       it stays a tools file. Folding importers into what they import used to
       merge whole unowned trees (src/, tests/) into the one package they use. */
    const edges = new Map<string, readonly string[]>([
      ["tools/gen.cs", ["portal/src/Core/Foo.cs"]],
      ["src/agent.ts", ["packages/runtime/src/index.ts"]],
    ]);
    const withPackage = buildProjectTopology([{ path: "packages/runtime/package.json", content: JSON.stringify({ name: "runtime" }) }]);
    expect(assignNeighborhoods(["portal/src/Core/Foo.cs", "tools/gen.cs"], topology, edges).get("tools/gen.cs")).toBe("tools");
    expect(assignNeighborhoods(["packages/runtime/src/index.ts", "src/agent.ts"], withPackage, edges).get("src/agent.ts")).toBe("src");
  });

  it("gives an unowned folder beside real projects its own codebase, not the shared container's", () => {
    const services = buildProjectTopology([
      { path: "services/auth/package.json", content: JSON.stringify({ name: "auth" }) },
      { path: "services/payments/package.json", content: JSON.stringify({ name: "payments" }) },
    ]);
    const nb = assignNeighborhoods(
      ["services/auth/src/a.ts", "services/billing/src/b.ts", "services/billing/c.ts", "services/README.md"],
      services,
    );
    expect(nb.get("services/auth/src/a.ts")).toBe("services/auth");
    expect(nb.get("services/billing/src/b.ts")).toBe("services/billing");
    expect(nb.get("services/billing/c.ts")).toBe("services/billing");
    expect(nb.get("services/README.md")).toBe("services");
  });

  it("pulls only loose top-level files toward the codebase they import, across chains", () => {
    const edges = new Map<string, readonly string[]>([
      ["a.cs", ["b.cs"]],
      ["b.cs", ["cdm/Cdm/Baz.cs"]],
      ["scripts/c.cs", ["cdm/Cdm/Baz.cs"]],
    ]);
    const nb = assignNeighborhoods(
      ["cdm/Cdm/Baz.cs", "a.cs", "b.cs", "orphan.md", "scripts/c.cs"],
      topology,
      edges,
    );
    expect(nb.get("b.cs")).toBe("cdm"); // one hop from owned
    expect(nb.get("a.cs")).toBe("cdm"); // two hops, via b
    expect(nb.get("orphan.md")).toBe("."); // no path to any codebase
    expect(nb.get("scripts/c.cs")).toBe("scripts"); // has a folder of its own
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

describe("codebase placement", () => {
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

  /* One folder per codebase here, so a codebase's centre is its folder's. */
  const centersOf = (nodes: Array<Pick<GraphNode, "id">>, edges: Array<Pick<GraphEdge, "from" | "to" | "kind">>): Map<string, { x: number; y: number }> =>
    territorialClusterCentroids(nodes.map((n) => ({ id: n.id, dir: n.id.split("/")[0]! })), nbMap(nodes), 42, edges);

  it("packs a coupled codebase pair side by side, separated by the territory moat", () => {
    const nodes = nbNodes({ A: 8, B: 8, C: 8, D: 8, E: 8 });
    const edges = Array.from({ length: 8 }, (_, i) => imp(`A/f${i}.ts`, `B/f${i}.ts`));
    const centers = centersOf(nodes, edges);
    const radius = estimateClusterRadius(8, 42);
    const touching = 2 * radius + folderTreeGap(1, true);
    expect(dist(centers, "A", "B")).toBeCloseTo(touching, 3);
    for (const other of ["C", "D", "E"]) {
      expect(dist(centers, "A", other)).toBeGreaterThanOrEqual(touching - 1e-6);
      expect(dist(centers, "B", other)).toBeGreaterThanOrEqual(touching - 1e-6);
    }
  });

  it("is deterministic for identical input", () => {
    const nodes = nbNodes({ A: 4, B: 4, C: 4 });
    const edges = [imp("A/f0.ts", "B/f0.ts"), imp("B/f1.ts", "C/f1.ts")];
    expect([...centersOf(nodes, edges).entries()]).toEqual([...centersOf(nodes, edges).entries()]);
  });
});
