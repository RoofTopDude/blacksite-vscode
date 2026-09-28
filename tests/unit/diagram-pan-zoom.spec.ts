import { describe, expect, it } from "vitest";
import {
  MAX_FIT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  centerOn,
  clampPan,
  clampScale,
  fitTransform,
  isMouseWheel,
  visibleRegion,
  wheelPixels,
  wheelZoomFactor,
  zoomAround,
} from "../../src/webview/react/apps/diagram/pan-zoom.js";

const viewport = { width: 1000, height: 600 };

/** Where content point p lands on screen under transform t. */
function screen(t: { x: number; y: number; scale: number }, p: { x: number; y: number }): { x: number; y: number } {
  return { x: t.x + p.x * t.scale, y: t.y + p.y * t.scale };
}

describe("fitTransform", () => {
  it("scales a large diagram down to fit with padding, and centres it", () => {
    const t = fitTransform({ width: 2000, height: 600 }, viewport, 40);
    expect(t.scale).toBeCloseTo(920 / 2000);
    expect(t.x).toBeCloseTo((1000 - 2000 * t.scale) / 2);
    expect(t.y).toBeCloseTo((600 - 600 * t.scale) / 2);
  });

  it("does not blow a small diagram up past MAX_FIT_SCALE", () => {
    expect(fitTransform({ width: 100, height: 50 }, viewport).scale).toBe(MAX_FIT_SCALE);
  });

  it("returns the identity for an empty diagram or viewport rather than dividing by zero", () => {
    expect(fitTransform({ width: 0, height: 0 }, viewport)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(fitTransform({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("zoomAround", () => {
  it("keeps the content point under the anchor fixed", () => {
    const start = { x: 120, y: -40, scale: 0.8 };
    const anchor = { x: 430, y: 275 };
    const contentPoint = { x: (anchor.x - start.x) / start.scale, y: (anchor.y - start.y) / start.scale };
    const next = zoomAround(start, 2.4, anchor);
    expect(next.scale).toBe(2.4);
    expect(screen(next, contentPoint).x).toBeCloseTo(anchor.x);
    expect(screen(next, contentPoint).y).toBeCloseTo(anchor.y);
  });

  it("clamps the scale to the supported range", () => {
    expect(zoomAround({ x: 0, y: 0, scale: 1 }, 1000, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
    expect(zoomAround({ x: 0, y: 0, scale: 1 }, 0, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("clampPan", () => {
  const content = { width: 800, height: 400 };

  it("leaves a transform that keeps the diagram on screen alone", () => {
    const t = { x: 100, y: 50, scale: 1 };
    expect(clampPan(t, content, viewport)).toEqual(t);
  });

  it("stops the diagram being dragged entirely out of view on either side", () => {
    const right = clampPan({ x: 5000, y: 0, scale: 1 }, content, viewport);
    expect(right.x).toBeLessThan(viewport.width);
    const left = clampPan({ x: -5000, y: 0, scale: 1 }, content, viewport);
    expect(left.x + content.width).toBeGreaterThan(0);
    const down = clampPan({ x: 0, y: 9000, scale: 1 }, content, viewport);
    expect(down.y).toBeLessThan(viewport.height);
  });
});

describe("visibleRegion and centerOn", () => {
  it("report the visible part of the diagram in content coordinates", () => {
    expect(visibleRegion({ x: -200, y: -100, scale: 2 }, viewport)).toEqual({ x: 100, y: 50, width: 500, height: 300 });
  });

  it("centre a content point in the viewport at the current scale", () => {
    const t = centerOn({ x: 0, y: 0, scale: 1.5 }, { x: 300, y: 200 }, viewport);
    expect(screen(t, { x: 300, y: 200 })).toEqual({ x: 500, y: 300 });
    expect(t.scale).toBe(1.5);
  });
});

describe("wheel input", () => {
  it("tells a notched mouse wheel from a trackpad scroll", () => {
    expect(isMouseWheel({ deltaX: 0, deltaY: 100, deltaMode: 0 })).toBe(true);
    expect(isMouseWheel({ deltaX: 0, deltaY: -120, deltaMode: 0 })).toBe(true);
    expect(isMouseWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(true);
    expect(isMouseWheel({ deltaX: 0, deltaY: 4.5, deltaMode: 0 })).toBe(false);
    expect(isMouseWheel({ deltaX: 2, deltaY: 12, deltaMode: 0 })).toBe(false);
    expect(isMouseWheel({ deltaX: 0, deltaY: 8, deltaMode: 0 })).toBe(false);
  });

  it("normalises line and page deltas to pixels", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ x: 0, y: 48 });
    expect(wheelPixels({ deltaX: 1, deltaY: 0, deltaMode: 2 }, 600)).toEqual({ x: 600, y: 0 });
  });

  it("zooms symmetrically and never jumps more than a bounded factor per event", () => {
    expect(wheelZoomFactor(-100, 0.0022) * wheelZoomFactor(100, 0.0022)).toBeCloseTo(1);
    expect(wheelZoomFactor(-100, 0.0022)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100_000, 0.01)).toBeCloseTo(Math.exp(2.4));
  });
});
