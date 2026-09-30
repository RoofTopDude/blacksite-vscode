/* Per-file facts: everything the import resolver needs from a file's *content*,
   extracted once and cached across reloads.

   A full rebuild used to read every file up to four times (the import scan,
   then the C#, PHP and Python name indexes), and every window reload started
   from nothing. Facts separate *extraction* (needs content; cached per file,
   keyed by mtime+size) from *resolution* (needs only facts plus the file set;
   cheap and in-memory). A warm start stats every file and reads only the ones
   that changed.

   The one subtle field is `refs` for C#/PHP: the PascalCase tokens a file
   uses, which the `using`/`use` resolver intersects with the types a namespace
   declares. Storing every token would bloat the cache, so they are filtered to
   the type short-names declared anywhere in the workspace at extraction time,
   and the cache remembers that set. If a later run declares a name the set
   lacked, cached refs could be missing it, so those files are re-read (see
   refsStillValid). Pure: no fs, no vscode. */

import { extractImports } from "./import-scan.js";
import { extractDocLinks } from "./doc-links.js";
import { langOf, normalizeGraphPath } from "./graph-model.js";
import { parseCSharpDeclarations, referencedTypeNames } from "./csharp-index.js";
import { parsePhpDeclarations, phpReferencedTypeNames } from "./php-index.js";
import { extractPythonTopLevelNames } from "./python-index.js";
import { extractPyReExports, type PyReExport } from "./python-reexports.js";
import { parseTsconfig, type TsAliasConfig } from "./tsconfig-paths.js";
import { parseGoMod, type GoModule } from "./go-modules.js";
import {
  parseCargoFacts,
  parsePackageJsonFacts,
  parsePythonProjectFacts,
  type JsPackageFacts,
  type PythonProjectFacts,
  type RustCrateFacts,
} from "./workspace-packages.js";
import { dirOf } from "./graph-model.js";

/** Bump when extraction changes shape or semantics; a mismatch discards the
    whole facts cache (it is derived, so that only costs one cold scan). */
export const FILE_FACTS_VERSION = 1;

export interface FileFacts {
  /** mtime (ms) and size at extraction — the cache key. */
  m: number;
  s: number;
  /** Raw import specifiers (extractImports), for non-doc files. */
  specs?: string[];
  /** Raw path-like references, for Markdown. */
  docLinks?: string[];
  /** C# / PHP declarations. */
  cs?: { namespaces: string[]; types: string[] };
  php?: { namespaces: string[]; types: string[] };
  /** C#/PHP PascalCase tokens, filtered to workspace-declared type names. */
  refs?: string[];
  /** Python module-level def/class names. */
  py?: string[];
  /** Python package re-exports (only for __init__.py). */
  pyRe?: PyReExport[];
  /** tsconfig/jsconfig parse. */
  tsconfig?: TsAliasConfig;
  go?: GoModule;
  pkg?: JsPackageFacts;
  cargo?: RustCrateFacts;
  pyproject?: PythonProjectFacts;
  /** Transient (never persisted): unfiltered C#/PHP tokens between the read
      pass and the filter pass. */
  rawRefs?: Set<string>;
}

