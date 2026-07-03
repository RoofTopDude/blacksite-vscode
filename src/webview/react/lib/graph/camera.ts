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
  if (!Number.isFinite(zoomRatio) || zoomRatio <= 0) return 0.3;
  const alpha = zoomRatio >= 1
    ? 0.32 + 0.28 * Math.min(2, zoomRatio - 1)
    : 0.32 * Math.max(0.35, zoomRatio);
  return Math.max(0.1, Math.min(0.9, alpha));
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
