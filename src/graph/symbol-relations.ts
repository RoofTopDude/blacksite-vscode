/* Pure symbol-relation helpers, split out from lsp-queries.ts so they carry no
   vscode dependency and can be unit-tested. Shared by the agent LSP layer and
   the Codebase Map. */

export type SymbolRelation = "reference" | "call" | "implements" | "extends";

/** The extra (beyond plain references) relations worth querying for a symbol of
    the given kind name: callables get call edges, types get inheritance edges.
    Keeps LSP work off symbols where such a relation can't exist. */
export function relationsForKind(kindName: string): SymbolRelation[] {
  const k = kindName.toLowerCase();
  if (k === "function" || k === "method" || k === "constructor") return ["call"];
  if (k === "class" || k === "interface" || k === "struct" || k === "enum") return ["extends"];
  return [];
}

/** Stable dedup key for a symbol relation edge. */
export function symbolEdgeKey(from: string, toPath: string, relation: SymbolRelation, toSymbol?: string): string {
  return `${from}|${relation}|${toPath}|${toSymbol ?? ""}`;
}