export interface FactsCacheDocument {
  version: number;
  /** Type short-names the stored `refs` were filtered against. */
  csNames: string[];
  phpNames: string[];
  files: Record<string, FileFacts>;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

/** Extract facts for one file. `content` is whatever the reader produced (it
    may be empty for an unreadable or oversized file; facts then carry only
    the key, and the file simply contributes no edges). */
export function extractFileFacts(relPath: string, content: string, mtimeMs: number, size: number): FileFacts {
  const rel = normalizeGraphPath(relPath);
  const lang = langOf(rel);
  const name = basename(rel);
  const facts: FileFacts = { m: mtimeMs, s: size };
  if (!content) return facts;
  if (lang === "md") {
    const links = extractDocLinks(content);
    if (links.length > 0) facts.docLinks = links;
  } else {
    const specs = extractImports(rel, content);
    if (specs.length > 0) facts.specs = specs;
  }
  if (lang === "cs") {
    const decl = parseCSharpDeclarations(content);
    if (decl.namespaces.length || decl.types.length) facts.cs = decl;
    facts.rawRefs = referencedTypeNames(content);
  } else if (lang === "php") {
    const decl = parsePhpDeclarations(content);
    if (decl.namespaces.length || decl.types.length) facts.php = decl;
    facts.rawRefs = phpReferencedTypeNames(content);
  } else if (lang === "py") {
    const names = extractPythonTopLevelNames(content);
    if (names.length > 0) facts.py = names;
    if (name === "__init__.py") {
      const re = extractPyReExports(content);
      if (re.length > 0) facts.pyRe = re;
    }
  }
  if (name === "tsconfig.json" || name === "jsconfig.json") {
    const cfg = parseTsconfig(dirOf(rel), content);
    if (cfg) facts.tsconfig = cfg;
  } else if (name === "package.json") {
    const pkg = parsePackageJsonFacts(rel, content);
    if (pkg) facts.pkg = pkg;
  } else if (name === "go.mod") {
    const mod = parseGoMod(dirOf(rel), content);
    if (mod) facts.go = mod;
  } else if (name === "cargo.toml") {
    const crate = parseCargoFacts(rel, content);
    if (crate) facts.cargo = crate;
  } else if (name === "pyproject.toml" || name === "setup.cfg") {
    facts.pyproject = parsePythonProjectFacts(rel, content);
  }
  return facts;
}

/** Declared type short-names across the workspace, per language. */
export function declaredTypeNames(facts: ReadonlyMap<string, FileFacts>): { cs: Set<string>; php: Set<string> } {
  const cs = new Set<string>();
  const php = new Set<string>();
  for (const entry of facts.values()) {
    for (const type of entry.cs?.types ?? []) cs.add(type.slice(type.lastIndexOf(".") + 1));
    for (const type of entry.php?.types ?? []) php.add(type.slice(type.lastIndexOf("\\") + 1));
  }
  return { cs, php };
}

/** Turn each freshly-read file's transient rawRefs into persisted `refs`. */
export function finalizeRefs(facts: Map<string, FileFacts>, names: { cs: ReadonlySet<string>; php: ReadonlySet<string> }): void {
  for (const [path, entry] of facts) {
    if (!entry.rawRefs) continue;
    const allowed = langOf(path) === "cs" ? names.cs : names.php;
    const refs = [...entry.rawRefs].filter((token) => allowed.has(token)).sort();
    delete entry.rawRefs;
    if (refs.length > 0) entry.refs = refs;
    else delete entry.refs;
  }
}

/** Cached refs stay exact while every name declared now was already in the
    set they were filtered against. */
export function refsStillValid(cachedNames: readonly string[], current: ReadonlySet<string>): boolean {
  const cached = new Set(cachedNames);
  for (const name of current) if (!cached.has(name)) return false;
  return true;
}

export function serializeFacts(facts: ReadonlyMap<string, FileFacts>, names: { cs: ReadonlySet<string>; php: ReadonlySet<string> }): string {
  const files: Record<string, FileFacts> = {};
  for (const [path, entry] of facts) {
    const { rawRefs: _transient, ...rest } = entry;
    files[path] = rest;
  }
  const doc: FactsCacheDocument = {
    version: FILE_FACTS_VERSION,
    csNames: [...names.cs].sort(),
    phpNames: [...names.php].sort(),
    files,
  };
  return JSON.stringify(doc);
}

export function parseFactsCache(raw: unknown): FactsCacheDocument | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const doc = raw as Partial<FactsCacheDocument>;
  if (doc.version !== FILE_FACTS_VERSION) return null;
  if (!doc.files || typeof doc.files !== "object") return null;
  return {
    version: FILE_FACTS_VERSION,
    csNames: Array.isArray(doc.csNames) ? doc.csNames.filter((n): n is string => typeof n === "string") : [],
    phpNames: Array.isArray(doc.phpNames) ? doc.phpNames.filter((n): n is string => typeof n === "string") : [],
    files: doc.files as Record<string, FileFacts>,
  };
}
