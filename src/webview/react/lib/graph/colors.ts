/* Deterministic colors for the Codebase Map. Pure — unit-testable, no DOM. */

import type { TraceKind } from "./protocol";

/** Trace tint per activity kind (0xRRGGBB for pixi, css string for overlays). */
export const TRACE_COLORS: Record<TraceKind, number> = {
  read: 0x4fc3f7, // cyan
  write: 0xffb74d, // amber
  edit: 0xba68c8, // violet
  shell: 0x81c784, // green
  nav: 0x9e9e9e, // dim white
};

export const ANNOTATION_COLOR = 0xffd54f; // bright gold, dashed
export const IMPORT_EDGE_COLOR = 0x5c6b8a; // dim steel blue
export const SYMBOL_NODE_COLOR = 0xb0bec5;
export const BACKGROUND_COLOR = 0x0b0e1a; // deep space

export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** FNV-1a string hash — stable across sessions for folder hues. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to255 = (v: number) => Math.round((v + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/** Star color for a folder cluster: stable pastel-bright hue per dir. */
export function folderColor(dir: string): number {
  const hue = hashString(dir) % 360;
  return hslToRgb(hue, 0.55, 0.68);
}

/** Blend two 0xRRGGBB colors; t=0 → a, t=1 → b. */
export function mixColors(a: number, b: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * clamped);
  const g = Math.round(ag + (bg - ag) * clamped);
  const bl = Math.round(ab + (bb - ab) * clamped);
  return (r << 16) | (g << 8) | bl;
}
