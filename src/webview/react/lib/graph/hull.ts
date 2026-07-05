/* Pure convex-hull math for the Map's "territory zone" borders — no DOM/pixi,
   same discipline as camera.ts/colors.ts so it's unit-testable in isolation. */

export interface HullPoint {
  x: number;
  y: number;
}

function cross(o: HullPoint, a: HullPoint, b: HullPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull via Andrew's monotone chain, returned counter-clockwise.
    Fewer than 3 distinct points can't form a hull — callers should fall back
    to a padded circle in that case (see drawTerritoryZones). */
export function convexHull(points: HullPoint[]): HullPoint[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;

  const lower: HullPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: HullPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  return hull.length >= 3 ? hull : pts;
}

/** The hull, expanded outward from its own centroid by `padding` world units
    so a drawn boundary sits outside the outermost members rather than
    clipping through them. */
export function paddedHull(points: HullPoint[], padding: number): HullPoint[] {
  const hull = convexHull(points);
  if (hull.length < 3) return hull;
  const cx = hull.reduce((sum, p) => sum + p.x, 0) / hull.length;
  const cy = hull.reduce((sum, p) => sum + p.y, 0) / hull.length;
  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * padding, y: p.y + (dy / len) * padding };
  });
}
