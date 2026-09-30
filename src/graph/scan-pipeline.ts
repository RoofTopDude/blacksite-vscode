/* The import-scan pipeline as pure functions over per-file facts.

   These used to be private GraphIndexer methods that read files themselves
   (`_load*Index`, `_readTsconfigChain`, `_scanImports`, `_resolveFileTargets`).
   They moved here so the background worker (graph/worker/graph-worker.ts), the
   main-thread incremental pass, and tests all share one implementation, and so
   resolution runs on cached facts (graph/file-facts.ts) instead of re-reading
   content. No fs, no vscode. */

import { langOf, normalizeGraphPath } from "./graph-model.js";
import { buildBasenameIndex, resolveSpecifierTargets, type ResolveContext } from "./resolve-imports.js";
import { buildAliasTable, mergeExtendsChain, resolveExtends, type TsAliasConfig } from "./tsconfig-paths.js";
import { buildGoDirIndex, type GoModule } from "./go-modules.js";
import { buildCSharpIndexFromDeclarations } from "./csharp-index.js";
import { buildPhpIndexFromDeclarations } from "./php-index.js";
import { buildPyReExportIndexFromEntries } from "./python-reexports.js";
import { resolveDocByName, resolveDocLink } from "./doc-links.js";
import {
  buildPythonSourceRoots,
  buildRustCrateIndex,
  buildWorkspacePackageIndex,
  type JsPackageFacts,
  type PythonProjectFacts,
  type RustCrateFacts,
} from "./workspace-packages.js";
import type { FileFacts } from "./file-facts.js";

/** Hard ceiling on outgoing edges from one `.cs` file — a safety valve so a
    hub file cannot spray a hairball back onto the map (unchanged from the
    indexer's previous constant). */
export const CSHARP_MAX_EDGES_PER_FILE = 64;
/** Doc files are capped the same way doc-links.ts caps extraction. */
const MAX_TSCONFIG_EXTENDS_HOPS = 8;

/** Files whose facts feed the resolve context even when the indexed sample
    dropped them (a render/index cap must not hide a package.json, go.mod, or
    tsconfig that other files resolve through). */
export function isResolverManifest(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  return name === "package.json" || name === "tsconfig.json" || name === "jsconfig.json"
    || name === "go.mod" || name === "cargo.toml" || name === "pyproject.toml" || name === "setup.cfg";
}

/** Follow one tsconfig's `extends` chain through the facts map (bounded,
    cycle-safe) and merge it. A partial chain still merges what was read. */
function tsconfigChain(rel: string, facts: ReadonlyMap<string, FileFacts>, known: ReadonlySet<string>): TsAliasConfig | null {
  const chain: TsAliasConfig[] = [];
  const visited = new Set<string>();
  let current: string | null = rel;
  for (let hops = 0; current !== null && hops < MAX_TSCONFIG_EXTENDS_HOPS; hops += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    const cfg: TsAliasConfig | undefined = facts.get(current)?.tsconfig;
    if (!cfg) break;
    chain.unshift(cfg);
    if (!cfg.extends) break;
    current = resolveExtends(cfg.dir, cfg.extends, known);
  }
  return chain.length > 0 ? mergeExtendsChain(chain) : null;
}

/** Everything a resolution pass needs, built once from facts. `fileSet` is the
    set edges may point into (the indexed files); `facts` may also hold
    manifests outside it (see isResolverManifest). */
