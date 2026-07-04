/* Shared low-level LSP capability layer. One home for the raw VS Code provider
   queries (symbols, references, implementations, call hierarchy, type
   hierarchy) with a common timeout + cold-server warmup, used by BOTH the agent
   tools (lsp-service.ts) and the Codebase Map's symbol layer (graph-provider).
   Keeping them in one place means a new provider capability lights up both
   consumers at once, and they can't drift apart.

   Most of this needs the vscode API and is exercised via integration, not unit
   tests; the genuinely pure bits (kind → relations, dedup keys) live at the
   bottom and are unit-tested. */

import * as vscode from "vscode";

/* Pure relation helpers live in a vscode-free module so they stay unit-testable;
   re-exported here so both consumers import everything from one place. */
export { relationsForKind, symbolEdgeKey, type SymbolRelation } from "./graph/symbol-relations.js";

export const LSP_TIMEOUT_MS = 9000;

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

/** Run a VS Code provider command with the shared timeout; resolves undefined
    on timeout or error rather than throwing. */
export function execProvider<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  return withTimeout(vscode.commands.executeCommand<T>(command, ...args), LSP_TIMEOUT_MS);
}

export interface WarmupOptions {
  tries?: number;
  delayMs?: number;
  signal?: AbortSignal;
}

/** Retry a query while it comes back empty — a just-activated language server
    often answers nothing for the first few hundred milliseconds. */
export async function withWarmup<T>(
  fn: () => Promise<T | undefined>,
  isEmpty: (r: T | undefined) => boolean,
  opts: WarmupOptions = {},
): Promise<T | undefined> {
  const tries = opts.tries ?? 5;
  const delayMs = opts.delayMs ?? 400;
  let r = await fn();
  for (let i = 0; i < tries && isEmpty(r); i += 1) {
    if (opts.signal?.aborted) break;
    await new Promise((res) => setTimeout(res, delayMs));
    r = await fn();
  }
  return r;
}

export type LspLocation = vscode.Location | vscode.LocationLink;

/** Normalize a Location or LocationLink to a plain uri+range. */
export function locationParts(loc: LspLocation): { uri: vscode.Uri; range: vscode.Range } {
  if ("targetUri" in loc) return { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange };
  return { uri: loc.uri, range: loc.range };
}

// ── Provider queries ─────────────────────────────────────────────────────────

export function documentSymbols(uri: vscode.Uri): Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined> {
  return execProvider("vscode.executeDocumentSymbolProvider", uri);
}

export async function references(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
  return (await execProvider<vscode.Location[]>("vscode.executeReferenceProvider", uri, position)) ?? [];
}

export async function implementations(uri: vscode.Uri, position: vscode.Position): Promise<LspLocation[]> {
  return (await execProvider<LspLocation[]>("vscode.executeImplementationProvider", uri, position)) ?? [];
}

/** Callees: the functions this symbol calls (outgoing edges). */
export async function outgoingCalls(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyOutgoingCall[]> {
  const items = await execProvider<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", uri, position);
  const root = items?.[0];
  if (!root) return [];
  return (await execProvider<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", root)) ?? [];
}

/** Callers: the functions that call this symbol (incoming edges). */
export async function incomingCalls(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyIncomingCall[]> {
  const items = await execProvider<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", uri, position);
  const root = items?.[0];
  if (!root) return [];
  return (await execProvider<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", root)) ?? [];
}

/** Supertypes: the classes/interfaces this type extends or implements. */
export async function supertypes(uri: vscode.Uri, position: vscode.Position): Promise<vscode.TypeHierarchyItem[]> {
  const items = await execProvider<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", uri, position);
  const root = items?.[0];
  if (!root) return [];
  return (await execProvider<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", root)) ?? [];
}

/** Subtypes: the classes/interfaces that extend or implement this type. */
export async function subtypes(uri: vscode.Uri, position: vscode.Position): Promise<vscode.TypeHierarchyItem[]> {
  const items = await execProvider<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", uri, position);
  const root = items?.[0];
  if (!root) return [];
  return (await execProvider<vscode.TypeHierarchyItem[]>("vscode.provideSubtypes", root)) ?? [];
}

export interface FlatSymbol {
  name: string;
  kind: number;
  container?: string;
  selection: vscode.Position;
  range: vscode.Range;
  uri: vscode.Uri;
}

function isDocumentSymbol(s: vscode.DocumentSymbol | vscode.SymbolInformation): s is vscode.DocumentSymbol {
  return (s as vscode.DocumentSymbol).selectionRange !== undefined;
}

/** Flatten a document-symbol tree (or flat SymbolInformation list) to a single
    array, threading dotted container names through nested symbols. */
export function flattenDocumentSymbols(
  list: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  fallbackUri: vscode.Uri,
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  const walk = (items: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[], container?: string): void => {
    for (const s of items) {
      if (isDocumentSymbol(s)) {
        out.push({ name: s.name, kind: s.kind, container, selection: s.selectionRange.start, range: s.range, uri: fallbackUri });
        if (s.children?.length) walk(s.children, container ? `${container}.${s.name}` : s.name);
      } else {
        out.push({
          name: s.name,
          kind: s.kind,
          container: s.containerName || undefined,
          selection: s.location.range.start,
          range: s.location.range,
          uri: s.location.uri,
        });
      }
    }
  };
  walk(list);
  return out;
}

