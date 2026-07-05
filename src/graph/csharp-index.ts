import { normalizeGraphPath } from "./graph-model.js";

export interface CSharpIndex {
  /** Exact namespace -> files declaring it. */
  byNamespace: ReadonlyMap<string, string[]>;
  /** Exact fully-qualified type name -> files declaring it. */
  byType: ReadonlyMap<string, string[]>;
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
  for (const file of files) {
    const path = normalizeGraphPath(file.path);
    if (!path.toLowerCase().endsWith(".cs")) continue;
    const declarations = parseCSharpDeclarations(file.content);
    for (const namespaceName of declarations.namespaces) pushUnique(byNamespace, namespaceName, path);
    for (const typeName of declarations.types) pushUnique(byType, typeName, path);
  }
  return { byNamespace, byType };
}
