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
      name, so `X as Y` contributes "Y"). Empty when `star` is true — the
      concrete names are only known once `module` is resolved to a file. */
  names: string[];
  /** `from .sub import *` — every top-level public name `.sub` declares is
      re-exported, resolved via the Python name index (python-index.ts). */
  star?: boolean;
}

/** Parse the relative re-export statements out of an __init__.py's content,
    including star re-exports (`from .sub import *`) — extremely common in
    package initializers and previously skipped outright, which meant `from
    pkg import Name` dead-ended at pkg/__init__.py instead of reaching the
    concrete submodule for the majority-common case. */
export function extractPyReExports(content: string): PyReExport[] {
  const out: PyReExport[] = [];
  PY_REEXPORT_RE.lastIndex = 0;
  for (let m = PY_REEXPORT_RE.exec(content); m !== null; m = PY_REEXPORT_RE.exec(content)) {
    const module = (m[1] ?? "").trim();
    if (!module) continue;
    const clause = (m[2] ?? "").replace(/[()]/g, "").trim();
    if (clause === "*") {
      out.push({ module, names: [], star: true });
      continue;
    }
    const names = clause
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/).pop()?.trim() ?? "")
      .filter((name) => /^[A-Za-z_]\w*$/.test(name));
    if (names.length > 0) out.push({ module, names });
  }
  return out;
}

/** Index every package initializer's re-exports to the concrete files their
    names resolve to: `packageDir -> (exportedName -> [file, ...])`. Each
    relative module is resolved against the workspace file set once, so a lookup
    at resolution time is a plain map read. A star re-export resolves its
    target module one hop, then contributes every non-`_`-prefixed top-level
    name that module's own python-index entry declares — private-by-convention
    names are excluded since `import *` never re-exports them either. */
export function buildPyReExportIndex(
  initFiles: readonly { path: string; content: string }[],
  fileSet: ReadonlySet<string>,
  /** Pre-built module-name index (see python-index.ts's buildPythonNameIndex)
      used to resolve star re-exports. Omit when the caller has no need for
      `from .sub import *` support (it simply resolves to no names, same as
      before this index existed). */
  pythonIndex?: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Map<string, string[]>> {
  const index = new Map<string, Map<string, string[]>>();
  const nameIndex: ReadonlyMap<string, ReadonlySet<string>> = pythonIndex ?? new Map();
  for (const { path, content } of initFiles) {
    const pkgDir = dirOf(path);
    for (const entry of extractPyReExports(content)) {
      const target = resolveSpecifier(path, entry.module, fileSet);
      if (!target || target === path) continue;
      const names = entry.star
        ? [...(nameIndex.get(target) ?? [])].filter((name) => !name.startsWith("_"))
        : entry.names;
      if (names.length === 0) continue;
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
