/* Canvas navigation for the Codebase Map: pan, zoom, fit, fly-to, and the
   camera/minimap self-healing added alongside them. Complements the general
   camera-math coverage in graph-view-model.spec.ts by focusing specifically
   on the navigation *behaviors* (drag-follows-cursor, stale-camera recovery,
   minimap indicator honesty) rather than the raw transform functions. */

import { describe, expect, it } from "vitest";
import {
  clampRectToBox,
  focusZoomFor,
  frameNode,
  MIN_ZOOM,
  pan,
  rectOverlapsBounds,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAround,
  zoomToFit,
  type Camera,
} from "../../src/webview/react/lib/graph/camera.js";
import { nodeBounds } from "../../src/webview/react/lib/graph/view-model.js";

const vp = { width: 800, height: 600 };

describe("drag-to-pan", () => {
  it("the world point under the cursor follows the cursor 1:1 during a drag", () => {
    // This is the actual user-facing contract of "drag to pan": whatever was
    // under the pointer stays under the pointer as the pointer moves.
    const camera: Camera = { cx: 0, cy: 0, zoom: 1.6 };
    const grabPoint = { sx: 300, sy: 250 };
    const worldUnderCursor = screenToWorld(camera, vp, grabPoint.sx, grabPoint.sy);

    const dx = 42;
    const dy = -17;
    const dragged = pan(camera, dx, dy);
    const worldNowUnderNewCursorPos = screenToWorld(dragged, vp, grabPoint.sx + dx, grabPoint.sy + dy);

    expect(worldNowUnderNewCursorPos.x).toBeCloseTo(worldUnderCursor.x);
    expect(worldNowUnderNewCursorPos.y).toBeCloseTo(worldUnderCursor.y);
  });

  it("keyboard pan composes: two small steps equal one big step", () => {
    const camera: Camera = { cx: 0, cy: 0, zoom: 2 };
    const twoSteps = pan(pan(camera, 70, 0), 70, 0);
    const oneStep = pan(camera, 140, 0);
    expect(twoSteps.cx).toBeCloseTo(oneStep.cx);
  });

  it("ArrowLeft/A and ArrowRight/D pan opposite directions by the same magnitude", () => {
    const camera: Camera = { cx: 0, cy: 0, zoom: 1 };
    const left = pan(camera, 70, 0); // GraphApp.tsx: panBy(70, 0) on ArrowLeft/A
    const right = pan(camera, -70, 0); // panBy(-70, 0) on ArrowRight/D
    expect(left.cx).toBeCloseTo(-right.cx);
    expect(left.cx).not.toBe(camera.cx);
  });

  it("Shift steps are a bigger magnitude than plain steps, same direction", () => {
    const camera: Camera = { cx: 0, cy: 0, zoom: 1 };
    const plain = pan(camera, 70, 0);
    const shifted = pan(camera, 200, 0);
    expect(Math.abs(shifted.cx - camera.cx)).toBeGreaterThan(Math.abs(plain.cx - camera.cx));
    expect(Math.sign(shifted.cx - camera.cx)).toBe(Math.sign(plain.cx - camera.cx));
  });
});

describe("wheel / keyboard zoom", () => {
  it("zooming in then back out by the inverse factor returns to the start", () => {
    const camera: Camera = { cx: 10, cy: -5, zoom: 1 };
    const zoomedIn = zoomAround(camera, vp, 400, 300, 1.25);
    const back = zoomAround(zoomedIn, vp, 400, 300, 1 / 1.25);
    expect(back.zoom).toBeCloseTo(camera.zoom);
    expect(back.cx).toBeCloseTo(camera.cx);
    expect(back.cy).toBeCloseTo(camera.cy);
  });

  it("keyboard zoom (+/-) about the viewport center leaves the center point fixed", () => {
    const camera: Camera = { cx: 5, cy: 5, zoom: 1 };
    const centerBefore = screenToWorld(camera, vp, vp.width / 2, vp.height / 2);
    const zoomed = zoomAround(camera, vp, vp.width / 2, vp.height / 2, 1.25);
    const centerAfter = screenToWorld(zoomed, vp, vp.width / 2, vp.height / 2);
    expect(centerAfter.x).toBeCloseTo(centerBefore.x);
    expect(centerAfter.y).toBeCloseTo(centerBefore.y);
    // GraphApp.tsx: "+"/"=" -> zoomBy(1.25); confirm it actually zooms in.
    expect(zoomed.zoom).toBeCloseTo(1.25);
  });

  it("never zooms past the dynamic floor even from a big wheel fling", () => {
    const camera: Camera = { cx: 0, cy: 0, zoom: 0.1 };
    const flungOut = zoomAround(camera, vp, 400, 300, 1e-6, 0.02);
    expect(flungOut.zoom).toBe(0.02);
  });
});

describe("fit-to-content ('F' / Fit button)", () => {
  it("frames a scattered cluster set so every point stays on screen", () => {
    const points = [
      { x: -400, y: -50 }, { x: 400, y: 50 }, { x: 0, y: 300 }, { x: -100, y: -300 },
    ];
    const camera = zoomToFit(points, vp);
    for (const p of points) {
      const s = worldToScreen(camera, vp, p.x, p.y);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(vp.width);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(vp.height);
    }
  });

  it("a single node still produces a sane, non-degenerate camera", () => {
    const camera = zoomToFit([{ x: 12, y: -8 }], vp);
    expect(camera.cx).toBe(12);
    expect(camera.cy).toBe(-8);
    expect(Number.isFinite(camera.zoom)).toBe(true);
    expect(camera.zoom).toBeGreaterThan(0);
  });
});

