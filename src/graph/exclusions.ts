/* Directory-exclusion policy for the Codebase Map. Kept separate from
   graph-indexer.ts — and free of any vscode import — so the rule that decides
   what the map never looks at is explicit and unit-testable without a host,
   the same way file-discovery.ts isolates the corpus boundary.

   Two rules compose here:

   - ALWAYS_EXCLUDED: directories the map must never index no matter what the
     user configures. `.git` and `.blacksite` are load-bearing (indexing either
     would feed the map its own derived state), so they stay listed explicitly
     even though the dot rule below would also catch them.
   - The dot rule: any *directory* whose name starts with "." is tooling state,
     not authored source. This is the general form of what ALWAYS_EXCLUDED was
     already reaching for by hand — it names four dot-directories, which is the
     tell that the category was the intent all along. An enumeration can never
     be complete; `.vscode-test`, `.pytest_cache`, `.mypy_cache`, `.gradle`,
     `.idea`, `.tox`, `.terraform`, `.turbo` and their kin all fell through it. */

import { normalizeGraphPath } from "./graph-model.js";

/** Directories the map never indexes, regardless of settings. Turning the dot
    rule off must not start indexing `.git`. */
const ALWAYS_EXCLUDED: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".blacksite", "dist", "out", "build",
  ".next", "coverage", "__pycache__", ".venv", "venv",
]);

/* High-volume dot-directories worth naming in the findFiles exclude glob so
   they are pruned at scan time rather than enumerated and then dropped. This
   is purely an optimization: correctness lives entirely in
   hasExcludedSegment(), because a brace glob cannot express "any segment
   starting with a dot" (see buildExcludeGlob). A name missing from this list
   costs scan time and nothing else. */
const COMMON_DOT_DIRECTORIES: readonly string[] = [
  ".angular", ".astro", ".cache", ".dart_tool", ".gradle", ".idea", ".mypy_cache",
  ".nuxt", ".nx", ".parcel-cache", ".pnpm-store", ".pytest_cache", ".ruff_cache",
  ".stack-work", ".svelte-kit", ".terraform", ".tox", ".turbo", ".vscode-test",
  ".yarn",
];

export interface ExclusionPolicy {
  /** Skip every directory whose name begins with "." (default behavior). */
  excludeDotDirectories: boolean;
  /** Dot-directory names to index anyway, stored without the leading dot and
      lower-cased — see normalizeAllowlistEntry. */
  allowlist: ReadonlySet<string>;
}

/** The policy in force when nothing is configured: the dot rule on, nothing
    allowed back in. Also what callers with no config (tests, pure helpers)
    should use so they see the shipped default rather than a permissive one. */
export const DEFAULT_EXCLUSION_POLICY: ExclusionPolicy = {
  excludeDotDirectories: true,
  allowlist: new Set(),
};

/** A policy that only enforces the invariants — used when the user turns the
    dot rule off. */
export const INVARIANTS_ONLY_POLICY: ExclusionPolicy = {
  excludeDotDirectories: false,
  allowlist: new Set(),
};

/** Canonical form of one user-supplied allowlist entry: a bare lower-cased
    directory name with no leading dot, no path decoration, and no slashes.
    Deliberately forgiving — ".github", "github", "./github/" and " .GitHub "
    all mean the same directory, and making somebody remember the dot is a
    papercut with no upside. Returns null for anything that isn't a single
    directory name (a nested path, an empty string, a bare dot). */
export function normalizeAllowlistEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = normalizeGraphPath(raw).replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!trimmed || trimmed.includes("/")) return null;
  const withoutDot = trimmed.replace(/^\.+/, "");
  return withoutDot ? withoutDot.toLowerCase() : null;
}

/** Build the runtime policy from resolved settings. */
export function exclusionPolicy(config: {
  excludeDotDirectories: boolean;
  dotDirectoryAllowlist: readonly string[];
}): ExclusionPolicy {
  const allowlist = new Set<string>();
  for (const entry of config.dotDirectoryAllowlist) {
    const normalized = normalizeAllowlistEntry(entry);
    if (normalized) allowlist.add(normalized);
  }
  return { excludeDotDirectories: config.excludeDotDirectories === true, allowlist };
}

/** Whether one *directory* segment is excluded under `policy`.

    Callers must not pass a filename: the dot rule is about directories, and a
    dot-file (`.eslintrc.json`, `.env.production`) is authored configuration the
    map deliberately keeps — client-config shapes are what verify config-driven
    service calls (see file-discovery.ts). hasExcludedSegment() enforces that
    split; this is the predicate it applies. */
export function isExcludedSegment(segment: string, policy: ExclusionPolicy): boolean {
  if (!segment) return false;
  if (ALWAYS_EXCLUDED.has(segment)) return true;
  if (!policy.excludeDotDirectories || !segment.startsWith(".")) return false;
  return !policy.allowlist.has(segment.replace(/^\.+/, "").toLowerCase());
}

/** True when any directory segment of `relPath` is excluded under `policy`.
    The final segment is treated as a filename for the dot rule but still
    checked against ALWAYS_EXCLUDED, preserving the pre-policy behavior of the
    literal segment set this replaces. */
export function hasExcludedSegment(relPath: string, policy: ExclusionPolicy): boolean {
  const segments = normalizeGraphPath(relPath).split("/");
  const lastIndex = segments.length - 1;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    if (ALWAYS_EXCLUDED.has(segment)) return true;
    if (i < lastIndex && isExcludedSegment(segment, policy)) return true;
  }
  return false;
}

/** The findFiles exclude glob for `policy`.

    VS Code's exclude pattern is a brace-and-star glob with no way to say "any
    segment beginning with a dot", so the dot rule cannot live here — this only
    prunes names known ahead of time, and hasExcludedSegment() is what actually
    enforces the policy after enumeration. */
export function buildExcludeGlob(policy: ExclusionPolicy): string {
  const names = [...ALWAYS_EXCLUDED];
  if (policy.excludeDotDirectories) {
    for (const name of COMMON_DOT_DIRECTORIES) {
      if (ALWAYS_EXCLUDED.has(name)) continue;
      if (policy.allowlist.has(name.replace(/^\.+/, ""))) continue;
      names.push(name);
    }
  }
  return `**/{${names.join(",")}}/**`;
}

/** Stable identity for a resolved policy, persisted in the render cache.

    A schema bump alone can't cover this: the corpus is derived from the policy,
    so a cache built under a different one describes a file set that no longer
    exists. Without this key, toggling the setting would leave the user staring
    at an unchanged map and concluding the feature is broken. */
export function exclusionPolicyKey(policy: ExclusionPolicy): string {
  const allowed = [...policy.allowlist].sort().join(",");
  return `dot:${policy.excludeDotDirectories ? 1 : 0}|allow:${allowed}`;
}
