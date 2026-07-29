/* Autocomplete for the ticket surfaces' relation fields.
 *
 * The host answers suggestion queries rather than shipping the candidate sets to the webview,
 * for one reason: the file vocabulary is the whole Codebase Map index. Pushing tens of thousands
 * of node ids into a sidebar so it can filter them locally would cost more on every panel open
 * than every keystroke this ever serves. The webview asks, the host ranks, the answer is twelve
 * rows — and the vocabularies (labels in use, tickets that exist, plans that exist) stay
 * authoritative on the side that owns them.
 *
 * Every field is served by one scorer so a match feels the same wherever it appears: exact,
 * then prefix, then word-boundary, then substring, then subsequence — never anything looser.
 * A suggestion list that guesses is worse than a short one, because the wrong file silently
 * accepted becomes a ticket scoped to the wrong place.
 */

import type { Ticket } from "./ticket-store.js";

export type SuggestField = "file" | "area" | "label" | "ticket" | "plan";

export interface Suggestion {
  /** The value written into the field when accepted. */
  value: string;
  /** Primary display text — a basename, a ticket title, a label. */
  label: string;
  /** Muted trailing context: the directory a file lives in, a ticket's status, a usage count. */
  hint?: string;
  /** Non-selectable context shown in the row (a ticket's status pill, for instance). */
  kind?: string;
}

export interface SuggestSources {
  indexedFiles: () => string[];
  tickets: () => readonly Ticket[];
  labels: () => Array<{ label: string; count: number }>;
  plans: () => Array<{ id: string; title: string; status?: string }>;
}

const MAX_SUGGESTIONS = 12;
/** Scanning the whole index on every keystroke is fine; scoring every candidate twice is not. */
const MAX_SCANNED = 20_000;

/**
 * Score one candidate against a query, or -1 for no match.
 *
 * Higher is better. The tiers are wide apart on purpose so a shorter path can never outrank a
 * better *kind* of match — `src/graph/layout.ts` for "layout" must beat
 * `src/l-a-y-o-u-t-ish.ts` no matter how the lengths compare.
 */
export function scoreCandidate(candidate: string, query: string): number {
  if (!query) return 1;
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();

  if (haystack === needle) return 1000;

  const basename = haystack.slice(haystack.lastIndexOf("/") + 1);
  if (basename === needle) return 900;
  if (basename.startsWith(needle)) return 800 - basename.length;
  if (haystack.startsWith(needle)) return 700 - haystack.length;

  // A match that begins a path segment or a word reads as intentional; one mid-token does not.
  const boundary = haystack.search(new RegExp(`(^|[/_.\\- ])${escapeRegExp(needle)}`));
  if (boundary >= 0) return 600 - boundary;

  const index = haystack.indexOf(needle);
  if (index >= 0) return 400 - index;

  return subsequenceScore(haystack, needle);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Characters in order but not adjacent — "grla" finding "graph/layout". Scored low and
 *  penalized by how far apart the hits land, so scattered matches sink below real ones. */
function subsequenceScore(haystack: string, needle: string): number {
  let cursor = 0;
  let spread = 0;
  let last = -1;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return -1;
    if (last >= 0) spread += found - last - 1;
    last = found;
    cursor = found + 1;
  }
  return Math.max(1, 200 - spread);
}

function rank(items: Suggestion[], query: string, limit = MAX_SUGGESTIONS): Suggestion[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: Math.max(scoreCandidate(item.value, query), scoreCandidate(item.label, query)) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.value.localeCompare(right.item.value))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Directory prefixes worth offering as an area.
 *
 * Derived from the index rather than the filesystem so an area always resolves to something —
 * and single-child directories are folded away, because "src" and "src/webview" and
 * "src/webview/react" as three separate suggestions when only the last has files in it is three
 * ways to say one thing.
 */
export function deriveAreas(indexedFiles: readonly string[]): Array<{ area: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of indexedFiles.slice(0, MAX_SCANNED)) {
    const segments = file.split("/");
    segments.pop();
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([area, files]) => ({ area, files }))
    .sort((left, right) => right.files - left.files || left.area.localeCompare(right.area));
}

/**
 * Answer one suggestion request.
 *
 * `exclude` carries what the field already holds, so accepting a value never offers it a second
 * time — the single most common way an autocomplete wastes a row.
 */
export function suggest(
  field: SuggestField,
  query: string,
  sources: SuggestSources,
  exclude: readonly string[] = [],
): Suggestion[] {
  const taken = new Set(exclude);
  const trimmed = query.trim();

  switch (field) {
    case "file": {
      const items = sources.indexedFiles()
        .slice(0, MAX_SCANNED)
        .filter((file) => !taken.has(file))
        .map<Suggestion>((file) => ({
          value: file,
          label: file.slice(file.lastIndexOf("/") + 1),
          hint: file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : undefined,
        }));
      return rank(items, trimmed);
    }
    case "area": {
      const items = deriveAreas(sources.indexedFiles())
        .filter((entry) => !taken.has(entry.area))
        .map<Suggestion>((entry) => ({
          value: entry.area,
          label: entry.area,
          hint: `${entry.files} file${entry.files === 1 ? "" : "s"}`,
        }));
      /* Unqueried, the biggest areas are the useful default; ranked, relevance wins. */
      return rank(items, trimmed);
    }
    case "label": {
      const items = sources.labels()
        .filter((entry) => !taken.has(entry.label))
        .map<Suggestion>((entry) => ({
          value: entry.label,
          label: entry.label,
          hint: `${entry.count}`,
        }));
      return rank(items, trimmed);
    }
    case "ticket": {
      const items = sources.tickets()
        .filter((ticket) => !taken.has(ticket.id))
        .map<Suggestion>((ticket) => ({
          value: ticket.id,
          label: ticket.title,
          hint: ticket.id,
          kind: ticket.status,
        }));
      return rank(items, trimmed);
    }
    case "plan": {
      const items = sources.plans()
        .filter((plan) => !taken.has(plan.id))
        .map<Suggestion>((plan) => ({
          value: plan.id,
          label: plan.title || plan.id,
          hint: plan.id,
          kind: plan.status,
        }));
      return rank(items, trimmed);
    }
    default:
      return [];
  }
}
