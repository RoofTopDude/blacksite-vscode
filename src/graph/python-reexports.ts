/* Python package re-export resolution. A package's __init__.py commonly
   re-exports names from its submodules (`from .user import User`) so callers
   can write `from mypkg import User` instead of naming the concrete module.
   The plain import resolver binds such a call to the package's __init__.py and
   stops there — the concrete implementing file (and therefore the real fan-in
   on widely-used base classes / utilities) never gets an edge. This module
   builds a `package dir -> exported name -> concrete file` index so resolution
   can follow the re-export one hop to where the name actually lives. */

import { dirOf } from "./graph-model.js";
import { resolveSpecifier } from "./resolve-imports.js";

/* `from .sub import A, B as C` / `from .pkg.sub import (A, B)` — relative
   re-exports only (a package re-exports its own submodules). The names clause
   may span lines inside parentheses, so the capture crosses newlines and stops
   at the closing paren; an un-parenthesized clause stops at end-of-line. */
const PY_REEXPORT_RE = /^[ \t]*from[ \t]+(\.[.\w]*)[ \t]+import[ \t]+(\([\s\S]*?\)|[^\n#]+)/gm;

export interface PyReExport {
  /** The relative submodule the names come from, e.g. ".user" or ".sub.mod". */
  module: string;
  /** The names exposed at the package level (aliases resolved to the exposed
      name, so `X as Y` contributes "Y"). */
  names: string[];
}

/** Parse the relative re-export statements out of an __init__.py's content.
    Star re-exports (`from .sub import *`) are skipped — they expose an
    unknowable name set, so mapping any single name through them would be a
    guess. */
export function extractPyReExports(content: string): PyReExport[] {
  const out: PyReExport[] = [];
  PY_REEXPORT_RE.lastIndex = 0;
  for (let m = PY_REEXPORT_RE.exec(content); m !== null; m = PY_REEXPORT_RE.exec(content)) {
    const module = (m[1] ?? "").trim();
    const clause = (m[2] ?? "").replace(/[()]/g, "");
    if (clause.includes("*")) continue;
    const names = clause
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/).pop()?.trim() ?? "")
      .filter((name) => /^[A-Za-z_]\w*$/.test(name));
    if (module && names.length > 0) out.push({ module, names });
  }
  return out;
}

/** Index every package initializer's re-exports to the concrete files their
    names resolve to: `packageDir -> (exportedName -> [file, ...])`. Each
    relative module is resolved against the workspace file set once, so a lookup
    at resolution time is a plain map read. */
export function buildPyReExportIndex(
  initFiles: readonly { path: string; content: string }[],
  fileSet: ReadonlySet<string>,
): Map<string, Map<string, string[]>> {
  const index = new Map<string, Map<string, string[]>>();
  for (const { path, content } of initFiles) {
    const pkgDir = dirOf(path);
    for (const { module, names } of extractPyReExports(content)) {
      const target = resolveSpecifier(path, module, fileSet);
      if (!target || target === path) continue;
      let map = index.get(pkgDir);
      if (!map) { map = new Map(); index.set(pkgDir, map); }
      for (const name of names) {
        const list = map.get(name);
        if (list) { if (!list.includes(target)) list.push(target); }
        else map.set(name, [target]);
      }
    }
  }
  return index;
}
