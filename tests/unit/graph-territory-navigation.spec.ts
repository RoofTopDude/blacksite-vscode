/* Organization/navigation helpers added for the Map's territory index,
   connections navigator, and ranked fuzzy search (v0.4.0). Pure view-model —
   no DOM, no pixi. */

import { describe, expect, it } from "vitest";
import {
  folderTerritories,
  matchesSearch,
  nodeConnections,
  searchHighlightSegments,
  searchMatches,
} from "../../src/webview/react/lib/graph/view-model.js";
import type { GraphEdge, GraphNode } from "../../src/webview/react/lib/graph/protocol.js";

function node(id: string, dir = "src", extra: Partial<GraphNode> = {}): GraphNode {
  return { id, dir, lang: "ts", sizeBytes: 10, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.5, ...extra };
}

function importEdge(from: string, to: string): GraphEdge {
  return { id: `imp:${from}->${to}`, from, to, kind: "import" };
}

describe("search ranking and fuzzy matching", () => {
  it("keeps plain substring behavior", () => {
    expect(matchesSearch(node("src/GraphApp.tsx"), "graphapp")).toBe(true);
    expect(matchesSearch(node("src/a.ts"), "zzz")).toBe(false);
    expect(matchesSearch(node("src/a.ts"), "  ")).toBe(true);
  });

  it("ANDs whitespace-separated terms", () => {
    expect(matchesSearch(node("src/graph/store.ts"), "graph store")).toBe(true);
    expect(matchesSearch(node("src/graph/render.ts"), "graph store")).toBe(false);
  });

  it("falls back to a fuzzy subsequence on the basename only", () => {
    expect(matchesSearch(node("src/GraphApp.tsx"), "grapp")).toBe(true);
    /* 's','r','c' appear in the dir part, not the basename — no match. */
    expect(matchesSearch(node("src/zzz.md"), "src")).toBe(true); /* substring of full path */
    expect(matchesSearch(node("deep/nested/zzz.md"), "dnz")).toBe(false);
  });

  it("skips fuzzy matching for 1-2 character terms", () => {
    /* "xq" is a subsequence of "index.quiz.ts" but too short to fuzz. */
    expect(matchesSearch(node("src/index.quiz.ts"), "xq")).toBe(false);
    expect(matchesSearch(node("src/xq.ts"), "xq")).toBe(true);
  });

  it("ranks basename hits above directory hits, prefix above infix", () => {
    const nodes = [
      node("store/util.ts"),          /* dir substring only */
      node("src/mega-store.ts"),      /* basename infix */
      node("src/store.ts"),           /* basename prefix */
    ];
    const ranked = searchMatches(nodes, "store", 10).map((n) => n.id);
    expect(ranked[0]).toBe("src/store.ts");
    expect(ranked[1]).toBe("src/mega-store.ts");
    expect(ranked[2]).toBe("store/util.ts");
  });

  it("respects the limit and empty-query contract", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => node(`src/file${i}.ts`));
    expect(searchMatches(nodes, "file", 5).length).toBe(5);
    expect(searchMatches(nodes, "", 5)).toEqual([]);
  });

  it("highlight segments reassemble the original path and mark the hit", () => {
    const segments = searchHighlightSegments("src/GraphApp.tsx", "graphapp");
    expect(segments.map((s) => s.text).join("")).toBe("src/GraphApp.tsx");
    expect(segments.filter((s) => s.hit).map((s) => s.text).join("")).toBe("GraphApp");
  });

  it("highlight segments mark fuzzy hits character-by-character", () => {
    const segments = searchHighlightSegments("src/GraphApp.tsx", "gapp");
    expect(segments.map((s) => s.text).join("")).toBe("src/GraphApp.tsx");
    /* Greedy subsequence: G, then the first following a/p/p — "Gapp". */
    expect(segments.filter((s) => s.hit).map((s) => s.text).join("")).toBe("Gapp");
  });

  it("a non-matching query yields one unhighlighted segment", () => {
    expect(searchHighlightSegments("src/a.ts", "zzz")).toEqual([{ text: "src/a.ts", hit: false }]);
    expect(searchHighlightSegments("src/a.ts", "")).toEqual([{ text: "src/a.ts", hit: false }]);
  });
});

describe("folderTerritories", () => {
  const nodes = [
    node("app/a.ts", "app", { x: 0, y: 0 }),
    node("app/b.ts", "app", { x: 10, y: 20 }),
    node("app/c.ts", "app", { x: 20, y: 40 }),
    node("lib/a.ts", "lib", { x: 100, y: 100 }),
    node("lib/b.ts", "lib", { x: 120, y: 140 }),
    node("bin/x.ts", "bin", { x: -50, y: -50 }),
  ];

  it("groups by dir, biggest first, with centroid and bounds", () => {
    const territories = folderTerritories(nodes);
    expect(territories.map((t) => t.dir)).toEqual(["app", "lib", "bin"]);
    const app = territories[0]!;
    expect(app.count).toBe(3);
    expect(app.x).toBe(10);
    expect(app.y).toBe(20);
    expect(app.bounds).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 40 });
  });

  it("applies the limit and ignores aggregate nodes", () => {
    const withAggregates = [
      ...nodes,
      node("▤ghost", "ghost", { kind: "cluster", fileCount: 99 }),
      node("svc:ghost2", "ghost2", { kind: "service" }),
    ];
    const territories = folderTerritories(withAggregates, 2);
    expect(territories.map((t) => t.dir)).toEqual(["app", "lib"]);
  });
});

describe("nodeConnections", () => {
  const nodes = [
    node("src/root.ts"),
    node("src/hub.ts", "src", { inDegree: 8, outDegree: 4 }),
    node("src/leaf.ts", "src", { inDegree: 1, outDegree: 0 }),
    node("src/user1.ts", "src", { inDegree: 0, outDegree: 3 }),
    node("src/user2.ts", "src", { inDegree: 2, outDegree: 6 }),
  ];
  const edges = [
    importEdge("src/root.ts", "src/hub.ts"),
    importEdge("src/root.ts", "src/leaf.ts"),
    importEdge("src/user1.ts", "src/root.ts"),
    importEdge("src/user2.ts", "src/root.ts"),
    /* duplicate detection + non-import noise must not double-count */
    importEdge("src/user2.ts", "src/root.ts"),
    { id: "api:x", from: "src/root.ts", to: "src/user1.ts", kind: "api" as const },
  ];

  it("splits by direction and ranks by connectivity", () => {
    const { dependencies, dependents } = nodeConnections("src/root.ts", nodes, edges);
    expect(dependencies.total).toBe(2);
    expect(dependencies.nodes.map((n) => n.id)).toEqual(["src/hub.ts", "src/leaf.ts"]);
    expect(dependents.total).toBe(2);
    expect(dependents.nodes.map((n) => n.id)).toEqual(["src/user2.ts", "src/user1.ts"]);
  });

  it("caps the listed nodes but reports the true total", () => {
    const { dependencies } = nodeConnections("src/root.ts", nodes, edges, 1);
    expect(dependencies.total).toBe(2);
    expect(dependencies.nodes.length).toBe(1);
    expect(dependencies.nodes[0]!.id).toBe("src/hub.ts");
  });

  it("is empty for an unconnected node", () => {
    const { dependencies, dependents } = nodeConnections("src/leaf.ts", nodes, [importEdge("src/root.ts", "src/leaf.ts")]);
    expect(dependencies.total).toBe(0);
    expect(dependents.nodes.map((n) => n.id)).toEqual(["src/root.ts"]);
  });
});
