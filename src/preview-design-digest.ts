/**
 * Extracts a usable inventory of a project's design system from its compiled stylesheet.
 *
 * Bridging the real stylesheet into previews (src/preview-assets.ts) is only half the fix. A
 * preview can only be drawn with `.chat-surface` and `var(--muted-foreground)` if the agent knows
 * those exist, and it cannot: the sheet is 240 KB of compiled output, far too large to read into
 * context and mostly Tailwind utilities that carry no information. Guessing class names produces
 * markup that silently renders unstyled, which looks exactly like the from-scratch sketches this
 * whole change is meant to eliminate — so the agent hedges back to hand-written CSS.
 *
 * This module answers "what may I use" cheaply: tokens with their resolved values, component
 * classes grouped by their naming prefix, and the utility families present. Parsing is deliberately
 * regex-based rather than a real CSS parse. The input is machine-generated, the output is a
 * discovery aid rather than a semantic model, and being approximate on an exotic selector costs
 * nothing — whereas taking a CSS parser dependency to serve one advisory tool would.
 */

export interface DesignTokenGroup {
  /** Shared leading segment, e.g. "color", "font", "radius", or "" for ungrouped. */
  group: string;
  tokens: { name: string; value: string }[];
}

export interface ComponentClassGroup {
  /** Leading dash-delimited segment shared by the members, e.g. "board", "chat", "map". */
  prefix: string;
  classes: string[];
  /** How many classes the group actually has, so a sampled group announces what it withheld
   *  instead of reading as complete. */
  total: number;
}

export interface DesignDigest {
  origin: string;
  /** Custom properties declared by the sheet, grouped by their first segment. */
  tokens: DesignTokenGroup[];
  /** Multi-part, semantically-named classes — the project's own components. */
  components: ComponentClassGroup[];
  /** Single-segment classes that look like utilities, summarised by family rather than listed. */
  utilityFamilies: string[];
  /** Font stacks the sheet defines, so a preview inherits the product's typography. */
  fontStacks: string[];
  totals: { tokens: number; components: number; utilities: number; bytes: number };
  truncated: boolean;
}

/** Custom property declarations: `--name: value;` */
const TOKEN_RE = /--([a-zA-Z0-9][\w-]*)\s*:\s*([^;{}]+)[;}]/g;
/** Class selectors. Escaped Tailwind selectors (`.px-2\.5`, `.w-\[3px\]`) are filtered later. */
const CLASS_RE = /\.(-?[a-zA-Z_][\w-]*)/g;

/**
 * Tailwind's utility vocabulary is open-ended, so utilities are recognised by shape rather than by
 * a list: a single dash-delimited segment (`flex`, `hidden`) or a known family prefix followed by a
 * scale value (`px-2`, `text-sm`). Anything else is treated as a project component class, which is
 * the direction the agent benefits from erring in — a stray utility in the component list is noise,
 * a missing component is a preview that renders unstyled.
 */
const UTILITY_FAMILIES = new Set([
  "p", "px", "py", "pt", "pr", "pb", "pl", "m", "mx", "my", "mt", "mr", "mb", "ml",
  "w", "h", "min", "max", "size", "gap", "space", "inset", "top", "right", "bottom", "left",
  "text", "font", "leading", "tracking", "align", "whitespace", "break", "truncate",
  "bg", "border", "rounded", "ring", "outline", "shadow", "opacity", "fill", "stroke",
  "flex", "grid", "col", "row", "order", "items", "justify", "self", "place", "content",
  "overflow", "z", "absolute", "relative", "fixed", "sticky", "block", "inline", "hidden",
  "transition", "duration", "ease", "delay", "animate", "transform", "translate", "scale",
  "rotate", "cursor", "select", "pointer", "resize", "backdrop", "blur", "sr", "not",
]);

const BARE_UTILITIES = new Set([
  "flex", "grid", "block", "inline", "hidden", "absolute", "relative", "fixed", "sticky",
  "truncate", "italic", "underline", "uppercase", "lowercase", "capitalize", "container",
  "static", "visible", "invisible", "isolate", "contents",
]);

