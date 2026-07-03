import { describe, expect, it } from "vitest";
import { clusterCentroids, computeLayout, placeNearCluster, seededRandom } from "../../src/graph/layout.js";
import { clusterDir, depthFromDegree, importEdgeId, langOf, normalizeGraphPath } from "../../src/graph/graph-model.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";

function makeNode(id: string, dir: string, degree = 0): GraphNode {
  return { id, dir, lang: "ts", sizeBytes: 100, inDegree: degree, outDegree: 0, x: 0, y: 0, z: 0.5 };
}

function fixture(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 12; i += 1) nodes.push(makeNode(`src/a${i}.ts`, "src", i % 3));
  for (let i = 0; i < 12; i += 1) nodes.push(makeNode(`lib/b${i}.ts`, "lib", i % 3));
  const edges: GraphEdge[] = [
    { id: importEdgeId("src/a0.ts", "src/a1.ts"), from: "src/a0.ts", to: "src/a1.ts", kind: "import" },
    { id: importEdgeId("lib/b0.ts", "lib/b1.ts"), from: "lib/b0.ts", to: "lib/b1.ts", kind: "import" },
    { id: importEdgeId("src/a0.ts", "lib/b0.ts"), from: "src/a0.ts", to: "lib/b0.ts", kind: "import" },
  ];
  return { nodes, edges };
}

describe("graph-model helpers", () => {
  it("normalizes windows separators", () => {
    expect(normalizeGraphPath("src\\webview\\shell.html")).toBe("src/webview/shell.html");
  });
  it("derives cluster dirs", () => {
    expect(clusterDir("src/webview/react/App.tsx")).toBe("src/webview");
    expect(clusterDir("src/a.ts")).toBe("src");
    expect(clusterDir("package.json")).toBe(".");
  });
  it("derives languages", () => {
    expect(langOf("a/b.TSX")).toBe("tsx");
    expect(langOf("Makefile")).toBe("");
  });
  it("depth cue is monotonic in degree and bounded", () => {
    const low = depthFromDegree(0, 1, 40);
    const high = depthFromDegree(20, 20, 40);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(1);
    expect(depthFromDegree(0, 0, 0)).toBeGreaterThan(0);
  });
});

describe("seededRandom", () => {
  it("is deterministic per seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("computeLayout", () => {
  it("produces identical positions for the same seed", () => {
    const { nodes, edges } = fixture();
    const first = computeLayout(nodes, edges, { seed: 42 });
    const second = computeLayout(nodes, edges, { seed: 42 });
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("produces finite coordinates for every node", () => {
    const { nodes, edges } = fixture();
    const positions = computeLayout(nodes, edges, { seed: 1 });
    expect(positions.size).toBe(nodes.length);
    for (const { x, y } of positions.values()) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("separates clusters more than it spreads them internally", () => {
    const { nodes, edges } = fixture();
    const positions = computeLayout(nodes, edges, { seed: 42 });
    const centroid = (dir: string) => {
      let sx = 0, sy = 0, count = 0;
      for (const node of nodes) {
        if (node.dir !== dir) continue;
        const p = positions.get(node.id)!;
        sx += p.x; sy += p.y; count += 1;
      }
      return { x: sx / count, y: sy / count };
    };
    const spread = (dir: string) => {
      const c = centroid(dir);
      let total = 0, count = 0;
      for (const node of nodes) {
        if (node.dir !== dir) continue;
        const p = positions.get(node.id)!;
        total += Math.hypot(p.x - c.x, p.y - c.y);
        count += 1;
      }
      return total / count;
    };
    const cSrc = centroid("src");
    const cLib = centroid("lib");
    const interCluster = Math.hypot(cSrc.x - cLib.x, cSrc.y - cLib.y);
    expect(interCluster).toBeGreaterThan(spread("src"));
    expect(interCluster).toBeGreaterThan(spread("lib"));
  });

  it("keeps pinned previous positions fixed", () => {
    const { nodes, edges } = fixture();
    const prev = new Map([["src/a0.ts", { x: 123, y: -456 }]]);
    const positions = computeLayout(nodes, edges, { seed: 42, prevPositions: prev, pinPrevious: true });
    expect(positions.get("src/a0.ts")).toEqual({ x: 123, y: -456 });
  });
});

describe("clusterCentroids / placeNearCluster", () => {
  it("gives every dir a distinct centroid", () => {
    const nodes = [makeNode("a/x.ts", "a"), makeNode("b/y.ts", "b"), makeNode("c/z.ts", "c")];
    const centroids = clusterCentroids(nodes, 100);
    expect(centroids.size).toBe(3);
    const values = [...centroids.values()].map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    expect(new Set(values).size).toBe(3);
  });

  it("anchors the largest cluster at the center", () => {
    const nodes = [
      ...Array.from({ length: 40 }, (_, i) => makeNode(`big/x${i}.ts`, "big")),
      ...Array.from({ length: 3 }, (_, i) => makeNode(`small/y${i}.ts`, "small")),
    ];
    const centroids = clusterCentroids(nodes);
    const big = centroids.get("big")!;
    const small = centroids.get("small")!;
    expect(Math.hypot(big.x, big.y)).toBeLessThan(Math.hypot(small.x, small.y));
    expect(Math.hypot(big.x, big.y)).toBe(0);
  });

  it("packs many clusters compactly: world radius ~O(sqrt(totalNodes))", () => {
    // Regression: the old uniform spacing*sqrt(i) spread put 100 clusters of a
    // 4k-node project across tens of thousands of units — unviewable at any
    // clamped zoom. Area-proportional packing keeps the extent proportional
    // to sqrt(N), independent of the cluster count.
    const nodes: GraphNode[] = [];
    for (let cluster = 0; cluster < 100; cluster += 1) {
      for (let i = 0; i < 40; i += 1) nodes.push(makeNode(`dir${cluster}/f${i}.ts`, `dir${cluster}`));
    }
    const centroids = clusterCentroids(nodes); // 4000 nodes
    let maxRadius = 0;
    for (const { x, y } of centroids.values()) maxRadius = Math.max(maxRadius, Math.hypot(x, y));
    expect(maxRadius).toBeLessThan(30 * Math.sqrt(4000) * 1.2); // ≈ 2280
    expect(maxRadius).toBeGreaterThan(300); // sanity: clusters aren't stacked
  });

  it("places a new node near its cluster's members", () => {
    const existing = new Map([
      ["src/a.ts", { x: 100, y: 100 }],
      ["src/b.ts", { x: 120, y: 90 }],
    ]);
    const byDir = new Map<string, readonly string[]>([["src", ["src/a.ts", "src/b.ts"]]]);
    const pos = placeNearCluster("src", existing, byDir, 5);
    expect(Math.hypot(pos.x - 110, pos.y - 95)).toBeLessThan(80);
  });
});
