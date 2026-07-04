/* Pure geometry + timing behind the Map's relationship rendering: arced import
   edges, the label/pulse points that ride those arcs, and the looping flow
   phase that drives the activity shimmer. */

import { describe, expect, it } from "vitest";
import {
  EDGE_BOW,
  edgeArcMidpoint,
  edgeControlPoint,
  flowPhase,
  quadraticPointAt,
} from "../../src/webview/react/lib/graph/edges.js";

describe("edgeControlPoint", () => {
  it("bows the midpoint out along the left-hand normal by bow × length", () => {
    // A→B pointing +x, length 20. Left-hand normal is +y, so the control point
    // sits above the chord midpoint by EDGE_BOW * 20.
    const c = edgeControlPoint({ x: 0, y: 0 }, { x: 20, y: 0 });
    expect(c.x).toBeCloseTo(10);
    expect(c.y).toBeCloseTo(EDGE_BOW * 20);
  });

  it("bows consistently-handed: reversing the endpoints flips the bow to the other side", () => {
    const forward = edgeControlPoint({ x: 0, y: 0 }, { x: 20, y: 0 });
    const reverse = edgeControlPoint({ x: 20, y: 0 }, { x: 0, y: 0 });
    // Same chord midpoint, opposite normal — a mutual A→B / B→A pair separates
    // into two distinct arcs instead of overlapping.
    expect(reverse.x).toBeCloseTo(10);
    expect(reverse.y).toBeCloseTo(-forward.y);
  });

  it("degenerate zero-length edge collapses to the point (no NaN from the normal)", () => {
    const c = edgeControlPoint({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(c).toEqual({ x: 5, y: 5 });
  });

  it("bow scales with length so long and short edges arc proportionally", () => {
    const short = edgeControlPoint({ x: 0, y: 0 }, { x: 10, y: 0 });
    const long = edgeControlPoint({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(long.y / short.y).toBeCloseTo(10);
  });
});

describe("quadraticPointAt", () => {
  const a = { x: 0, y: 0 };
  const control = { x: 10, y: 10 };
  const b = { x: 20, y: 0 };

  it("pins the endpoints at t=0 and t=1", () => {
    expect(quadraticPointAt(a, control, b, 0)).toEqual(a);
    expect(quadraticPointAt(a, control, b, 1)).toEqual(b);
  });

  it("at t=0.5 equals the standard quarter/half/quarter weighting", () => {
    const mid = quadraticPointAt(a, control, b, 0.5);
    expect(mid.x).toBeCloseTo(0.25 * a.x + 0.5 * control.x + 0.25 * b.x);
    expect(mid.y).toBeCloseTo(0.25 * a.y + 0.5 * control.y + 0.25 * b.y);
  });

  it("stays on the correct side (curve bulges toward the control point)", () => {
    const mid = quadraticPointAt(a, control, b, 0.5);
    expect(mid.y).toBeGreaterThan(0); // pulled up toward control.y=10, but not all the way
    expect(mid.y).toBeLessThan(control.y);
  });
});

describe("edgeArcMidpoint", () => {
  it("keeps x at the chord midpoint but lifts y onto the arc", () => {
    const mid = edgeArcMidpoint({ x: 0, y: 0 }, { x: 20, y: 0 });
    expect(mid.x).toBeCloseTo(10);
    expect(mid.y).toBeGreaterThan(0);
    // Lies on the arc: equals sampling the control curve at t=0.5.
    const viaSample = quadraticPointAt(
      { x: 0, y: 0 },
      edgeControlPoint({ x: 0, y: 0 }, { x: 20, y: 0 }),
      { x: 20, y: 0 },
      0.5,
    );
    expect(mid.y).toBeCloseTo(viaSample.y);
  });
});

describe("flowPhase", () => {
  it("advances linearly from 0 toward 1 within a period", () => {
    expect(flowPhase(0, 1000)).toBeCloseTo(0);
    expect(flowPhase(250, 1000)).toBeCloseTo(0.25);
    expect(flowPhase(999, 1000)).toBeCloseTo(0.999);
  });

  it("wraps seamlessly at the period boundary (loops)", () => {
    expect(flowPhase(1000, 1000)).toBeCloseTo(0);
    expect(flowPhase(1250, 1000)).toBeCloseTo(0.25);
  });

  it("stays in [0,1) and never NaNs on a zero/negative period", () => {
    expect(flowPhase(500, 0)).toBe(0);
    for (const now of [0, 1, 500, 1600, 123456]) {
      const p = flowPhase(now, 1600);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});
