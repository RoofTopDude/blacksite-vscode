/* Deterministic colors for the Codebase Map. Pure — unit-testable, no DOM. */

import type { TraceKind } from "./protocol";
import type { EdgeKind, SymbolRelation } from "./protocol";

/** Trace tint per activity kind (0xRRGGBB for pixi, css string for overlays). */
export const TRACE_COLORS: Record<TraceKind, number> = {
  read: 0x4fc3f7, // cyan
  write: 0xffb74d, // amber
  edit: 0xba68c8, // violet
  shell: 0x81c784, // green
  nav: 0x9e9e9e, // dim white
};

/** Stable subagent lane colors shared by chat and the Map. The parent agent
    keeps kind-based trace colors; delegated lanes get identity colors so
    concurrent work remains distinguishable even when every lane is editing. */
export const AGENT_LANE_COLORS = [
  0x5eead4, // teal
  0xfacc15, // gold
  0xa78bfa, // violet
  0x93c5fd, // blue
  0xfb7185, // rose
  0x86efac, // green
  0xfdba74, // orange
  0xc084fc, // purple
];

export function agentLaneColor(laneId: string | null | undefined): number | null {
  if (!laneId) return null;
  return AGENT_LANE_COLORS[hashString(laneId) % AGENT_LANE_COLORS.length] ?? AGENT_LANE_COLORS[0] ?? null;
}

export function activityColor(kind: TraceKind, laneId?: string | null): number {
  return agentLaneColor(laneId) ?? TRACE_COLORS[kind];
}

export const ANNOTATION_COLOR = 0xffd66b; // bright gold, dashed
export const IMPORT_EDGE_COLOR = 0x8fa9d6; // readable steel blue
export const RELATIONSHIP_EDGE_COLORS: Partial<Record<EdgeKind, number>> = {
  api: 0x5eead4,
  event: 0xfacc15,
  data: 0xa78bfa,
  config: 0x93c5fd,
};
export const SYMBOL_NODE_COLOR = 0xc6e6ee;
/** Symbol-relation edge colors (LSP layer): references, call hierarchy, and
    inheritance each read as a distinct strand. */
export const SYMBOL_RELATION_COLORS: Record<SymbolRelation, number> = {
  reference: 0xc6e6ee, // pale cyan — "used by"
  call: 0xffb74d,      // amber — call flow
  implements: 0x81c784, // green — implements
  extends: 0xba68c8,   // violet — inheritance
};
export const BACKGROUND_COLOR = 0x080b14; // deep space
/** Git heat: recently-changed files glow toward this warm ember. */
export const GIT_WARM_COLOR = 0xff7a3c;
/** Cross-project reference cycle: a warning, not a normal relationship — a
    distinct warm red so it reads as "look at this" against every other edge
    color in the map. */
export const CYCLE_WARNING_COLOR = 0xe0645a;
/** The single bridge edge into a cul-de-sac "pocket" subgraph — a distinct
    amber, calling out "the one way in" without competing with the git-heat
    warm/cool scale or the cycle-warning red. */
export const BRIDGE_EDGE_COLOR = 0xd9a441;

/** Log-scaled churn in [0,1] relative to the busiest file in view. */
export function churnFraction(churn: number | undefined, maxChurn: number): number {
  if (!churn || maxChurn <= 0) return 0;
  return Math.min(1, Math.log1p(churn) / Math.log1p(maxChurn));
}

/** Recency in [0,1] spread across the [oldest, newest] commit range currently
    in view: the most recently touched file → 1, the least recent → 0, a file
    with no git history → 0. A relative spread (not wall-clock) keeps contrast
    meaningful whether the repo was last touched an hour or a year ago. */
export function recencyFraction(lastCommitAt: number | undefined, oldest: number, newest: number): number {
  if (!lastCommitAt) return 0;
  if (newest <= oldest) return 1;
  return Math.max(0, Math.min(1, (lastCommitAt - oldest) / (newest - oldest)));
}

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

/** Hue band excised entirely: yellow-green/olive reads muddy/sickly at this
    saturation and lightness no matter which folder lands there, unlike every
    other hue. The hash space is compressed by the gap's width first, then any
    value at or past the gap start is pushed past it — so the full "good" 340°
    of hue is still used deterministically, with no dead zone and no folder
    ever double-mapping to another's hue. */
const MUDDY_HUE_GAP_START = 55;
const MUDDY_HUE_GAP_WIDTH = 20;

/** Star color for a folder cluster: stable, curated-hue jewel tone per dir.
    Saturation/lightness tuned for a vivid jewel tone rather than a washed-out
    pastel — lightness nudged down as saturation goes up so the *perceived*
    brightness (and additive-blend headroom) stays roughly where it was; see
    makeGlowTexture's own comment for why overall brightness here is handled
    carefully (a previous, wider glow halo blew out into a white glare once
    already). */
export function folderColor(dir: string): number {
  const raw = hashString(dir) % (360 - MUDDY_HUE_GAP_WIDTH);
  const hue = raw < MUDDY_HUE_GAP_START ? raw : raw + MUDDY_HUE_GAP_WIDTH;
  return hslToRgb(hue, 0.62, 0.63);
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

/** Coarse file-kind buckets for the Map's per-star kind badge — deliberately
    coarse (a handful of hues, not one per language) since the badge itself is
    only a few pixels. */
export type LangBucket = "code" | "markup" | "style" | "data" | "docs" | "other";

const LANG_BUCKET_BY_EXT: Record<string, LangBucket> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", go: "code", rs: "code", java: "code", kt: "code", swift: "code",
  cs: "code", c: "code", cpp: "code", cc: "code", cxx: "code", h: "code", hpp: "code", hxx: "code", hh: "code",
  rb: "code", php: "code", scala: "code", sh: "code", bash: "code", ps1: "code",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", cshtml: "markup", razor: "markup",
  css: "style", scss: "style", less: "style", sass: "style",
  json: "data", jsonc: "data", webmanifest: "data", yaml: "data", yml: "data", toml: "data", ini: "data", env: "data", csv: "data",
  md: "docs", mdx: "docs", txt: "docs", rst: "docs",
};

export const LANG_BUCKET_COLORS: Record<LangBucket, number> = {
  code: 0x8fa9d6,  // steel blue — matches import edges, "this is logic"
  markup: 0xffb74d, // amber
  style: 0xba68c8, // violet
  data: 0x81c784,  // green
  docs: 0x9e9e9e,  // dim white
  other: 0x5a6b8c,
};

export function langBucket(lang: string): LangBucket {
  return LANG_BUCKET_BY_EXT[lang.toLowerCase()] ?? "other";
}

export function langBucketColor(lang: string): number {
  return LANG_BUCKET_COLORS[langBucket(lang)];
}
