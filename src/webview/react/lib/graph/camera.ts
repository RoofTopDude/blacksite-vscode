/* Pure 2D camera math for the Map: pan/zoom transforms shared by the pixi
   scene and the HTML label overlay so both layers stay pixel-aligned. */

export interface Camera {
  /** World coordinate at the viewport center. */
  cx: number;
  cy: number;
  /** Pixels per world unit. */
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** `minZoom` is dynamic in practice: the renderer passes a floor derived from
    the current layout's zoom-to-fit so a big map can always be seen whole —
    a fixed floor was the original "only 1-2 nodes ever visible" bug. */
export function clampZoom(zoom: number, minZoom = MIN_ZOOM): number {
  return Math.max(minZoom, Math.min(MAX_ZOOM, zoom));
}

export function worldToScreen(camera: Camera, viewport: Viewport, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.cx) * camera.zoom + viewport.width / 2,
    y: (y - camera.cy) * camera.zoom + viewport.height / 2,
  };
}

export function screenToWorld(camera: Camera, viewport: Viewport, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - viewport.width / 2) / camera.zoom + camera.cx,
    y: (sy - viewport.height / 2) / camera.zoom + camera.cy,
  };
}

export function pan(camera: Camera, dxPixels: number, dyPixels: number): Camera {
  return { ...camera, cx: camera.cx - dxPixels / camera.zoom, cy: camera.cy - dyPixels / camera.zoom };
}

/** Zoom by `factor` keeping the world point under (sx, sy) stationary. */
export function zoomAround(camera: Camera, viewport: Viewport, sx: number, sy: number, factor: number, minZoom = MIN_ZOOM): Camera {
  const zoom = clampZoom(camera.zoom * factor, minZoom);
  if (zoom === camera.zoom) return camera;
  const anchor = screenToWorld(camera, viewport, sx, sy);
  const cx = anchor.x - (sx - viewport.width / 2) / zoom;
  const cy = anchor.y - (sy - viewport.height / 2) / zoom;
  return { cx, cy, zoom };
}

/** Camera framing all points with padding; identity view for empty input.
    Deliberately NOT floored at MIN_ZOOM: fitting the whole map must always be
    possible no matter how large the layout is. Only MAX_ZOOM applies (a tiny
    graph shouldn't be blown up past 1:8). */
export function zoomToFit(points: ReadonlyArray<{ x: number; y: number }>, viewport: Viewport, paddingPx = 48): Camera {
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { cx: 0, cy: 0, zoom: 1 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const zoom = Math.min(MAX_ZOOM, Math.min(
    Math.max(1, viewport.width - paddingPx * 2) / spanX,
    Math.max(1, viewport.height - paddingPx * 2) / spanY,
  ));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom };
}

/** Sprite scale for a node so it never drops below `minPx` radius on screen —
    zoomed way out, files stay visible pinpoints (like real stars) instead of
    sub-pixel dust. `corePx` is the glow texture's bright-core radius. */
export function nodeSpriteScale(worldRadius: number, zoom: number, minPx: number, corePx = 8): number {
  const safeZoom = Math.max(zoom, 1e-6);
  const effectiveRadius = worldRadius * safeZoom >= minPx ? worldRadius : minPx / safeZoom;
  return effectiveRadius / corePx;
}

/** Opacity for the import-edge layer as a function of zoom relative to the
    zoom-to-fit level: fade toward a whisper at overview (a 4k-edge hairball
    is noise), richen as the user zooms into a neighborhood. */
export function edgeLayerAlpha(zoomRatio: number): number {
  if (!Number.isFinite(zoomRatio) || zoomRatio <= 0) return 0.55;
  const alpha = zoomRatio >= 1
    ? 0.62 + 0.24 * Math.min(2, zoomRatio - 1)
    : 0.42 + 0.2 * Math.max(0, zoomRatio);
  return Math.max(0.36, Math.min(0.9, alpha));
}

