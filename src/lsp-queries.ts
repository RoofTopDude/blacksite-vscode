import * as vscode from "vscode";
import { ProviderExecutor, type ProviderOutcome } from "./lsp/provider-executor.js";

export { relationsForKind, symbolEdgeKey, type SymbolRelation } from "./graph/symbol-relations.js";
export type { ProviderOutcome } from "./lsp/provider-executor.js";

export const LSP_TIMEOUT_MS = 9_000;
const executor = new ProviderExecutor();

export interface QueryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  delayMs?: number;
  totalTimeoutMs?: number;
}

export function execProvider<T>(
  command: string,
  args: unknown[] = [],
  opts: QueryOptions & { isEmpty?: (value: T) => boolean } = {},
): Promise<ProviderOutcome<T>> {
  return executor.execute(command, args, {
    signal: opts.signal,
    maxAttempts: opts.maxAttempts,
    delayMs: opts.delayMs,
    totalTimeoutMs: opts.totalTimeoutMs ?? LSP_TIMEOUT_MS,
    isEmpty: opts.isEmpty,
  });
}

export type LspLocation = vscode.Location | vscode.LocationLink;

export function locationParts(loc: LspLocation): { uri: vscode.Uri; range: vscode.Range } {
  if ("targetUri" in loc) return { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange };
  return { uri: loc.uri, range: loc.range };
}

export function documentSymbols(
  uri: vscode.Uri,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>> {
  return execProvider("vscode.executeDocumentSymbolProvider", [uri], {
    ...opts,
    maxAttempts: opts.maxAttempts ?? 3,
    isEmpty: (value) => value.length === 0,
  });
}

export function references(
  uri: vscode.Uri,
  position: vscode.Position,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<vscode.Location[]>> {
  return execProvider("vscode.executeReferenceProvider", [uri, position], opts);
}

export function implementations(
  uri: vscode.Uri,
  position: vscode.Position,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<LspLocation[]>> {
  return execProvider("vscode.executeImplementationProvider", [uri, position], opts);
}

export async function outgoingCalls(
  uri: vscode.Uri,
  position: vscode.Position,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<vscode.CallHierarchyOutgoingCall[]>> {
  const prepared = await execProvider<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", [uri, position], opts);
  if (prepared.status !== "ok") return prepared;
  const root = prepared.value[0];
  if (!root) return emptyFrom(prepared);
  return execProvider("vscode.provideOutgoingCalls", [root], opts);
}

export async function incomingCalls(
  uri: vscode.Uri,
  position: vscode.Position,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<vscode.CallHierarchyIncomingCall[]>> {
  const prepared = await execProvider<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", [uri, position], opts);
  if (prepared.status !== "ok") return prepared;
  const root = prepared.value[0];
  if (!root) return emptyFrom(prepared);
  return execProvider("vscode.provideIncomingCalls", [root], opts);
}

export async function supertypes(
  uri: vscode.Uri,
  position: vscode.Position,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<vscode.TypeHierarchyItem[]>> {
  const prepared = await execProvider<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", [uri, position], opts);
  if (prepared.status !== "ok") return prepared;
  const root = prepared.value[0];
  if (!root) return emptyFrom(prepared);
  return execProvider("vscode.provideSupertypes", [root], opts);
}

export async function subtypes(
  uri: vscode.Uri,
  position: vscode.Position,
  opts: QueryOptions = {},
): Promise<ProviderOutcome<vscode.TypeHierarchyItem[]>> {
  const prepared = await execProvider<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", [uri, position], opts);
  if (prepared.status !== "ok") return prepared;
  const root = prepared.value[0];
  if (!root) return emptyFrom(prepared);
  return execProvider("vscode.provideSubtypes", [root], opts);
}

export interface FlatSymbol {
  name: string;
  kind: number;
  container?: string;
  selection: vscode.Position;
  range: vscode.Range;
  uri: vscode.Uri;
}

export function flattenDocumentSymbols(
  list: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  fallbackUri: vscode.Uri,
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  const walk = (items: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[], container?: string): void => {
    for (const symbol of items) {
      if (isDocumentSymbol(symbol)) {
        out.push({
          name: symbol.name,
          kind: symbol.kind,
          container,
          selection: symbol.selectionRange.start,
          range: symbol.range,
          uri: fallbackUri,
        });
        if (symbol.children?.length) walk(symbol.children, container ? `${container}.${symbol.name}` : symbol.name);
      } else {
        out.push({
          name: symbol.name,
          kind: symbol.kind,
          container: symbol.containerName || undefined,
          selection: symbol.location.range.start,
          range: symbol.location.range,
          uri: symbol.location.uri,
        });
      }
    }
  };
  walk(list);
  return out;
}

function emptyFrom<T>(outcome: Extract<ProviderOutcome<unknown>, { status: "ok" }>): ProviderOutcome<T[]> {
  return {
    status: "ok",
    value: [],
    durationMs: outcome.durationMs,
    attempts: outcome.attempts,
    warmedUp: outcome.warmedUp,
  };
}

function isDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.DocumentSymbol {
  return (symbol as vscode.DocumentSymbol).selectionRange !== undefined;
}

