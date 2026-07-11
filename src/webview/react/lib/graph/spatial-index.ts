/** Small uniform-grid spatial index for renderer viewport culling. A uniform
    grid is a better fit than a quadtree here: layout positions are immutable
    between graph states, queries are axis-aligned, and construction/query are
    deterministic linear work with no extra runtime dependency. */

export interface SpatialPoint {
  id: string;
  x: number;
  y: number;
}

export interface SpatialRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class SpatialGrid {
  private readonly _cells = new Map<string, SpatialPoint[]>();

  constructor(readonly cellSize = 256) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("SpatialGrid cellSize must be positive.");
  }

  rebuild(points: readonly SpatialPoint[]): void {
    this._cells.clear();
    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const key = this._key(this._cell(point.x), this._cell(point.y));
      const bucket = this._cells.get(key);
      if (bucket) bucket.push(point);
      else this._cells.set(key, [point]);
    }
  }

  query(rect: SpatialRect, padding = 0): Set<string> {
    const out = new Set<string>();
    if (rect.width < 0 || rect.height < 0) return out;
    const pad = Number.isFinite(padding) ? Math.max(0, padding) : 0;
    const minX = rect.x - pad;
    const minY = rect.y - pad;
    const maxX = rect.x + rect.width + pad;
    const maxY = rect.y + rect.height + pad;
    const x0 = this._cell(minX);
    const y0 = this._cell(minY);
    const x1 = this._cell(maxX);
    const y1 = this._cell(maxY);
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        for (const point of this._cells.get(this._key(cx, cy)) ?? []) {
          if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) out.add(point.id);
        }
      }
    }
    return out;
  }

  private _cell(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private _key(x: number, y: number): string {
    return `${x}:${y}`;
  }
}