/** Smooth acceleration/deceleration curve for camera fly-to. t∈[0,1]. */
export function easeInOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** Interpolate two cameras. Position is linear; zoom is geometric (log space)
    so a fly-out-then-in reads at a constant perceptual rate rather than
    lurching. t is expected pre-eased. */
export function lerpCamera(from: Camera, to: Camera, t: number): Camera {
  const fromZoom = Math.max(from.zoom, 1e-6);
  const toZoom = Math.max(to.zoom, 1e-6);
  return {
    cx: from.cx + (to.cx - from.cx) * t,
    cy: from.cy + (to.cy - from.cy) * t,
    zoom: Math.exp(Math.log(fromZoom) + (Math.log(toZoom) - Math.log(fromZoom)) * t),
  };
}

/** Camera that centers `point` at a comfortable neighborhood zoom. Keeps the
    user's current zoom if they're already zoomed in past `desiredZoom`, so
    focusing from a detail view doesn't yank them back out. */
export function frameNode(
  point: { x: number; y: number },
  currentZoom: number,
  desiredZoom: number,
  minZoom = MIN_ZOOM,
): Camera {
  return { cx: point.x, cy: point.y, zoom: clampZoom(Math.max(currentZoom, desiredZoom), minZoom) };
}

/** Desired zoom when flying to a searched/selected node: enough to pick a
    star out of its cluster on a huge map, but capped so a small project
    doesn't get slammed to max zoom on every search pick. Feeds `frameNode`'s
    `desiredZoom` (which itself never zooms a closer view back out). */
export function focusZoomFor(fitZoom: number): number {
  return Math.min(3, Math.max(1, fitZoom * 4));
}

/** True when two cameras are within `epsilon` (position in world units, zoom
    as a ratio) — used to end a fly-to animation cleanly. */
export function camerasClose(a: Camera, b: Camera, epsilon = 0.5): boolean {
  const zoomRatio = Math.max(a.zoom, b.zoom) / Math.max(1e-6, Math.min(a.zoom, b.zoom));
  return Math.abs(a.cx - b.cx) < epsilon && Math.abs(a.cy - b.cy) < epsilon && zoomRatio < 1.01;
}

/** World-space rectangle currently visible, for drawing a minimap viewport
    indicator. */
export function visibleWorldRect(camera: Camera, viewport: Viewport): { x: number; y: number; width: number; height: number } {
  const width = viewport.width / camera.zoom;
  const height = viewport.height / camera.zoom;
  return { x: camera.cx - width / 2, y: camera.cy - height / 2, width, height };
}

/** True if a world-space rect overlaps an axis-aligned bounds box at all.
    Used to detect a stale camera that doesn't correspond to the current node
    set — e.g. one restored from a previous session/workspace (webview
    localStorage isn't scoped per-workspace) — so the map can self-heal
    instead of leaving the user staring at empty space with no clue why. */
export function rectOverlapsBounds(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return rect.x < bounds.maxX && rect.x + rect.width > bounds.minX
    && rect.y < bounds.maxY && rect.y + rect.height > bounds.minY;
}

/** Clip a rectangle (already projected into some box's own pixel space, e.g.
    the minimap) to that box's bounds. Used for the minimap's "you are here"
    indicator: clamping only the top-left corner while leaving width/height
    untouched overstates what's visible once the camera pans or zooms out
    past the indexed content (dragging has no hard stop). */
export function clampRectToBox(
  rect: { x: number; y: number; width: number; height: number },
  box: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(box.width, rect.x + rect.width);
  const y1 = Math.min(box.height, rect.y + rect.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Parallax multiplier for a node's depth cue z∈[0,1]: far stars drift slower. */
export function parallaxFactor(z: number): number {
  return 0.85 + 0.15 * Math.max(0, Math.min(1, z));
}

/** Screen position with parallax applied around the camera center. */
export function worldToScreenParallax(camera: Camera, viewport: Viewport, x: number, y: number, z: number): { x: number; y: number } {
  const factor = parallaxFactor(z);
  return {
    x: (x - camera.cx * factor) * camera.zoom + viewport.width / 2,
    y: (y - camera.cy * factor) * camera.zoom + viewport.height / 2,
  };
}
