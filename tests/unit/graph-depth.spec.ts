import { describe, expect, it } from "vitest";
import {
  DEPTH_CHANNELS,
  applyDepthIntensity,
  depthFor,
  depthMap,
  depthStats,
  isDepthChannel,
} from "../../src/webview/react/lib/graph/depth.js";
import type { GraphNode } from "../../src/webview/react/lib/graph/protocol.js";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    dir: id.slice(0, Math.max(0, id.lastIndexOf("/"))),
    lang: "ts",
    sizeBytes: 1024,
    inDegree: 0,
    outDegree: 0,
    x: 0,
    y: 0,
    z: 0.5,
    ...over,
  };
}

const FLOOR = 0.15;

describe("depthFor — bounds", () => {
  it("stays within [0.15, 1] for every channel, including degenerate input", () => {
    const nodes = [
      node("a.ts"),
      node("a/b/c/d/e.ts", { inDegree: 40, outDegree: 3, churn: 90, lastCommitAt: 2_000, sizeBytes: 900_000 }),
      node("weird.ts", { inDegree: -1, outDegree: -1, churn: -5, lastCommitAt: -1, sizeBytes: -10 }),
    ];
    const stats = depthStats(nodes);
    for (const channel of DEPTH_CHANNELS) {
      for (const n of nodes) {
        const depth = depthFor(n, channel, stats);
        expect(Number.isFinite(depth)).toBe(true);
        expect(depth).toBeGreaterThanOrEqual(FLOOR);
        expect(depth).toBeLessThanOrEqual(1);
      }
    }
  });

  it("survives an empty corpus without dividing by zero", () => {
    const stats = depthStats([]);
    for (const channel of DEPTH_CHANNELS) {
      expect(Number.isFinite(depthFor(node("a.ts"), channel, stats))).toBe(true);
    }
  });
});

describe("nesting channel", () => {
  it("puts shallow paths forward and deep ones back", () => {
    const nodes = [node("index.ts"), node("src/app.ts"), node("src/a/b/c/deep.ts")];
    const stats = depthStats(nodes);
    const [root, mid, deep] = nodes.map((n) => depthFor(n, "nesting", stats));
    expect(root).toBeGreaterThan(mid!);
    expect(mid!).toBeGreaterThan(deep!);
    expect(root).toBe(1);
    expect(deep).toBe(FLOOR);
  });

  it("measures a collapsed folder super-node by its own directory", () => {
    const nodes = [node("index.ts"), node("src/a/b/deep.ts")];
    const stats = depthStats(nodes);
    const cluster = node("·src/a", { dir: "src/a", kind: "cluster", fileCount: 12 });
    /* "src/a" is two segments deep, the same as the file's directory. */
    expect(depthFor(cluster, "nesting", stats)).toBeCloseTo(depthFor(node("src/a/deep.ts"), "nesting", stats), 10);
  });

  it("returns full depth when every file is at the root", () => {
    const nodes = [node("a.ts"), node("b.ts")];
    const stats = depthStats(nodes);
    expect(depthFor(nodes[0]!, "nesting", stats)).toBe(1);
  });
});

describe("degree channel", () => {
  it("puts hubs forward and isolated files at the floor", () => {
    const hub = node("hub.ts", { inDegree: 30, outDegree: 20 });
    const leaf = node("leaf.ts", { inDegree: 1, outDegree: 0 });
    const island = node("island.ts");
    const stats = depthStats([hub, leaf, island]);
    expect(depthFor(hub, "degree", stats)).toBe(1);
    expect(depthFor(leaf, "degree", stats)).toBeGreaterThan(FLOOR);
    expect(depthFor(leaf, "degree", stats)).toBeLessThan(1);
    expect(depthFor(island, "degree", stats)).toBe(FLOOR);
  });
});

describe("layer channel", () => {
  it("puts entry points forward and leaf utilities back", () => {
    const entry = node("main.ts", { inDegree: 0, outDegree: 8 });
    const core = node("core.ts", { inDegree: 5, outDegree: 5 });
    const leaf = node("util.ts", { inDegree: 9, outDegree: 0 });
    const stats = depthStats([entry, core, leaf]);
    expect(depthFor(entry, "layer", stats)).toBe(1);
    expect(depthFor(core, "layer", stats)).toBeLessThan(depthFor(entry, "layer", stats));
    expect(depthFor(leaf, "layer", stats)).toBeLessThan(depthFor(core, "layer", stats));
    expect(depthFor(leaf, "layer", stats)).toBe(FLOOR);
  });

  it("holds low-degree files at neutral instead of flinging them to an extreme", () => {
    /* One import is not evidence of being an entry point. */
    const barely = node("one.ts", { inDegree: 0, outDegree: 1 });
    const stats = depthStats([barely, node("hub.ts", { inDegree: 10, outDegree: 10 })]);
    const depth = depthFor(barely, "layer", stats);
    expect(depth).toBeGreaterThan(FLOOR);
    expect(depth).toBeLessThan(1);
    expect(depth).toBe(depthFor(node("none.ts"), "layer", stats));
  });
});