export function buildResolveContextFromFacts(
  facts: ReadonlyMap<string, FileFacts>,
  fileSet: ReadonlySet<string>,
  rootNames: readonly string[] = [],
): ResolveContext {
  const known = new Set<string>([...fileSet, ...facts.keys()]);
  const aliasConfigs: TsAliasConfig[] = [];
  const goModules: GoModule[] = [];
  const csharp: Array<{ path: string; namespaces: string[]; types: string[] }> = [];
  const php: Array<{ path: string; namespaces: string[]; types: string[] }> = [];
  const pythonIndex = new Map<string, Set<string>>();
  const initFiles: Array<{ path: string; reexports: NonNullable<FileFacts["pyRe"]> }> = [];
  const packages: JsPackageFacts[] = [];
  const crates: RustCrateFacts[] = [];
  const pyProjects: PythonProjectFacts[] = [];
  for (const [path, entry] of facts) {
    if (entry.tsconfig) {
      const merged = tsconfigChain(path, facts, known);
      if (merged) aliasConfigs.push(merged);
    }
    if (entry.go) goModules.push(entry.go);
    if (entry.pkg) packages.push(entry.pkg);
    if (entry.cargo) crates.push(entry.cargo);
    if (entry.pyproject) pyProjects.push(entry.pyproject);
    if (!fileSet.has(path)) continue;
    if (entry.cs) csharp.push({ path, ...entry.cs });
    if (entry.php) php.push({ path, ...entry.php });
    if (langOf(path) === "py") pythonIndex.set(path, new Set(entry.py ?? []));
    if (entry.pyRe) initFiles.push({ path, reexports: entry.pyRe });
  }
  return {
    byBasename: buildBasenameIndex(fileSet),
    aliases: buildAliasTable(aliasConfigs),
    goModules,
    goDirIndex: buildGoDirIndex(fileSet),
    csharp: buildCSharpIndexFromDeclarations(csharp),
    php: buildPhpIndexFromDeclarations(php),
    pythonIndex,
    pyReExports: buildPyReExportIndexFromEntries(initFiles, fileSet, pythonIndex),
    workspacePackages: buildWorkspacePackageIndex(packages),
    rustCrates: buildRustCrateIndex(crates),
    pythonSourceRoots: buildPythonSourceRoots(pyProjects),
    rootNames,
  };
}

/** One file's outgoing import/reference targets (self excluded), from its
    facts. Markdown links resolve to the code a doc references; `.cs` is
    type-precise and capped. Mirrors the indexer's previous
    `_resolveFileTargets` exactly, minus the file read. */
export function resolveTargetsFromFacts(
  relPath: string,
  facts: FileFacts | undefined,
  fileSet: ReadonlySet<string>,
  ctx: ResolveContext,
): Set<string> {
  const rel = normalizeGraphPath(relPath);
  const targets = new Set<string>();
  if (!facts) return targets;
  const lang = langOf(rel);
  if (lang === "md") {
    for (const raw of facts.docLinks ?? []) {
      const target = resolveDocLink(rel, raw, fileSet) ?? (ctx.byBasename ? resolveDocByName(raw, ctx.byBasename) : null);
      if (target && target !== rel) targets.add(target);
    }
    return targets;
  }
  const refs = facts.refs ? new Set(facts.refs) : new Set<string>();
  const csharpRefs = lang === "cs" ? refs : undefined;
  const phpRefs = lang === "php" ? refs : undefined;
  for (const spec of facts.specs ?? []) {
    for (const resolved of resolveSpecifierTargets(rel, spec, fileSet, ctx, csharpRefs, phpRefs)) {
      if (resolved !== rel) targets.add(resolved);
    }
  }
  if (lang === "cs" && targets.size > CSHARP_MAX_EDGES_PER_FILE) {
    const trimmed = [...targets].sort().slice(0, CSHARP_MAX_EDGES_PER_FILE);
    targets.clear();
    for (const target of trimmed) targets.add(target);
  }
  return targets;
}

/** Resolve every file in `files` → adjacency (from → targets). */
export function resolveAll(
  files: readonly string[],
  facts: ReadonlyMap<string, FileFacts>,
  fileSet: ReadonlySet<string>,
  ctx: ResolveContext,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rel of files) {
    const targets = resolveTargetsFromFacts(rel, facts.get(rel), fileSet, ctx);
    if (targets.size > 0) out.set(rel, [...targets]);
  }
  return out;
}
