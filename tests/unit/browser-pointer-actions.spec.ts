/**
 * Pointer-path input.
 *
 * The runner has always been Playwright, which exposes `mouse.move(x, y, {steps})` — but the
 * action vocabulary stopped at selector-destination verbs (click, type), which cannot express a
 * *path*. That gap is what ruled out hover-driven UI, drag thresholds, canvas/WebGL orbit
 * controls and game input: all of them read the intermediate positions, and a teleport has none.
 */
import { describe, expect, it } from "vitest";
import { readWaypoints } from "../../src/chromium-runner.js";

describe("readWaypoints", () => {
  it("accepts object waypoints", () => {
    expect(readWaypoints([{ x: 10, y: 20 }, { x: 30, y: 40 }]))
      .toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });

  it("accepts [x, y] tuples, since that is how a path is usually written", () => {
    expect(readWaypoints([[1, 2], [3, 4]])).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  /** Coercing a malformed point to 0,0 would send the cursor to the viewport origin mid-path and
   *  silently corrupt the gesture; dropping it merely shortens the path. */
  it("drops malformed points instead of coercing them to the origin", () => {
    expect(readWaypoints([{ x: 1, y: 2 }, { x: "nope", y: 3 }, { y: 9 }, null, { x: 5, y: 6 }]))
      .toEqual([{ x: 1, y: 2 }, { x: 5, y: 6 }]);
  });

  it("keeps negative and fractional coordinates, which are legitimate", () => {
    expect(readWaypoints([{ x: -4, y: 0.5 }])).toEqual([{ x: -4, y: 0.5 }]);
  });

  it("bounds the path, because every leg costs a round trip to the browser", () => {
    const long = Array.from({ length: 500 }, (_, i) => ({ x: i, y: i }));
    expect(readWaypoints(long)).toHaveLength(64);
  });

  it("returns nothing for a non-array or empty input", () => {
    expect(readWaypoints(undefined)).toEqual([]);
    expect(readWaypoints("1,2")).toEqual([]);
    expect(readWaypoints([])).toEqual([]);
  });
});
