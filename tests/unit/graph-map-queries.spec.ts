import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  findNodes,
  findRoutes,
  globToRegExp,
  summarizeByArea,
  traverseImpact,
} from "../../src/graph/map-queries.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";

function imp(from: string, to: string): GraphEdge {
  return { id: `imp:${from}->${to}`, from, to, kind: "import" };
}

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, dir: id.split("/").slice(0, -1).join("/"), lang: "ts", sizeBytes: 100,
    inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.5, ...extra,
  };
}

/* a -> b -> c -> d  (a depends on b depends on c depends on d) */
const chain = [imp("a.ts", "b.ts"), imp("b.ts", "c.ts"), imp("c.ts", "d.ts")];

describe("buildAdjacency", () => {
  it("normalizes every layer to a single 'depends on' direction", () => {
    const adjacency = buildAdjacency({
      importEdges: [imp("app.ts", "lib.ts")],
      serviceEdges: [{ id: "s1", from: "svc:a", to: "svc:b", kind: "api", sourcePath: "client.ts", targetPath: "server.ts" }],
      symbolEdges: [{ id: "y1", from: "base.ts", to: "impl.ts", kind: "supertype" }],
      layers: ["import", "service", "symbol"],
    });
    expect(adjacency.dependsOn.get("app.ts")?.map((l) => l.peer)).toEqual(["lib.ts"]);
    expect(adjacency.dependsOn.get("client.ts")?.map((l) => l.peer)).toEqual(["server.ts"]);
    expect(adjacency.dependsOn.get("base.ts")?.map((l) => l.peer)).toEqual(["impl.ts"]);
  });

  it("reverses symbol `reference` edges, which are stored definition→referencer", () => {
    // symbol-indexer records "who references MY symbol", so `to` is the dependent.
    const adjacency = buildAdjacency({
      symbolEdges: [{ id: "y1", from: "definer.ts", to: "user.ts", kind: "reference" }],
      layers: ["symbol"],
    });
    expect(adjacency.dependsOn.get("user.ts")?.map((l) => l.peer)).toEqual(["definer.ts"]);
    expect(adjacency.dependsOn.get("definer.ts")).toBeUndefined();
    expect(adjacency.dependedOnBy.get("definer.ts")?.map((l) => l.peer)).toEqual(["user.ts"]);
  });

  it("excludes layers the caller didn't ask for", () => {
    const adjacency = buildAdjacency({
      importEdges: [imp("a.ts", "b.ts")],
      symbolEdges: [{ id: "y1", from: "a.ts", to: "z.ts", kind: "call" }],
      layers: ["import"],
    });
    expect(adjacency.dependsOn.get("a.ts")?.map((l) => l.peer)).toEqual(["b.ts"]);
  });

  it("registers note edges both ways — a note asserts a relation, not a direction", () => {
    const adjacency = buildAdjacency({
      noteEdges: [{ from: "handler.ts", to: "worker.ts", title: "dispatches to" }],
      layers: ["note"],
    });
    expect(adjacency.dependsOn.get("handler.ts")?.map((l) => l.peer)).toEqual(["worker.ts"]);
    expect(adjacency.dependsOn.get("worker.ts")?.map((l) => l.peer)).toEqual(["handler.ts"]);
  });

  it("ignores service edges with no file anchors and self-links", () => {
    const adjacency = buildAdjacency({
      importEdges: [imp("a.ts", "a.ts")],
      serviceEdges: [{ id: "s1", from: "svc:a", to: "svc:b", kind: "event" }],
      layers: ["import", "service"],
    });
    expect(adjacency.ids.size).toBe(0);
  });
});

