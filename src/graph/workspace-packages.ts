/* Workspace-package resolution: bare specifiers that name a package declared
   *inside the workspace*.

   Before this module, a bare JS/TS specifier resolved only through tsconfig
   path aliases. A monorepo that links packages through npm/pnpm/yarn
   workspaces — `import { Button } from "@acme/ui"` — and two workspace roots
   that import each other's packages produced no edge at all unless someone
   also happened to mirror every package in `compilerOptions.paths`. The same
   gap existed for Rust sibling crates (`use shared_types::Foo`) and Python
   packages installed from a sibling project.

   Only names declared by a manifest *in the corpus* can match, so a real
   registry package (react, serde, requests) never produces an edge. Pure: the
   caller supplies parsed manifest facts in node-id space. */

import { dirOf, joinPosix, normalizeGraphPath } from "./graph-model.js";
import { stripJsonc } from "./tsconfig-paths.js";

/** The parts of a package.json that decide where an import lands. */
export interface JsPackageFacts {
  name: string;
  /** Directory of the package.json in node-id space ("" = a root-level package). */
  dir: string;
  main?: string;
  module?: string;
  types?: string;
  source?: string;
  /** `exports`, kept as written (string, conditions object, or subpath map). */
  exports?: unknown;
  /** `imports` (`#internal/*` subpath imports), kept as written. */
  imports?: unknown;
}

export interface RustCrateFacts {
  /** Crate name as written in `[package] name`; resolution uses the
      underscore form Rust source refers to it by. */
  name: string;
  /** Directory of the Cargo.toml in node-id space. */
  dir: string;
  /** `[lib] path`, when the crate root is not src/lib.rs. */
  libPath?: string;
}

export interface PythonProjectFacts {
  /** Directory of the pyproject.toml / setup.cfg in node-id space. */
  dir: string;
  /** Source roots the project declares (setuptools `where`, poetry
      `packages.from`), relative to `dir`. Always includes "" and "src" as
      conventional fallbacks. */
  sourceDirs: string[];
}

export interface WorkspacePackageIndex {
  byName: ReadonlyMap<string, JsPackageFacts>;
  /** Packages sorted deepest-dir-first, for "which package owns this file". */
  byDirDeepest: readonly JsPackageFacts[];
}

const CONDITION_ORDER = ["source", "development", "types", "import", "module", "require", "node", "browser", "default"];
/* Build-output directory names whose source twin is worth probing: a package
   whose `main` points at dist/index.js is almost always authored in
   src/index.ts, and build output is never in the corpus (it is excluded). */
const BUILD_DIR_RE = /(^|\/)(dist|out|build|lib|esm|cjs|es|umd)\//;
const JS_OUTPUT_EXT_RE = /\.(?:d\.ts|d\.mts|d\.cts|mjs|cjs|js)$/;

export function parsePackageJsonFacts(path: string, content: string): JsPackageFacts | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonc(content)); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  return {
    name,
    dir: dirOf(normalizeGraphPath(path)),
    ...(str(record.main) ? { main: str(record.main) } : {}),
    ...(str(record.module) ? { module: str(record.module) } : {}),
    ...(str(record.types) ?? str(record.typings) ? { types: str(record.types) ?? str(record.typings) } : {}),
    ...(str(record.source) ? { source: str(record.source) } : {}),
    ...(record.exports !== undefined ? { exports: record.exports } : {}),
    ...(record.imports !== undefined ? { imports: record.imports } : {}),
  };
}

export function buildWorkspacePackageIndex(packages: Iterable<JsPackageFacts>): WorkspacePackageIndex {
  const byName = new Map<string, JsPackageFacts>();
  const all: JsPackageFacts[] = [];
  for (const pkg of packages) {
    all.push(pkg);
    /* Two manifests with one name (a fixture copy, an example app) — keep the
       shallowest, which is the package a workspace install actually links. */
    const existing = byName.get(pkg.name);
    if (!existing || pkg.dir.split("/").length < existing.dir.split("/").length) byName.set(pkg.name, pkg);
  }
  return { byName, byDirDeepest: all.sort((a, b) => b.dir.length - a.dir.length) };
}