describe("git channels", () => {
  it("recency puts the newest commit forward and the oldest back", () => {
    const old = node("old.ts", { lastCommitAt: 1_000 });
    const fresh = node("new.ts", { lastCommitAt: 9_000 });
    const stats = depthStats([old, fresh]);
    expect(depthFor(fresh, "recency", stats)).toBe(1);
    expect(depthFor(old, "recency", stats)).toBe(FLOOR);
  });

  it("recency holds untracked files at neutral — unknown is not far away", () => {
    const stats = depthStats([node("old.ts", { lastCommitAt: 1_000 }), node("new.ts", { lastCommitAt: 9_000 })]);
    const untracked = depthFor(node("fresh.ts"), "recency", stats);
    expect(untracked).toBeGreaterThan(FLOOR);
    expect(untracked).toBeLessThan(1);
  });

  it("recency stays neutral when every file shares one commit time", () => {
    const nodes = [node("a.ts", { lastCommitAt: 5_000 }), node("b.ts", { lastCommitAt: 5_000 })];
    const stats = depthStats(nodes);
    expect(depthFor(nodes[0]!, "recency", stats)).toBeGreaterThan(FLOOR);
  });

  it("churn puts hot files forward and untouched files at the floor", () => {
    const hot = node("hot.ts", { churn: 120 });
    const cold = node("cold.ts", { churn: 1 });
    const untouched = node("vendored.ts");
    const stats = depthStats([hot, cold, untouched]);
    expect(depthFor(hot, "churn", stats)).toBe(1);
    expect(depthFor(cold, "churn", stats)).toBeLessThan(1);
    expect(depthFor(untouched, "churn", stats)).toBe(FLOOR);
  });
});

describe("size channel", () => {
  it("puts large files forward", () => {
    const big = node("big.ts", { sizeBytes: 400_000 });
    const small = node("small.ts", { sizeBytes: 200 });
    const stats = depthStats([big, small]);
    expect(depthFor(big, "size", stats)).toBe(1);
    expect(depthFor(small, "size", stats)).toBeLessThan(depthFor(big, "size", stats));
  });
});

describe("applyDepthIntensity", () => {
  it("returns exactly 1 at intensity 0 — the flat-rendering guarantee", () => {
    for (const depth of [0, 0.15, 0.5, 0.9, 1]) {
      expect(applyDepthIntensity(depth, 0)).toBe(1);
    }
  });

  it("passes depth through untouched at intensity 1", () => {
    expect(applyDepthIntensity(0.4, 1)).toBeCloseTo(0.4, 10);
  });

  it("blends monotonically between the two", () => {
    const half = applyDepthIntensity(0.2, 0.5);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(1);
    expect(half).toBeCloseTo(0.6, 10);
  });

  it("clamps hostile input rather than propagating NaN into the renderer", () => {
    expect(applyDepthIntensity(Number.NaN, 1)).toBe(1);
    expect(applyDepthIntensity(0.5, Number.NaN)).toBeCloseTo(0.5, 10);
    expect(applyDepthIntensity(5, 1)).toBe(1);
    expect(applyDepthIntensity(0.5, 9)).toBeCloseTo(0.5, 10);
    expect(applyDepthIntensity(0.5, -3)).toBe(1);
  });
});

describe("depthMap", () => {
  it("is empty when depth is flat, so the renderer can skip the whole path", () => {
    expect(depthMap([node("a.ts"), node("b/c.ts")], "nesting", 0).size).toBe(0);
    expect(depthMap([], "nesting", 1).size).toBe(0);
  });

  it("covers every node exactly once", () => {
    const nodes = [node("a.ts"), node("b/c.ts"), node("b/d/e.ts")];
    const map = depthMap(nodes, "nesting", 1);
    expect(map.size).toBe(3);
    for (const n of nodes) expect(map.has(n.id)).toBe(true);
  });

  it("agrees with depthFor over the same node set", () => {
    const nodes = [node("a.ts"), node("b/c.ts", { inDegree: 4, outDegree: 1 })];
    const stats = depthStats(nodes);
    const map = depthMap(nodes, "degree", 1);
    for (const n of nodes) {
      expect(map.get(n.id)).toBeCloseTo(depthFor(n, "degree", stats), 10);
    }
  });
});

describe("isDepthChannel", () => {
  it("accepts every shipped channel and nothing else", () => {
    for (const channel of DEPTH_CHANNELS) expect(isDepthChannel(channel)).toBe(true);
    expect(isDepthChannel("elevation")).toBe(false);
    expect(isDepthChannel("")).toBe(false);
    expect(isDepthChannel(null)).toBe(false);
    expect(isDepthChannel(3)).toBe(false);
  });
});
