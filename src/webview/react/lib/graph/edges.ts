/* Pure geometry + timing for how the Codebase Map draws relationships. Kept
   out of the renderer so the curve/flow math is unit-testable and shared by
   both the pixi scene (which strokes the arcs) and the HTML overlay (which
   places edge labels on them). No DOM, no pixi. */

export interface Point {
  x: number;
  y: number;
}

/** Perpendicular bow of an import edge as a fraction of its length. Import
    edges render as gentle arcs rather than straight lines: on a dense hub the
    straight-line version collapses hundreds of edges onto the same handful of
    pixels (the "laser explosion" glare), whereas a consistent-handed bow fans
    them into legible strands and lets a mutual A→B / B→A pair separate into
    two arcs instead of one overlapping streak. Kept small so it reads as
    elegant flow, not spaghetti. */
export const EDGE_BOW = 0.13;

/** Quadratic control point for an edge's arc: the midpoint pushed out along
    the left-hand normal of A→B by `bow × length`. Consistent handedness makes
    a hub's arcs swirl the same way instead of scattering. Degenerate (zero
    length) edges fall back to the midpoint, i.e. a straight point. */
export function edgeControlPoint(a: Point, b: Point, bow = EDGE_BOW): Point {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: mx, y: my };
  /* Left-hand normal of the A→B direction, unit-scaled. */
  const nx = -dy / len;
  const ny = dx / len;
  const offset = bow * len;
  return { x: mx + nx * offset, y: my + ny * offset };
}

/** Point at parameter t∈[0,1] along the quadratic Bézier A→control→B. */
export function quadraticPointAt(a: Point, control: Point, b: Point, t: number): Point {
  const u = 1 - t;
  const w0 = u * u;
  const w1 = 2 * u * t;
  const w2 = t * t;
  return {
    x: w0 * a.x + w1 * control.x + w2 * b.x,
    y: w0 * a.y + w1 * control.y + w2 * b.y,
  };
}

/** Where an import edge's label should sit: the midpoint of its arc (t=0.5),
    not the straight chord midpoint, so the label rides the curve it annotates.
    Straight relationships (annotations, symbol relations) can keep using the
    chord midpoint — only import edges bow. */
export function edgeArcMidpoint(a: Point, b: Point, bow = EDGE_BOW): Point {
  return quadraticPointAt(a, edgeControlPoint(a, b, bow), b, 0.5);
}

/** Looping phase in [0,1) for marching-ants / flow animations, derived purely
    from wall-clock `now` so it's resumable after the view was hidden and
    testable without a fake timer. `periodMs` is one full cycle. */
export function flowPhase(now: number, periodMs: number): number {
  if (periodMs <= 0) return 0;
  const p = (now % periodMs) / periodMs;
  return p < 0 ? p + 1 : p;
}