/** `@scope/name/sub/path` → { name: "@scope/name", subpath: "./sub/path" }. */
export function splitPackageSpecifier(spec: string): { name: string; subpath: string } | null {
  const clean = spec.replace(/[?#].*$/, "").trim();
  if (!clean || clean.startsWith(".") || clean.startsWith("/") || clean.includes(":")) return null;
  const parts = clean.split("/");
  const nameParts = clean.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  if (nameParts.some((part) => !part)) return null;
  const name = nameParts.join("/");
  const rest = parts.slice(nameParts.length).join("/");
  return { name, subpath: rest ? `./${rest}` : "." };
}

/** Flatten a conditional-exports value into targets, preferred condition first. */
function conditionTargets(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) conditionTargets(entry, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const ordered = [
      ...CONDITION_ORDER.filter((key) => key in record),
      ...keys.filter((key) => !CONDITION_ORDER.includes(key)),
    ];
    for (const key of ordered) conditionTargets(record[key], out, depth + 1);
  }
  return out;
}

/** Targets an `exports`/`imports` map gives for `subpath`, with `*` patterns
    substituted. A bare string or conditions object applies to ".". */
export function subpathTargets(map: unknown, subpath: string): string[] {
  if (map === undefined || map === null) return [];
  const isSubpathMap = typeof map === "object" && !Array.isArray(map)
    && Object.keys(map as Record<string, unknown>).some((key) => key.startsWith(".") || key.startsWith("#"));
  if (!isSubpathMap) return subpath === "." ? conditionTargets(map) : [];
  const record = map as Record<string, unknown>;
  if (subpath in record) return conditionTargets(record[subpath]);
  /* Longest matching `*` pattern wins, as in Node's resolver. */
  let best: { key: string; captured: string } | null = null;
  for (const key of Object.keys(record)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (!best || prefix.length > best.key.indexOf("*")) {
      best = { key, captured: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  if (!best) return [];
  return conditionTargets(record[best.key]).map((target) => target.replace(/\*/g, best!.captured));
}

/** Source twins for a build-output path: `dist/x/y.js` → `src/x/y`, `x/y`. */
export function sourceTwins(target: string): string[] {
  const out: string[] = [];
  const stripped = target.replace(JS_OUTPUT_EXT_RE, "");
  if (BUILD_DIR_RE.test(stripped)) {
    out.push(stripped.replace(BUILD_DIR_RE, "$1src/"));
    out.push(stripped.replace(BUILD_DIR_RE, "$1"));
    /* dist/types/index.d.ts → src/index */
    out.push(stripped.replace(BUILD_DIR_RE, "$1src/").replace(/\/types\//, "/"));
  } else if (stripped !== target) {
    out.push(stripped);
  }
  return out;
}

function pushJoined(out: string[], dir: string, target: string): void {
  const joined = joinPosix(dir, normalizeGraphPath(target.replace(/^\.\//, "")));
  if (joined === null || joined === "") return;
  if (!out.includes(joined)) out.push(joined);
  for (const twin of sourceTwins(joined)) if (twin && !out.includes(twin)) out.push(twin);
}

/** Candidate base paths (probe with the JS extension prober) for a bare
    specifier that names a workspace package, or a `#` subpath import of the
    importing file's own package. Empty when nothing in the workspace declares
    the name. */
export function workspacePackageCandidates(fromPath: string, spec: string, index: WorkspacePackageIndex | undefined): string[] {
  if (!index) return [];
  const out: string[] = [];
  const clean = spec.replace(/[?#].*$/, "").trim();
  if (spec.trim().startsWith("#")) {
    const owner = index.byDirDeepest.find((pkg) => pkg.dir === "" || fromPath.startsWith(`${pkg.dir}/`));
    if (!owner) return [];
    for (const target of subpathTargets(owner.imports, spec.trim())) {
      if (target.startsWith(".")) pushJoined(out, owner.dir, target);
    }
    return out;
  }
  const parsed = splitPackageSpecifier(clean);
  if (!parsed) return [];
  const pkg = index.byName.get(parsed.name);
  if (!pkg) return [];
  for (const target of subpathTargets(pkg.exports, parsed.subpath)) {
    if (target.startsWith(".")) pushJoined(out, pkg.dir, target);
  }
  if (parsed.subpath === ".") {
    for (const field of [pkg.source, pkg.types, pkg.module, pkg.main]) {
      if (field) pushJoined(out, pkg.dir, field);
    }
    pushJoined(out, pkg.dir, "src/index");
    pushJoined(out, pkg.dir, "index");
  } else {
    pushJoined(out, pkg.dir, parsed.subpath);
    pushJoined(out, pkg.dir, `src/${parsed.subpath.slice(2)}`);
  }
  return out;
}

/* ---------------------------------------------------------------- Rust ---- */

/** Minimal TOML reads for Cargo.toml: `[package] name` and `[lib] path`. */
export function parseCargoFacts(path: string, content: string): RustCrateFacts | null {
  let section = "";
  let name = "";
  let libPath = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (section === "package" && kv[1] === "name") name = kv[2]!;
    if (section === "lib" && kv[1] === "name" && !name) name = kv[2]!;
    if (section === "lib" && kv[1] === "path") libPath = kv[2]!;
  }
  if (!name) return null;
  return { name, dir: dirOf(normalizeGraphPath(path)), ...(libPath ? { libPath } : {}) };
}

/** crate identifier (underscored) → the directory `crate::` paths resolve
    against for that crate. */
export function buildRustCrateIndex(crates: Iterable<RustCrateFacts>): Map<string, string> {
  const out = new Map<string, string>();
  for (const crate of crates) {
    const ident = crate.name.replace(/-/g, "_");
    const libDir = crate.libPath ? dirOf(joinPosix(crate.dir, normalizeGraphPath(crate.libPath)) ?? "") : null;
    const srcDir = libDir ?? (crate.dir ? `${crate.dir}/src` : "src");
    if (!out.has(ident)) out.set(ident, srcDir);
  }
  return out;
}

/* -------------------------------------------------------------- Python ---- */

/** Source roots a Python project declares. Deliberately line-based: pyproject
    `where = ["src"]`, poetry `packages = [{ include = "x", from = "lib" }]`,
    and setup.cfg `package_dir = =src`. */
export function parsePythonProjectFacts(path: string, content: string): PythonProjectFacts {
  const dir = dirOf(normalizeGraphPath(path));
  const roots = new Set<string>(["", "src"]);
  for (const match of content.matchAll(/\bwhere\s*=\s*\[([^\]]*)\]/g)) {
    for (const item of match[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) roots.add(normalizeGraphPath(item[1] ?? item[2] ?? ""));
  }
  for (const match of content.matchAll(/\bfrom\s*=\s*"([^"]+)"/g)) roots.add(normalizeGraphPath(match[1]!));
  for (const match of content.matchAll(/^\s*=\s*([\w./-]+)\s*$/gm)) roots.add(normalizeGraphPath(match[1]!));
  return { dir, sourceDirs: [...roots].map((root) => root.replace(/^\.\/?/, "").replace(/\/+$/, "")) };
}

/** Absolute directories a dotted Python module path may be rooted at, most
    specific first: every declared project source root. */
export function buildPythonSourceRoots(projects: Iterable<PythonProjectFacts>): string[] {
  const out = new Set<string>();
  for (const project of projects) {
    for (const sub of project.sourceDirs) {
      const joined = sub ? (project.dir ? `${project.dir}/${sub}` : sub) : project.dir;
      if (joined) out.add(joined);
    }
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
