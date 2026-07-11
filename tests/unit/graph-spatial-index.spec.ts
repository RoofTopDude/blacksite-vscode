import { describe, expect, it } from "vitest";
import { SpatialGrid } from "../../src/webview/react/lib/graph/spatial-index.js";

describe("SpatialGrid", () => {
  it("queries across positive and negative cell boundaries", () => {
    const grid = new SpatialGrid(100);
    grid.rebuild([
      { id: "negative", x: -101, y: -1 },
      { id: "origin", x: 0, y: 0 },
      { id: "edge", x: 100, y: 50 },
      { id: "far", x: 900, y: 900 },
    ]);
    expect([...grid.query({ x: -110, y: -10, width: 210, height: 70 })].sort())
      .toEqual(["edge", "negative", "origin"]);
  });

  it("uses padding as a world-space overscan margin", () => {
    const grid = new SpatialGrid(64);
    grid.rebuild([{ id: "near", x: 112, y: 20 }]);
    expect(grid.query({ x: 0, y: 0, width: 100, height: 100 }).has("near")).toBe(false);
    expect(grid.query({ x: 0, y: 0, width: 100, height: 100 }, 16).has("near")).toBe(true);
  });

  it("drops stale buckets on rebuild and ignores invalid points", () => {
    const grid = new SpatialGrid();
    grid.rebuild([{ id: "old", x: 0, y: 0 }]);
    grid.rebuild([{ id: "new", x: 10, y: 10 }, { id: "bad", x: Number.NaN, y: 0 }]);
    const ids = grid.query({ x: -20, y: -20, width: 60, height: 60 });
    expect([...ids]).toEqual(["new"]);
  });
});
