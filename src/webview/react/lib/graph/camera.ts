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

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
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
export function zoomAround(camera: Camera, viewport: Viewport, sx: number, sy: number, factor: number): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return camera;
  const anchor = screenToWorld(camera, viewport, sx, sy);
  const cx = anchor.x - (sx - viewport.width / 2) / zoom;
  const cy = anchor.y - (sy - viewport.height / 2) / zoom;
  return { cx, cy, zoom };
}

/** Camera framing all points with padding; identity view for empty input. */
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
  const zoom = clampZoom(Math.min(
    (viewport.width - paddingPx * 2) / spanX,
    (viewport.height - paddingPx * 2) / spanY,
  ));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom };
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