function isUtility(cls: string): boolean {
  if (BARE_UTILITIES.has(cls)) return true;
  const [head, ...rest] = cls.split("-");
  if (!head || rest.length === 0) return false;
  if (!UTILITY_FAMILIES.has(head)) return false;
  // `text-muted-foreground` is a utility bound to a token; `board-card-title` is a component.
  // Utilities bottom out in a scale value or a single token word, components keep nesting.
  return rest.length <= 2;
}

/** Longest shared leading segment, used to group both tokens and component classes. */
function firstSegment(name: string): string {
  const at = name.indexOf("-");
  return at > 0 ? name.slice(0, at) : "";
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item); else out.set(k, [item]);
  }
  return out;
}

export interface DigestLimits {
  /** Component classes returned per prefix group. */
  maxPerGroup: number;
  /** Total component classes across all groups. */
  maxComponents: number;
  /** Tokens returned. */
  maxTokens: number;
}

export const DEFAULT_DIGEST_LIMITS: DigestLimits = {
  maxPerGroup: 40,
  maxComponents: 400,
  maxTokens: 200,
};

/**
 * Build the digest. `css` is the resolved project stylesheet; `origin` is carried through from
 * {@link import("./preview-assets.js").resolvePreviewProjectCss} so the agent can tell whose
 * design system it is being shown.
 */
export function buildDesignDigest(
  css: string,
  origin: string,
  limits: DigestLimits = DEFAULT_DIGEST_LIMITS,
): DesignDigest {
  const tokenValues = new Map<string, string>();
  for (const match of css.matchAll(TOKEN_RE)) {
    const name = match[1];
    const value = (match[2] ?? "").trim();
    if (!name || !value) continue;
    // Later declarations win, mirroring the cascade closely enough for a discovery aid.
    tokenValues.set(name, value.length > 120 ? `${value.slice(0, 117)}...` : value);
  }

  const classNames = new Set<string>();
  for (const match of css.matchAll(CLASS_RE)) {
    const cls = match[1];
    if (cls) classNames.add(cls);
  }

  const components: string[] = [];
  const utilities: string[] = [];
  for (const cls of classNames) {
    if (isUtility(cls)) utilities.push(cls); else components.push(cls);
  }
  components.sort();
  utilities.sort();

  const truncatedComponents = components.length > limits.maxComponents;
  const ranked = [...groupBy(components, firstSegment)].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  /**
   * Every family is listed, even when the budget forces a small sample from each.
   *
   * Spending the budget group-by-group until it ran out was worse than useless: on the real
   * stylesheet the ten largest families consumed all 400 slots and `chat-*` and `map-*` vanished
   * entirely, so an agent looking up "which chat classes exist" would conclude the answer was
   * "none" and hand-roll CSS — the exact failure the digest is meant to prevent. A thin sample of
   * every family plus its true `total` tells the agent what exists and where to use `filter` next.
   */
  const perGroup = ranked.length > 0
    ? Math.max(2, Math.min(limits.maxPerGroup, Math.floor(limits.maxComponents / ranked.length)))
    : limits.maxPerGroup;
  const componentGroups: ComponentClassGroup[] = ranked.map(([prefix, members]) => ({
    prefix,
    classes: members.slice(0, perGroup),
    total: members.length,
  }));
  const sampledGroup = componentGroups.some((group) => group.classes.length < group.total);

  const tokenEntries = [...tokenValues.entries()].sort(([a], [b]) => a.localeCompare(b));
  const truncatedTokens = tokenEntries.length > limits.maxTokens;
  const tokenGroups: DesignTokenGroup[] = [...groupBy(
    tokenEntries.slice(0, limits.maxTokens).map(([name, value]) => ({ name, value })),
    (token) => firstSegment(token.name),
  )].map(([group, tokens]) => ({ group, tokens }));

  const fontStacks = [...tokenValues.entries()]
    .filter(([name]) => name.startsWith("font-") || name.endsWith("-font"))
    .map(([, value]) => value)
    .filter((value) => /[a-z]/i.test(value));

  return {
    origin,
    tokens: tokenGroups,
    components: componentGroups,
    utilityFamilies: [...new Set(utilities.map(firstSegment).filter(Boolean))].sort(),
    fontStacks: [...new Set(fontStacks)],
    totals: {
      tokens: tokenValues.size,
      components: components.length,
      utilities: utilities.length,
      bytes: css.length,
    },
    truncated: truncatedComponents || truncatedTokens || sampledGroup,
  };
}
