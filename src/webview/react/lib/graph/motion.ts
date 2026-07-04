/* Pure motion helpers for the Map's fluid transitions: exponential approach
   easing (position/scale/alpha springs) and spawn-origin resolution so stars
   bloom outward from their cluster's super-node instead of teleporting.
   No DOM, no pixi — vitest-safe. */

import type { GraphNode } from "./protocol";
import { clusterNodeId } from "./view-model";

export interface XY {
  x: number;
  y: number;
}

/** One step of exponential approach toward `target`. Snaps exactly onto the
    target once within `epsilon` so callers can detect settlement and stop
    animating (floating-point asymptotes never truly arrive). */
export function approach(current: number, target: number, factor: number, epsilon: number): number {
  const next = current + (target - current) * factor;
  return Math.abs(target - next) <= epsilon ? target : next;
}

/** 2D exponential approach; `settled` is true once within `epsilon` (euclidean). */
export function approachPoint(
  current: XY,
  target: XY,
  factor: number,
  epsilon: number,
): { point: XY; settled: boolean } {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  if (Math.hypot(dx, dy) <= epsilon) return { point: { x: target.x, y: target.y }, settled: true };
  return { point: { x: current.x + dx * factor, y: current.y + dy * factor }, settled: false };
}

/** Ease-out cubic, clamped to [0,1] — the "birth pop" curve for new stars. */
export function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** Where a node that just appeared should *fly in from*, given the previous
    display graph:

    - A file whose cluster was previously collapsed spawns at that cluster's
      super-node — expanding a folder blooms its files outward from the star
      they were folded into.
    - A super-node that just replaced its files spawns at their previous
      centroid (which is also its layout position, so collapse reads as the
      files gathering into one star).
    - Anything else (fresh index, brand-new file) returns null: no fly-in,
      just the alpha/scale birth.
*/
export function spawnOrigin(
  node: Pick<GraphNode, "id" | "dir" | "kind">,
  prevById: ReadonlyMap<string, Pick<GraphNode, "x" | "y" | "dir" | "kind">>,
): XY | null {
  if (node.kind === "cluster") {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (const prev of prevById.values()) {
      if (prev.dir === node.dir && prev.kind !== "cluster") {
        sx += prev.x;
        sy += prev.y;
        count += 1;
      }
    }
    return count > 0 ? { x: sx / count, y: sy / count } : null;
  }
  const superNode = prevById.get(clusterNodeId(node.dir));
  return superNode ? { x: superNode.x, y: superNode.y } : null;
}
