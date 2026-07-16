/* Whole-codebase PHP namespace/type index — the PSR-4 counterpart to
   csharp-index.ts, same shape (byNamespace / byType / typesByNamespace) and
   same size-gated fan-out rationale: a `use` on a small namespace is cheap
   and safe to fan out to every declaring file; a large namespace only wires
   to files declaring a type the consuming file actually references. */

import { normalizeGraphPath } from "./graph-model.js";

export interface PhpIndex {
  /** Exact namespace -> files declaring it. */
  byNamespace: ReadonlyMap<string, string[]>;
  /** Exact fully-qualified type name -> files declaring it. */
  byType: ReadonlyMap<string, string[]>;
  /** namespace -> (declared type short-name -> files declaring it). */
  typesByNamespace: ReadonlyMap<string, ReadonlyMap<string, string[]>>;
}

export interface PhpIndexInput {
  path: string;
  content: string;
}

/* PHP's namespace separator is `\`, not `.`. `enum` (PHP 8.1+) is a type
   declaration exactly like class/interface/trait for this purpose. */
const DECL_RE = /\bnamespace\s+([A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*)\s*[;{]|\b(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/g;

function pushUnique(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return;
  }
  if (!list.includes(value)) list.push(value);
}

/** Best-effort namespace/type extraction for `.php` files. A file's own
    namespace declaration applies to every type below it, same as C#. PHP
    convention is one namespace per file (PSR-4), but a legacy multi-namespace
    file with the block `namespace X { ... }` form is still handled correctly
    since DECL_RE tracks the current namespace as it scans. */
export function parsePhpDeclarations(content: string): { namespaces: string[]; types: string[] } {
  const namespaces = new Set<string>();
  const types = new Set<string>();
  let currentNamespace = "";
  DECL_RE.lastIndex = 0;
  for (let m = DECL_RE.exec(content); m !== null; m = DECL_RE.exec(content)) {
    const namespaceName = (m[1] ?? "").trim();
    if (namespaceName) {
      currentNamespace = namespaceName;
      namespaces.add(namespaceName);
      continue;
    }
    const typeName = (m[2] ?? "").trim();
    if (typeName && currentNamespace) types.add(`${currentNamespace}\\${typeName}`);
  }
  return { namespaces: [...namespaces], types: [...types] };
}

export function buildPhpIndex(files: Iterable<PhpIndexInput>): PhpIndex {
  const byNamespace = new Map<string, string[]>();
  const byType = new Map<string, string[]>();
  const typesByNamespace = new Map<string, Map<string, string[]>>();
  for (const file of files) {
    const path = normalizeGraphPath(file.path);
    if (!path.toLowerCase().endsWith(".php")) continue;
    const declarations = parsePhpDeclarations(file.content);
    for (const namespaceName of declarations.namespaces) pushUnique(byNamespace, namespaceName, path);
    for (const typeName of declarations.types) {
      pushUnique(byType, typeName, path);
      /* parsePhpDeclarations emits types as "<namespace>\<TypeName>" where
         <TypeName> is a single identifier, so the last backslash splits the two. */
      const sep = typeName.lastIndexOf("\\");
      if (sep <= 0) continue;
      const namespaceName = typeName.slice(0, sep);
      const shortName = typeName.slice(sep + 1);
      let nsTypes = typesByNamespace.get(namespaceName);
      if (!nsTypes) { nsTypes = new Map(); typesByNamespace.set(namespaceName, nsTypes); }
      pushUnique(nsTypes, shortName, path);
    }
  }
  return { byNamespace, byType, typesByNamespace };
}

/* Type-usage heuristic, identical in spirit to csharp-index.ts's
   referencedTypeNames: any PascalCase-ish identifier is a candidate type
   reference. Over-matches (method names, class constants), but the caller
   only keeps ones that also match a declared type short-name in the target
   namespace, so noise costs nothing. */
const PASCAL_TOKEN_RE = /\b([A-Z][A-Za-z0-9_]*)\b/g;
const MAX_REFERENCE_SCAN_CHARS = 512_000;

/** Set of PascalCase-ish identifiers referenced in a `.php` file's body — the
    candidate type names a `use` resolver intersects against a namespace's
    declared types to pick only the files actually depended on. */
export function phpReferencedTypeNames(content: string): Set<string> {
  const out = new Set<string>();
  const body = content.length > MAX_REFERENCE_SCAN_CHARS ? content.slice(0, MAX_REFERENCE_SCAN_CHARS) : content;
  PASCAL_TOKEN_RE.lastIndex = 0;
  for (let m = PASCAL_TOKEN_RE.exec(body); m !== null; m = PASCAL_TOKEN_RE.exec(body)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}
