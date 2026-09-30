/* Logical coupling from git history: files that keep changing in the same
   commits are related, whether or not any import says so. This is the one
   relationship signal that works for every language, and across projects and
   workspace roots that live in one repository.

   The commit file lists already come out of the git-heat `git log` (see
   parseGitCommits); this module only counts pairs. Noise control, all tunable
   here and nowhere else:
   - bulk commits (> MAX_FILES_PER_COMMIT) are skipped upstream;
   - a pair needs `minSupport` shared commits;
   - confidence = support / min(churnA, churnB) must reach `minConfidence`, so
     two files that each change constantly and only sometimes together don't
     qualify;
   - each file keeps only its `maxPerFile` strongest partners, and the whole
     set is capped. Pure. */

import type { GraphEdge } from "./graph-model.js";

export interface CochangeOptions {
  minSupport: number;
  minConfidence: number;
  maxPerFile: number;
  maxEdges: number;
}

export const DEFAULT_COCHANGE_OPTIONS: CochangeOptions = {
  minSupport: 3,
  minConfidence: 0.3,
  maxPerFile: 8,
  maxEdges: 20_000,
};

export interface CochangePair {
  a: string;
  b: string;
  support: number;
  confidence: number;
}

/** Pair counts over commits whose paths are already node ids (unknown paths
    must be removed by the caller). */
export function cochangePairs(commits: readonly (readonly string[])[], options: CochangeOptions = DEFAULT_COCHANGE_OPTIONS): CochangePair[] {
  const churn = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const commit of commits) {
    const files = [...new Set(commit)].sort();
    for (const file of files) churn.set(file, (churn.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const key = `${files[i]}\u0000${files[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const candidates: CochangePair[] = [];
  for (const [key, support] of pairs) {
    if (support < options.minSupport) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const confidence = support / Math.max(1, Math.min(churn.get(a) ?? 1, churn.get(b) ?? 1));
    if (confidence < options.minConfidence) continue;
    candidates.push({ a, b, support, confidence: Math.min(1, confidence) });
  }
  candidates.sort((x, y) => y.support - x.support || y.confidence - x.confidence || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const perFile = new Map<string, number>();
  const kept: CochangePair[] = [];
  for (const pair of candidates) {
    if ((perFile.get(pair.a) ?? 0) >= options.maxPerFile || (perFile.get(pair.b) ?? 0) >= options.maxPerFile) continue;
    perFile.set(pair.a, (perFile.get(pair.a) ?? 0) + 1);
    perFile.set(pair.b, (perFile.get(pair.b) ?? 0) + 1);
    kept.push(pair);
    if (kept.length >= options.maxEdges) break;
  }
  return kept;
}

export function cochangeEdgeId(a: string, b: string): string {
  return `cochange:${a}<->${b}`;
}

/** Edges for the map. Direction carries no meaning (from < to lexically);
    map-queries registers them both ways, like notes. */
export function cochangeEdges(pairs: readonly CochangePair[]): GraphEdge[] {
  return pairs.map((pair) => ({
    id: cochangeEdgeId(pair.a, pair.b),
    from: pair.a,
    to: pair.b,
    kind: "cochange",
    provenance: "history",
    confidence: Math.round(pair.confidence * 100) / 100,
    occurrenceCount: pair.support,
    label: `changed together in ${pair.support} commits`,
  }));
}
