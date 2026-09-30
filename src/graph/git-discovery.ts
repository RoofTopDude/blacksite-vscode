/* Git-aware file discovery for the Codebase Map.

   `vscode.workspace.findFiles` walks every directory the exclude glob does not
   name, and it has no notion of `.gitignore` (the ignore-aware `findFiles2` is
   still a proposed API). On a dense repository that means generated clients,
   vendored trees, and build output the repository itself ignores are
   enumerated, read, import-scanned, and laid out. `git ls-files` answers the
   question the map actually wants — "which files belong to this project" — from
   the index, which is also far faster than a filesystem walk.

   Pure helpers (parsing, grouping, path mapping) are exported for tests; the
   runner shells out and degrades to `null` on any failure so the caller can fall
   back to findFiles. Mirrors git-log.ts's shape. */

import { execFile } from "child_process";
import { normalizeAbsolutePath } from "./workspace-roots.js";

const GIT_TIMEOUT_MS = 20_000;
/* ls-files over a 150k-file monorepo is a few MB of paths; bounded well above
   that so a pathological repository fails over to findFiles instead of
   truncating silently. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export interface RepoGroup {
  /** Absolute repo toplevel, forward slashes. */
  toplevel: string;
  /** Absolute workspace-root paths (forward slashes) that live in this repo. */
  roots: string[];
}

/** Split `git ... -z` output into entries (NUL-terminated, final entry may be empty). */
export function parseNulList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** Pathspec for `root` relative to its repo toplevel, or "" when the root is
    the toplevel itself. Case-insensitive prefix (Windows drive letters and
    folder casing routinely differ between git and VS Code). */
export function rootPathspec(toplevel: string, rootPath: string): string | null {
  const top = normalizeAbsolutePath(toplevel);
  const root = normalizeAbsolutePath(rootPath);
  if (top.toLowerCase() === root.toLowerCase()) return "";
  if (!root.toLowerCase().startsWith(`${top.toLowerCase()}/`)) return null;
  return root.slice(top.length + 1);
}

/** Group workspace roots by the repository that contains them, so two roots
    inside one monorepo cost one `git` process rather than two. Roots whose
    toplevel could not be determined are returned separately for the
    findFiles fallback. */
export function groupRootsByRepo(
  roots: readonly string[],
  toplevels: ReadonlyMap<string, string | null>,
): { groups: RepoGroup[]; ungrouped: string[] } {
  const byTop = new Map<string, RepoGroup>();
  const ungrouped: string[] = [];
  for (const root of roots) {
    const top = toplevels.get(root);
    if (!top) {
      ungrouped.push(root);
      continue;
    }
    const key = normalizeAbsolutePath(top).toLowerCase();
    const group = byTop.get(key) ?? { toplevel: normalizeAbsolutePath(top), roots: [] };
    group.roots.push(root);
    byTop.set(key, group);
  }
  return { groups: [...byTop.values()], ungrouped };
}

/** Absolute paths for `ls-files` entries (repo-relative, forward slashes). */
export function absoluteFromRepo(toplevel: string, entries: readonly string[]): string[] {
  const top = normalizeAbsolutePath(toplevel);
  return entries.map((entry) => `${top}/${entry}`);
}

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        args,
        { cwd, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

export async function gitToplevel(rootPath: string): Promise<string | null> {
  const out = await runGit(rootPath, ["rev-parse", "--show-toplevel"], 8000);
  const top = out?.split("\n")[0]?.trim();
  return top ? normalizeAbsolutePath(top) : null;
}

/** Every tracked file plus every untracked-but-not-ignored file under the
    group's roots, as absolute paths. Tracked files are listed even when an
    ignore pattern would match them — ignore rules only govern untracked files.
    Returns null when git fails, so the caller falls back to findFiles. */
export async function listRepoFiles(group: RepoGroup): Promise<string[] | null> {
  const specs: string[] = [];
  for (const root of group.roots) {
    const spec = rootPathspec(group.toplevel, root);
    if (spec === null) return null;
    if (spec === "") {
      specs.length = 0;
      specs.push(".");
      break;
    }
    specs.push(spec);
  }
  const stdout = await runGit(group.toplevel, [
    "-c", "core.quotePath=false",
    "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    "--", ...specs,
  ]);
  if (stdout === null) return null;
  /* --cached lists files deleted from the working tree but still staged; the
     caller stats nothing here, so duplicates (a file both cached and other) are
     collapsed and missing files are filtered later by the reader. */
  return [...new Set(absoluteFromRepo(group.toplevel, parseNulList(stdout)))];
}

/** Which of `absolutePaths` (all inside `toplevel`) git would ignore. Used by
    the watcher path: a build writing thousands of files into an ignored
    directory must not dirty the map. One process per batch. */
export async function ignoredPaths(toplevel: string, absolutePaths: readonly string[]): Promise<Set<string>> {
  const top = normalizeAbsolutePath(toplevel);
  const rel: string[] = [];
  for (const abs of absolutePaths) {
    const spec = rootPathspec(top, abs);
    if (spec) rel.push(spec);
  }
  if (rel.length === 0) return new Set();
  const out = await new Promise<string | null>((resolve) => {
    try {
      const child = execFile(
        "git",
        ["check-ignore", "-z", "--stdin"],
        { cwd: top, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
        /* Exit status 1 means "nothing ignored" — stdout is still meaningful. */
        (err, stdout) => resolve(err && (err as { code?: unknown }).code !== 1 ? null : stdout),
      );
      child.stdin?.end(rel.join("\0") + "\0");
    } catch {
      resolve(null);
    }
  });
  if (!out) return new Set();
  return new Set(parseNulList(out).map((entry) => `${top}/${entry}`.toLowerCase()));
}
