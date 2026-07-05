/* Pure tsconfig/jsconfig path-alias resolution for the Codebase Map.

   Modern TS/JS projects lean heavily on `compilerOptions.paths` + `baseUrl`
   (e.g. `@app/*`, `~/lib/*`, workspace-package names) instead of relative
   imports. Those specifiers are not relative, so the plain resolver drops them
   — and with them, a large share of the real file-to-file relationships in a
   monorepo. This module turns an alias specifier into the candidate workspace-
   relative *base* paths to probe; the caller (resolve-imports) does the actual
   extension/index probing against the real file set.

   Config paths here live in node-id space (workspace-relative, forward slashes,
   folder-qualified in multi-root); the host converts each config's directory to
   a node id before parsing, so this stays a pure function of strings. */

import { joinPosix, normalizeGraphPath } from "./graph-model.js";

export interface TsAliasConfig {
  /** Config directory in node-id space ("" = a root-level tsconfig). */
  dir: string;
  /** compilerOptions.baseUrl resolved to a node-id dir, or null when unset. */
  baseUrl: string | null;
  /** compilerOptions.paths, pattern → replacement list, exactly as written. */
  paths: Record<string, string[]>;
  /** Raw top-level `extends` value (unresolved), or null when absent. Resolving
      it to a workspace file requires the file set, which this pure per-file
      parser doesn't have — see `resolveExtends` + the host's chain-follow. */
  extends: string | null;
}

export interface TsAliasTable {
  /** Configs sorted nearest-first (longest dir), so a nested tsconfig wins. */
  configs: TsAliasConfig[];
}

/** Strip `//` and block comments and trailing commas so tsconfig's JSONC parses
    as JSON. String contents are preserved verbatim (a `//` inside a string is
    not a comment). Best-effort — malformed input just fails the later parse. */
export function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i += 1; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1; // skip the closing '/'
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Parse one tsconfig/jsconfig into an alias config, or null when it declares
    nothing that could rewrite a specifier (no baseUrl, no paths, no extends).
    `dir` is the config's directory in node-id space. Following `extends` (a
    single file's parse can't do it — that needs the workspace file set) is the
    host's job; see `resolveExtends` + `mergeExtendsChain`. */
export function parseTsconfig(dir: string, content: string): TsAliasConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(content));
  } catch {
    return null;
  }
  const root = parsed as { compilerOptions?: Record<string, unknown>; extends?: unknown } | null;
  if (!root || typeof root !== "object") return null;
  const co = root.compilerOptions;
  const extendsValue = typeof root.extends === "string" ? root.extends : null;

  const baseUrlRaw = co && typeof co === "object" && typeof co.baseUrl === "string" ? co.baseUrl : null;
  const baseUrl = baseUrlRaw !== null ? (joinPosix(dir, normalizeGraphPath(baseUrlRaw)) ?? dir) : null;

  const paths: Record<string, string[]> = {};
  const rawPaths = co && typeof co === "object" ? co.paths : undefined;
  if (rawPaths && typeof rawPaths === "object" && !Array.isArray(rawPaths)) {
    for (const [pattern, repls] of Object.entries(rawPaths as Record<string, unknown>)) {
      const list = asStringArray(repls);
      if (list.length > 0) paths[pattern] = list;
    }
  }

  if (baseUrl === null && Object.keys(paths).length === 0 && !extendsValue) return null;
  return { dir, baseUrl, paths, extends: extendsValue };
}

/** Resolve a tsconfig `extends` value to a workspace file, or null when it's a
    bare package specifier (e.g. `@tsconfig/node18`, not locally resolvable —
    consistent with this codebase's "only locally-resolvable references"
    scanning philosophy) or doesn't match a real file. `.json` is appended when
    the value omits an extension, matching tsc's own extends resolution. */
export function resolveExtends(dir: string, extendsValue: string, files: ReadonlySet<string>): string | null {
  const value = extendsValue.trim();
  if (!value.startsWith(".")) return null;
  const joined = joinPosix(dir, normalizeGraphPath(value));
  if (joined === null) return null;
  if (files.has(joined)) return joined;
  if (!joined.endsWith(".json") && files.has(`${joined}.json`)) return `${joined}.json`;
  return null;
}

/** Merge a chain of configs (root-most first, the extending project's own
    config last) into one effective config: a config's own baseUrl/paths win
    when it defines them, otherwise the nearest ancestor's are inherited. This
    doesn't deep-merge individual path patterns — it's the common case that
    matters: an Nx/Turborepo-style shared `tsconfig.base.json` declares every
    alias and per-package configs just `extends` it with none of their own. */
export function mergeExtendsChain(chain: readonly TsAliasConfig[]): TsAliasConfig {
  let baseUrl: string | null = null;
  let paths: Record<string, string[]> = {};
  for (const cfg of chain) {
    if (cfg.baseUrl !== null) baseUrl = cfg.baseUrl;
    if (Object.keys(cfg.paths).length > 0) paths = cfg.paths;
  }
  const leaf = chain[chain.length - 1]!;
  return { dir: leaf.dir, baseUrl, paths, extends: null };
}

/** Order configs nearest-first so a nested project's aliases take precedence. */
export function buildAliasTable(configs: readonly TsAliasConfig[]): TsAliasTable {
  return { configs: [...configs].sort((a, b) => b.dir.length - a.dir.length) };
}

function isAncestorDir(dir: string, fromPath: string): boolean {
  return dir === "" || fromPath === dir || fromPath.startsWith(`${dir}/`);
}

/** Candidate workspace-relative *base* paths (no extension applied) for an alias
    specifier, gathered from every config whose directory contains `fromPath`,
    nearest-first. Relative specifiers return nothing — those go through the
    normal relative resolver. Empty when no alias matches. */
export function aliasCandidates(fromPath: string, spec: string, table: TsAliasTable): string[] {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith(".")) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | null): void => {
    if (candidate !== null && candidate !== "" && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  };

  for (const cfg of table.configs) {
    if (!isAncestorDir(cfg.dir, fromPath)) continue;
    const baseDir = cfg.baseUrl ?? cfg.dir;
    for (const [pattern, repls] of Object.entries(cfg.paths)) {
      const star = pattern.indexOf("*");
      if (star >= 0) {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (trimmed.length >= prefix.length + suffix.length && trimmed.startsWith(prefix) && trimmed.endsWith(suffix)) {
          const captured = trimmed.slice(prefix.length, trimmed.length - suffix.length);
          for (const repl of repls) {
            const replaced = repl.includes("*") ? repl.replace("*", captured) : repl;
            push(joinPosix(baseDir, normalizeGraphPath(replaced)));
          }
        }
      } else if (trimmed === pattern) {
        for (const repl of repls) push(joinPosix(baseDir, normalizeGraphPath(repl)));
      }
    }
    /* baseUrl lets a bare specifier resolve as a root-relative module path. */
    if (cfg.baseUrl !== null) push(joinPosix(cfg.baseUrl, normalizeGraphPath(trimmed)));
  }
  return out;
}