describe("traverseImpact", () => {
  const adjacency = buildAdjacency({ importEdges: chain, layers: ["import"] });

  it("walks dependents transitively with the depth of each hit", () => {
    const { hits } = traverseImpact(adjacency, ["d.ts"], { direction: "dependents", maxDepth: 3, maxNodes: 50 });
    expect(hits.map((h) => [h.id, h.depth])).toEqual([["c.ts", 1], ["b.ts", 2], ["a.ts", 3]]);
    expect(hits.every((h) => h.relation === "dependent")).toBe(true);
  });

  it("stops at maxDepth", () => {
    const { hits } = traverseImpact(adjacency, ["d.ts"], { direction: "dependents", maxDepth: 1, maxNodes: 50 });
    expect(hits.map((h) => h.id)).toEqual(["c.ts"]);
  });

  it("walks dependencies in the other direction", () => {
    const { hits } = traverseImpact(adjacency, ["a.ts"], { direction: "dependencies", maxDepth: 3, maxNodes: 50 });
    expect(hits.map((h) => h.id)).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(hits.every((h) => h.relation === "dependency")).toBe(true);
  });

  it("orders a dependent's chain outward-in, along the arrows", () => {
    const { hits } = traverseImpact(adjacency, ["d.ts"], { direction: "dependents", maxDepth: 3, maxNodes: 50 });
    const a = hits.find((h) => h.id === "a.ts")!;
    expect(a.via.map((s) => `${s.from}->${s.to}`)).toEqual(["a.ts->b.ts", "b.ts->c.ts", "c.ts->d.ts"]);
  });

  it("orders a dependency's chain seed-first, also along the arrows", () => {
    const { hits } = traverseImpact(adjacency, ["a.ts"], { direction: "dependencies", maxDepth: 3, maxNodes: 50 });
    const d = hits.find((h) => h.id === "d.ts")!;
    expect(d.via.map((s) => `${s.from}->${s.to}`)).toEqual(["a.ts->b.ts", "b.ts->c.ts", "c.ts->d.ts"]);
  });

  it("never reports a seed as its own impact", () => {
    const cyclic = buildAdjacency({ importEdges: [imp("a.ts", "b.ts"), imp("b.ts", "a.ts")], layers: ["import"] });
    const { hits } = traverseImpact(cyclic, ["a.ts"], { direction: "both", maxDepth: 4, maxNodes: 50 });
    expect(hits.map((h) => h.id)).toEqual(["b.ts"]);
  });

  it("merges multiple seeds into one frontier, attributing each file to the nearer seed", () => {
    /* hub is 1 hop from seed2 and 2 hops from seed1 — it must be reported once, at depth 1. */
    const adj = buildAdjacency({
      importEdges: [imp("hub.ts", "seed2.ts"), imp("seed2.ts", "seed1.ts")],
      layers: ["import"],
    });
    const { hits } = traverseImpact(adj, ["seed1.ts", "seed2.ts"], { direction: "dependents", maxDepth: 3, maxNodes: 50 });
    expect(hits.filter((h) => h.id === "hub.ts")).toHaveLength(1);
    expect(hits.find((h) => h.id === "hub.ts")).toMatchObject({ depth: 1, seed: "seed2.ts" });
  });

  it("reports truncation instead of silently returning a partial radius", () => {
    const wide = buildAdjacency({
      importEdges: ["a", "b", "c", "d", "e"].map((n) => imp(`${n}.ts`, "core.ts")),
      layers: ["import"],
    });
    const { hits, truncated } = traverseImpact(wide, ["core.ts"], { direction: "dependents", maxDepth: 2, maxNodes: 3 });
    expect(truncated).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe("findRoutes", () => {
  const adjacency = buildAdjacency({ importEdges: chain, layers: ["import"] });

  it("returns the shortest chain first, with a step per hop", () => {
    const { routes } = findRoutes(adjacency, "a.ts", "d.ts", { maxHops: 5, maxRoutes: 3 });
    expect(routes[0]!.path).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(routes[0]!.hops).toBe(3);
    expect(routes[0]!.steps).toHaveLength(3);
  });

  it("finds no route past maxHops", () => {
    const { routes } = findRoutes(adjacency, "a.ts", "d.ts", { maxHops: 2, maxRoutes: 3 });
    expect(routes).toEqual([]);
  });

  it("finds an upstream target only when the search is undirected", () => {
    expect(findRoutes(adjacency, "d.ts", "a.ts", { maxHops: 5, maxRoutes: 3 }).routes).toHaveLength(1);
    expect(findRoutes(adjacency, "d.ts", "a.ts", { maxHops: 5, maxRoutes: 3, undirected: false }).routes).toEqual([]);
  });

  it("enumerates several distinct routes, shortest first", () => {
    const forked = buildAdjacency({
      importEdges: [imp("a.ts", "x.ts"), imp("x.ts", "z.ts"), imp("a.ts", "y1.ts"), imp("y1.ts", "y2.ts"), imp("y2.ts", "z.ts")],
      layers: ["import"],
    });
    const { routes } = findRoutes(forked, "a.ts", "z.ts", { maxHops: 5, maxRoutes: 5 });
    expect(routes.map((r) => r.hops)).toEqual([2, 3]);
    expect(routes[0]!.path).toEqual(["a.ts", "x.ts", "z.ts"]);
  });

  it("never revisits a node inside one route", () => {
    const cyclic = buildAdjacency({
      importEdges: [imp("a.ts", "b.ts"), imp("b.ts", "a.ts"), imp("b.ts", "c.ts")],
      layers: ["import"],
    });
    const { routes } = findRoutes(cyclic, "a.ts", "c.ts", { maxHops: 5, maxRoutes: 5 });
    for (const route of routes) expect(new Set(route.path).size).toBe(route.path.length);
  });

  it("reports truncation when the expansion ceiling stops the search", () => {
    const { truncated } = findRoutes(adjacency, "a.ts", "d.ts", { maxHops: 5, maxRoutes: 3, maxExpansions: 1 });
    expect(truncated).toBe(true);
  });
});

describe("findNodes", () => {
  const nodes: GraphNode[] = [
    node("src/graph/layout.ts", { inDegree: 5, outDegree: 2, churn: 9, sizeBytes: 900, lastCommitAt: 300 }),
    node("src/graph/model.ts", { inDegree: 12, outDegree: 1, churn: 2, sizeBytes: 400, lastCommitAt: 100 }),
    node("src/ui/panel.tsx", { inDegree: 1, outDegree: 4, churn: 20, sizeBytes: 1500, lastCommitAt: 500, lang: "tsx" }),
    node("docs/readme.md", { inDegree: 0, outDegree: 0, lang: "md", sizeBytes: 50 }),
  ];

  it("filters by area on segment boundaries", () => {
    expect(findNodes(nodes, { area: "src/graph" }).files.map((f) => f.path))
      .toEqual(["src/graph/model.ts", "src/graph/layout.ts"]);
    // "src/g" must not match "src/graph/..." — it isn't a directory.
    expect(findNodes(nodes, { area: "src/g" }).matched).toBe(0);
  });

  it("ranks by the requested key", () => {
    expect(findNodes(nodes, { sortBy: "dependents" }).files[0]!.path).toBe("src/graph/model.ts");
    expect(findNodes(nodes, { sortBy: "churn" }).files[0]!.path).toBe("src/ui/panel.tsx");
    expect(findNodes(nodes, { sortBy: "size" }).files[0]!.path).toBe("src/ui/panel.tsx");
    expect(findNodes(nodes, { sortBy: "recency" }).files[0]!.path).toBe("src/ui/panel.tsx");
    expect(findNodes(nodes, { sortBy: "path" }).files[0]!.path).toBe("docs/readme.md");
  });

  it("filters by language, degree, and churn", () => {
    expect(findNodes(nodes, { langs: ["tsx"] }).files.map((f) => f.path)).toEqual(["src/ui/panel.tsx"]);
    expect(findNodes(nodes, { minDegree: 8 }).files.map((f) => f.path)).toEqual(["src/graph/model.ts"]);
    expect(findNodes(nodes, { minChurn: 10 }).files.map((f) => f.path)).toEqual(["src/ui/panel.tsx"]);
  });

  it("reports the pre-limit match count so a capped list is never read as the whole list", () => {
    const result = findNodes(nodes, { limit: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.matched).toBe(4);
  });

  it("matches globs, with ** spanning directories and * not", () => {
    expect(findNodes(nodes, { glob: "src/**/*.ts" }).files.map((f) => f.path))
      .toEqual(["src/graph/model.ts", "src/graph/layout.ts"]);
    expect(findNodes(nodes, { glob: "src/*.ts" }).matched).toBe(0);
  });

  it("omits churn fields entirely when the git layer never ran", () => {
    const hit = findNodes(nodes, { area: "docs" }).files[0]!;
    expect(hit).not.toHaveProperty("churn");
    expect(hit).not.toHaveProperty("lastCommitAt");
  });
});

describe("globToRegExp", () => {
  it("treats glob metacharacters as globs and everything else literally", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/nested/a.ts")).toBe(false);
    expect(globToRegExp("**/*.spec.ts").test("tests/unit/x.spec.ts")).toBe(true);
    expect(globToRegExp("**/*.spec.ts").test("x.spec.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a1.ts")).toBe(true);
    expect(globToRegExp("a.ts").test("axts")).toBe(false);
  });
});

describe("summarizeByArea", () => {
  it("groups and ranks reached files by area", () => {
    const areas = summarizeByArea(
      [{ id: "src/a.ts" }, { id: "src/b.ts" }, { id: "ui/c.ts" }],
      (id) => id.split("/")[0]!,
    );
    expect(areas).toEqual([{ area: "src", files: 2 }, { area: "ui", files: 1 }]);
  });
});
