/* Pure convex-hull math behind the Map's "territory zone" borders. */

import { describe, expect, it } from "vitest";
import { convexHull, paddedHull } from "../../src/webview/react/lib/graph/hull.js";

describe("convexHull", () => {
  it("wraps a square, dropping the interior point", () => {
    const hull = convexHull([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 5, y: 5 });
  });

  it("returns the input unchanged for fewer than 3 points", () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(convexHull(points)).toEqual(points);
    expect(convexHull([{ x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }]);
  });

  it("handles collinear points without throwing", () => {
    const hull = convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(hull.length).toBeGreaterThanOrEqual(0);
  });
});

describe("paddedHull", () => {
  it("expands every vertex outward from the hull centroid", () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const padded = paddedHull(square, 5);
    // Centroid is (5,5); each corner should now sit further from it than before.
    const distFromCentroid = (p: { x: number; y: number }) => Math.hypot(p.x - 5, p.y - 5);
    const originalDist = Math.hypot(5, 5);
    for (const p of padded) {
      expect(distFromCentroid(p)).toBeGreaterThan(originalDist);
    }
  });

  it("falls back to the (unpadded) hull when fewer than 3 points", () => {
    const points = [{ x: 0, y: 0 }, { x: 4, y: 0 }];
    expect(paddedHull(points, 10)).toEqual(points);
  });
});