describe("search-pick fly-to (focusNode)", () => {
  it("focusZoomFor stays within [1,3] regardless of how extreme the fit zoom is", () => {
    expect(focusZoomFor(0.001)).toBe(1); // huge sprawling repo: floor at 1, don't stay microscopic
    expect(focusZoomFor(100)).toBe(3); // tiny tight repo: cap at 3, don't slam to max
    expect(focusZoomFor(0.5)).toBeCloseTo(2); // mid-range: 4x the overview level
  });

  it("frameNode never yanks a user who is already zoomed in past the focus level back out", () => {
    const alreadyClose = frameNode({ x: 1, y: 1 }, /* currentZoom */ 6, focusZoomFor(0.5), MIN_ZOOM);
    expect(alreadyClose.zoom).toBe(6);
  });

  it("frameNode zooms in from a wide overview to the focus level", () => {
    const fromOverview = frameNode({ x: 1, y: 1 }, /* currentZoom */ 0.05, focusZoomFor(0.05), MIN_ZOOM);
    expect(fromOverview.zoom).toBeCloseTo(focusZoomFor(0.05));
  });
});

describe("stale/restored camera detection (cross-workspace + re-index self-heal)", () => {
  // Regression: store.ts persists camera position to webview localStorage,
  // which is scoped by extension+viewType, NOT by workspace. Opening a
  // different project (or a big re-index reshaping the layout) can hand the
  // renderer a camera tuned for a totally different coordinate system. The
  // renderer treats "camera doesn't overlap the node cloud" as stale and
  // re-fits instead of leaving the user at an empty starfield forever.
  const nodes = [{ x: 0, y: 0 }, { x: 100, y: 100 }];

  it("flags a camera parked far outside the node cloud as not seeing it", () => {
    const farAwayCamera: Camera = { cx: 50_000, cy: 50_000, zoom: 1 };
    const rect = visibleWorldRect(farAwayCamera, vp);
    expect(rectOverlapsBounds(rect, nodeBounds(nodes))).toBe(false);
  });

  it("accepts a camera that frames the node cloud, even off-center", () => {
    const reasonableCamera: Camera = { cx: 40, cy: 40, zoom: 1 };
    const rect = visibleWorldRect(reasonableCamera, vp);
    expect(rectOverlapsBounds(rect, nodeBounds(nodes))).toBe(true);
  });

  it("rects that only touch at an edge (zero-width intersection) do not count as overlapping", () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const justTouching = { x: 10, y: 0, width: 5, height: 5 }; // starts exactly at bounds.maxX
    expect(rectOverlapsBounds(justTouching, bounds)).toBe(false);
    const barelyOverlapping = { x: 9.999, y: 0, width: 5, height: 5 };
    expect(rectOverlapsBounds(barelyOverlapping, bounds)).toBe(true);
  });

  it("treats an empty node set as always 'seen' (nothing to be stale relative to)", () => {
    expect(rectOverlapsBounds(visibleWorldRect({ cx: 0, cy: 0, zoom: 1 }, vp), nodeBounds([]))).toBe(true);
  });
});

describe("minimap 'you are here' indicator (clampRectToBox)", () => {
  const box = { width: 150, height: 106 };

  it("leaves a fully-contained rect untouched", () => {
    const rect = { x: 10, y: 10, width: 50, height: 40 };
    expect(clampRectToBox(rect, box)).toEqual(rect);
  });

  it("shrinks (not just shifts) a rect that overhangs the top-left edge", () => {
    // Regression: the old code did Math.max(0, x) but kept the full width,
    // which shifted the rect right instead of trimming it — overstating what
    // was visible once the camera panned past the map's bounds.
    const clipped = clampRectToBox({ x: -20, y: -10, width: 50, height: 40 }, box);
    expect(clipped.x).toBe(0);
    expect(clipped.y).toBe(0);
    expect(clipped.width).toBe(30); // 50 - 20, not the full 50
    expect(clipped.height).toBe(30); // 40 - 10
  });

  it("shrinks a rect that overhangs the bottom-right edge", () => {
    const clipped = clampRectToBox({ x: 120, y: 90, width: 60, height: 60 }, box);
    expect(clipped.width).toBe(30); // 150 - 120
    expect(clipped.height).toBe(16); // 106 - 90
  });

  it("collapses to zero size (not negative) when fully outside the box", () => {
    const clipped = clampRectToBox({ x: 500, y: 500, width: 20, height: 20 }, box);
    expect(clipped.width).toBe(0);
    expect(clipped.height).toBe(0);
  });

  it("fills the whole box when the camera is zoomed out past the entire map", () => {
    const clipped = clampRectToBox({ x: -50, y: -50, width: 300, height: 300 }, box);
    expect(clipped).toEqual({ x: 0, y: 0, width: box.width, height: box.height });
  });
});
