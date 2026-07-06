import { normalizeGraphPath } from "./graph-model.js";

export interface CSharpIndex {
  /** Exact namespace -> files declaring it. */
  byNamespace: ReadonlyMap<string, string[]>;
  /** Exact fully-qualified type name -> files declaring it. */
  byType: ReadonlyMap<string, string[]>;
  /** namespace -> (declared type short-name -> files declaring it). Lets a
      `using <namespace>;` resolve to only the types the consuming file actually
      references, instead of fanning out to every file in the namespace (the
      cause of the 600+ imported-by hairballs on EF/data-layer namespaces). */
  typesByNamespace: ReadonlyMap<string, ReadonlyMap<string, string[]>>;
}

export interface CSharpIndexInput {
  path: string;
  content: string;
}

const DECL_RE = /\bnamespace\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*[;{]|\b(?:class|struct|interface|enum)\s+([A-Za-z_]\w*)|\brecord\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)/g;

function pushUnique(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return;
  }
  if (!list.includes(value)) list.push(value);
}

function normalizeReference(value: string): string {
  return value.trim().replace(/^global::/, "").replace(/<[^>]+>/g, "");
}

/** Best-effort namespace/type extraction for `.cs` files. Good enough for the
    map's dependency skeleton: one file can contribute one or more namespace
    declarations and any type declarations that follow them. */
export function parseCSharpDeclarations(content: string): { namespaces: string[]; types: string[] } {
  const namespaces = new Set<string>();
  const types = new Set<string>();
  let currentNamespace = "";
  DECL_RE.lastIndex = 0;
  for (let m = DECL_RE.exec(content); m !== null; m = DECL_RE.exec(content)) {
    const namespaceName = normalizeReference(m[1] ?? "");
    if (namespaceName) {
      currentNamespace = namespaceName;
      namespaces.add(namespaceName);
      continue;
    }
    const typeName = normalizeReference(m[2] ?? m[3] ?? "");
    if (typeName && currentNamespace) types.add(`${currentNamespace}.${typeName}`);
  }
  return { namespaces: [...namespaces], types: [...types] };
}

export function buildCSharpIndex(files: Iterable<CSharpIndexInput>): CSharpIndex {
  const byNamespace = new Map<string, string[]>();
  const byType = new Map<string, string[]>();
  const typesByNamespace = new Map<string, Map<string, string[]>>();
  for (const file of files) {
    const path = normalizeGraphPath(file.path);
    if (!path.toLowerCase().endsWith(".cs")) continue;
    const declarations = parseCSharpDeclarations(file.content);
    for (const namespaceName of declarations.namespaces) pushUnique(byNamespace, namespaceName, path);
    for (const typeName of declarations.types) {
      pushUnique(byType, typeName, path);
      /* parseCSharpDeclarations emits types as "<namespace>.<TypeName>" where
         <TypeName> is a single identifier, so the last dot splits the two. */
      const dot = typeName.lastIndexOf(".");
      if (dot <= 0) continue;
      const namespaceName = typeName.slice(0, dot);
      const shortName = typeName.slice(dot + 1);
      let nsTypes = typesByNamespace.get(namespaceName);
      if (!nsTypes) { nsTypes = new Map(); typesByNamespace.set(namespaceName, nsTypes); }
      pushUnique(nsTypes, shortName, path);
    }
  }
  return { byNamespace, byType, typesByNamespace };
}

/* Type-usage heuristic: any PascalCase identifier is a candidate type reference.
   Over-matches (method names, enum members), but the caller only keeps ones that
   also match a declared type short-name, so noise costs nothing — and this is far
   better than treating a `using` as a reference to every file in the namespace. */
const PASCAL_TOKEN_RE = /\b([A-Z][A-Za-z0-9_]*)\b/g;
const MAX_REFERENCE_SCAN_CHARS = 512_000;

/** Set of PascalCase identifiers referenced in a `.cs` file's body — the
    candidate type names a `using` resolver intersects against a namespace's
    declared types to pick only the files actually depended on. */
export function referencedTypeNames(content: string): Set<string> {
  const out = new Set<string>();
  const body = content.length > MAX_REFERENCE_SCAN_CHARS ? content.slice(0, MAX_REFERENCE_SCAN_CHARS) : content;
  PASCAL_TOKEN_RE.lastIndex = 0;
  for (let m = PASCAL_TOKEN_RE.exec(body); m !== null; m = PASCAL_TOKEN_RE.exec(body)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}
