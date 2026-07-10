/** Screen-space label allocation for the Codebase Map. Canvas geometry can be
    perfectly separated while HTML labels still collide after projection; this
    small deterministic pass gives higher-value architecture labels first claim
    on the available screen and removes overlapping lower-value candidates. */

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenLabelCandidate<T> extends ScreenRect {
  value: T;
  priority: number;
}

function expanded(rect: ScreenRect, gap: number): ScreenRect {
  return {
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2,
  };
}

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function inside(rect: ScreenRect, bounds: { width: number; height: number }, margin: number): boolean {
  return rect.x >= margin
    && rect.y >= margin
    && rect.x + rect.width <= bounds.width - margin
    && rect.y + rect.height <= bounds.height - margin;
}

/** Pick a non-overlapping subset, highest priority first. Ties keep input
    order, so camera updates never make labels flicker because of an unstable
    sort. Returned labels are restored to input order for stable React output. */
export function selectNonOverlappingLabels<T>(
  candidates: readonly ScreenLabelCandidate<T>[],
  bounds: { width: number; height: number },
  reserved: readonly ScreenRect[] = [],
  gap = 6,
  margin = 4,
): ScreenLabelCandidate<T>[] {
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.priority - a.candidate.priority || a.index - b.index);
  const occupied = reserved.map((rect) => expanded(rect, gap));
  const accepted: Array<{ candidate: ScreenLabelCandidate<T>; index: number }> = [];

  for (const item of ranked) {
    const claim = expanded(item.candidate, gap);
    if (!inside(item.candidate, bounds, margin)) continue;
    if (occupied.some((rect) => overlaps(claim, rect))) continue;
    occupied.push(claim);
    accepted.push(item);
  }

  return accepted.sort((a, b) => a.index - b.index).map((item) => item.candidate);
}
