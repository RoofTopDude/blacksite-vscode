/* A fast, dependency-free fingerprint for cache keys: two independently seeded 53-bit cyrb53
   passes over the same input, streamed, giving 106 bits as 28 hex characters.

   It replaces node:crypto's sha256 in the Map's cache keys because those modules have to run
   anywhere, including a browser or worker runtime without Node built-ins. It is not
   cryptographic and does not need to be: it only has to tell two corpus states apart, and an
   accidental collision at 106 bits is not a practical concern. */

const SEEDS = [0x9e3779b9, 0x85ebca6b] as const;

export class Fingerprint {
  private readonly _h1: number[] = SEEDS.map((seed) => 0xdeadbeef ^ seed);
  private readonly _h2: number[] = SEEDS.map((seed) => 0x41c6ce57 ^ seed);

  update(text: string): this {
    for (let lane = 0; lane < SEEDS.length; lane += 1) {
      let h1 = this._h1[lane]!;
      let h2 = this._h2[lane]!;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      this._h1[lane] = h1;
      this._h2[lane] = h2;
    }
    return this;
  }

  /** Hex digest. Does not consume the state, so it may be read more than once. */
  digest(): string {
    let out = "";
    for (let lane = 0; lane < SEEDS.length; lane += 1) {
      let h1 = this._h1[lane]!;
      let h2 = this._h2[lane]!;
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
      h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
      h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      out += (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
    }
    return out;
  }
}

export function fingerprintOf(text: string): string {
  return new Fingerprint().update(text).digest();
}
