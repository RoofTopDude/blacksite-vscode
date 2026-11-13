/* Git-aware file discovery for the Codebase Map.

   `vscode.workspace.findFiles` walks every directory the exclude glob does not
   name, and it has no notion of `.gitignore` (the ignore-aware `findFiles2` is
   still a proposed API). On a dense repository that means generated clients,
   vendored trees, and build output the repository itself ignores are
   enumerated, read, import-scanned, and laid out. `git ls-files` answers the
   question the map actually wants — "which files belong to this project" — from
   the index, which is also far faster than a filesystem walk.

   The pure helpers (parsing, grouping, path mapping) live in git-parse.ts and
   are re-exported here; the runners shell out and degrade to `null` on any
   failure so the caller can fall back to its enumerator. Mirrors git-log.ts's
   shape. */

import { execFile } from "child_process";
import { normalizeAbsolutePath } from "./workspace-roots.js";
import { absoluteFromRepo, parseNulList, rootPathspec, type RepoGroup } from "./git-parse.js";

export { absoluteFromRepo, groupRootsByRepo, parseNulList, rootPathspec, type RepoGroup } from "./git-parse.js";

const GIT_TIMEOUT_MS = 20_000;
/* ls-files over a 150k-file monorepo is a few MB of paths; bounded well above
   that so a pathological repository fails over to findFiles instead of
   truncating silently. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

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
