/* Whole-codebase Python module-level name index: which file declares which
   top-level `def`/`class` name. Mirrors csharp-index.ts's shape — this is the
   same "does the referenced name actually live here" building block, applied
   to Python's star re-export idiom (see python-reexports.ts) instead of C#'s
   `using` namespace fan-out. Python has no equivalent deep-namespace-fanout
   problem, so unlike C# this only needs module-level (column-0) declarations,
   not a nested-scope precision gate. */

import { normalizeGraphPath } from "./graph-model.js";

export interface PythonIndexInput {
  path: string;
  content: string;
}

/** Module-level only: no leading whitespace, so a method inside a class or a
    closure inside a function is correctly excluded — those aren't names a
    `from pkg import *` can re-export. */
const DEF_RE = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm;
const CLASS_RE = /^class[ \t]+([A-Za-z_]\w*)/gm;

/** Extract the module-level `def`/`class` names one `.py` file declares. */
export function extractPythonTopLevelNames(content: string): string[] {
  const names = new Set<string>();
  DEF_RE.lastIndex = 0;
  for (let m = DEF_RE.exec(content); m !== null; m = DEF_RE.exec(content)) {
    if (m[1]) names.add(m[1]);
  }
  CLASS_RE.lastIndex = 0;
  for (let m = CLASS_RE.exec(content); m !== null; m = CLASS_RE.exec(content)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}

/** `filePath -> declared top-level names`, for resolving a star re-export
    (`from .sub import *`) to the concrete names `.sub` actually defines. */
export function buildPythonNameIndex(files: Iterable<PythonIndexInput>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const path = normalizeGraphPath(file.path);
    if (!path.toLowerCase().endsWith(".py")) continue;
    index.set(path, new Set(extractPythonTopLevelNames(file.content)));
  }
  return index;
}
