import { describe, expect, it } from "vitest";
import { approach, approachPoint, easeOutCubic, spawnOrigin } from "../../src/webview/react/lib/graph/motion.js";
import { clusterNodeId } from "../../src/webview/react/lib/graph/view-model.js";

describe("approach", () => {
  it("moves a fraction of the distance each step", () => {
    expect(approach(0, 10, 0.5, 0.01)).toBe(5);
    expect(approach(5, 10, 0.5, 0.01)).toBe(7.5);
  });

  it("snaps exactly onto the target within epsilon (no floating-point asymptote)", () => {
    expect(approach(9.99, 10, 0.5, 0.01)).toBe(10);
    expect(approach(10, 10, 0.5, 0.01)).toBe(10);
  });

  it("works in both directions", () => {
    expect(approach(10, 0, 0.25, 0.01)).toBe(7.5);
  });
});

describe("approachPoint", () => {
  it("glides toward the target and reports unsettled while far", () => {
    const { point, settled } = approachPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5, 0.1);
    expect(point).toEqual({ x: 5, y: 0 });
    expect(settled).toBe(false);
  });

  it("snaps and settles within epsilon", () => {
    const { point, settled } = approachPoint({ x: 9.95, y: 0 }, { x: 10, y: 0 }, 0.5, 0.1);
    expect(point).toEqual({ x: 10, y: 0 });
    expect(settled).toBe(true);
  });
});

describe("easeOutCubic", () => {
  it("is pinned at the ends, clamped, and front-loaded", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5); // decelerating curve
  });
});

describe("spawnOrigin", () => {
  const filePrev = (id: string, dir: string, x: number, y: number) =>
    [id, { x, y, dir, kind: undefined }] as const;

  it("a file expanding out of a collapsed cluster spawns at its old super-node", () => {
    const prev = new Map([
      [clusterNodeId("src"), { x: 40, y: -8, dir: "src", kind: "cluster" as const }],
    ]);
    expect(spawnOrigin({ id: "src/a.ts", dir: "src" }, prev)).toEqual({ x: 40, y: -8 });
  });

  it("a collapsing super-node spawns at its former members' centroid", () => {
    const prev = new Map([
      filePrev("src/a.ts", "src", 0, 0),
      filePrev("src/b.ts", "src", 10, 20),
      filePrev("test/x.ts", "test", 100, 100), // other cluster — excluded
    ]);
    expect(spawnOrigin({ id: clusterNodeId("src"), dir: "src", kind: "cluster" }, prev))
      .toEqual({ x: 5, y: 10 });
  });

  it("ignores a previous super-node when computing a collapsing centroid", () => {
    const prev = new Map<string, { x: number; y: number; dir: string; kind?: "file" | "cluster" }>([
      [clusterNodeId("src"), { x: 999, y: 999, dir: "src", kind: "cluster" }],
      filePrev("src/a.ts", "src", 2, 4),
    ]);
    expect(spawnOrigin({ id: clusterNodeId("src"), dir: "src", kind: "cluster" }, prev))
      .toEqual({ x: 2, y: 4 });
  });

  it("returns null with no prior context (fresh index, brand-new file)", () => {
    expect(spawnOrigin({ id: "src/a.ts", dir: "src" }, new Map())).toBeNull();
    expect(spawnOrigin({ id: clusterNodeId("docs"), dir: "docs", kind: "cluster" }, new Map())).toBeNull();
  });
});
