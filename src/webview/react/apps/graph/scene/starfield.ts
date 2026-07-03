/* Deterministic PRNG for the decorative background starfield — kept separate
   from lib/graph so the pure lib modules never depend on scene code. */

export function seededRandomForStarfield(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
