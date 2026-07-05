/* Pure Go module-path resolution for the Codebase Map.

   Go imports name a *package* by its full module path
   (`import "github.com/acme/app/internal/store"`), not a file. Only imports
   whose prefix matches a `go.mod` module declared in the workspace point at
   local code; stdlib and third-party imports resolve to nothing. A Go package
   is a directory, and the map is file-granular, so one local import fans out to
   an edge per source file in that package's directory. Same-package siblings
   (no import needed) are intentionally not linked — that would be a clique per
   directory, not a relationship worth drawing.

   Module roots are expressed in node-id space (workspace-relative, forward
   slashes, folder-qualified in multi-root); the host derives each from its
   go.mod location, so this stays a pure function of strings.

   Like every other resolver in this module, "the workspace" here means the
   file set the caller passes in — on a workspace that exceeds the map's
   render cap, that's the sampled subset actually displayed, not necessarily
   every source file the package has on disk. */

import { dirOf } from "./graph-model.js";

export interface GoModule {
  /** Directory of the go.mod in node-id space ("" = a root-level module). */
  root: string;
  /** The declared `module <path>` import prefix. */
  module: string;
}

/** Parse the `module` line out of a go.mod, or null when absent. `dir` is the
    go.mod's directory in node-id space. */
export function parseGoMod(dir: string, content: string): GoModule | null {
  const match = /^[ \t]*module[ \t]+(\S+)/m.exec(content);
  const modulePath = match?.[1]?.trim();
  return modulePath ? { root: dir, module: modulePath } : null;
}

/** Directory → its .go files, built once per rebuild so resolveGoImport can
    look up a package's members without rescanning the whole file set for
    every import statement in the workspace. */
export function buildGoDirIndex(files: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith(".go")) continue;
    const dir = dirOf(file);
    const list = index.get(dir);
    if (list) list.push(file);
    else index.set(dir, [file]);
  }
  return index;
}

/** Resolve a Go import path to the workspace `.go` files of the package it
    names, or [] when it belongs to no local module (stdlib / third-party). Test
    files (`*_test.go`) are only returned when the package has no non-test
    files, so a normal import lands on the package's real code. The importing
    file is always excluded.

    `dirIndex` (from `buildGoDirIndex`) makes the common case an O(1) lookup
    instead of an O(files) scan; when omitted, falls back to scanning `files`
    directly (still correct, just the slower path — used by callers, like the
    unit tests, that resolve a single import in isolation). */
export function resolveGoImport(
  fromPath: string,
  importPath: string,
  files: ReadonlySet<string>,
  modules: readonly GoModule[],
  dirIndex?: ReadonlyMap<string, string[]>,
): string[] {
  const spec = importPath.trim();
  if (!spec) return [];

  let best: GoModule | null = null;
  for (const mod of modules) {
    if (spec === mod.module || spec.startsWith(`${mod.module}/`)) {
      if (best === null || mod.module.length > best.module.length) best = mod;
    }
  }
  if (best === null) return [];

  const rel = spec === best.module ? "" : spec.slice(best.module.length + 1);
  const dir = best.root ? (rel ? `${best.root}/${rel}` : best.root) : rel;

  const candidates = dirIndex
    ? (dirIndex.get(dir) ?? [])
    : [...files].filter((file) => dirOf(file) === dir && file.endsWith(".go"));

  const source: string[] = [];
  const tests: string[] = [];
  for (const file of candidates) {
    if (file === fromPath) continue;
    if (file.endsWith("_test.go")) tests.push(file);
    else source.push(file);
  }
  return source.length > 0 ? source : tests;
}
