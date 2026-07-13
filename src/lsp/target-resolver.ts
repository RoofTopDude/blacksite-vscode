import * as vscode from "vscode";
import type { ProviderOutcome } from "./provider-executor.js";
import { providerFailureMessage } from "./provider-executor.js";
import type { WorkspacePath } from "./workspace-identity.js";
import { WorkspaceIdentity } from "./workspace-identity.js";

export interface CodeTarget {
  path: string;
  rootId?: string;
  symbol?: string;
  kind?: string;
  line?: number;
  column?: number;
  matchText?: string;
  firstMatch?: boolean;
}

export interface FlatCodeSymbol {
  name: string;
  kind: number;
  kindName: string;
  container?: string;
  selection: vscode.Position;
  range: vscode.Range;
  uri: vscode.Uri;
}

export interface SymbolCandidate {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  path: string;
  rootId?: string;
  line: number;
  endLine: number;
  container?: string;
}

export interface ResolvedCodeTarget {
  ok: true;
  workspacePath: WorkspacePath;
  uri: vscode.Uri;
  doc: vscode.TextDocument;
  documentVersion: number;
  position: vscode.Position;
  range: vscode.Range;
  confidence: "exact-symbol" | "exact-text" | "explicit-position" | "line-anchor";
  symbolName?: string;
  symbol?: SymbolCandidate;
}

export interface TargetResolutionError {
  ok: false;
  error: string;
  ambiguous?: boolean;
  candidates?: SymbolCandidate[];
  rootCandidates?: Array<{ rootId: string; path: string }>;
}

export type TargetResolution = ResolvedCodeTarget | TargetResolutionError;
export type SymbolLoader = (uri: vscode.Uri, signal?: AbortSignal) => Promise<ProviderOutcome<FlatCodeSymbol[]>>;

export class TargetResolver {
  constructor(
    private readonly _identity: WorkspaceIdentity,
    private readonly _loadSymbols: SymbolLoader,
  ) {}

  async resolve(
    target: CodeTarget,
    opts: { signal?: AbortSignal; mutation?: boolean } = {},
  ): Promise<TargetResolution> {
    if (opts.mutation && target.firstMatch) {
      return { ok: false, error: "firstMatch:true is not allowed for mutations; select an exact symbol candidate instead." };
    }
    const pathResolution = this._identity.resolve(target.path, target.rootId);
    if (!pathResolution.ok) {
      return {
        ok: false,
        error: pathResolution.error,
        ambiguous: pathResolution.ambiguous,
        rootCandidates: pathResolution.candidates,
      };
    }
    const workspacePath = pathResolution.value;

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(workspacePath.uri);
    } catch {
      return { ok: false, error: `Could not open ${target.path}.` };
    }

    if (target.symbol) {
      const outcome = await this._loadSymbols(workspacePath.uri, opts.signal);
      if (outcome.status !== "ok") return { ok: false, error: providerFailureMessage("document symbol", outcome) };
      const allMatches = outcome.value.filter((symbol) => symbolMatches(symbol, target.symbol!, target.kind));
      if (allMatches.length === 0) {
        return {
          ok: false,
          error: `Symbol '${target.symbol}' was not found in ${target.path}.`,
          candidates: outcome.value.slice(0, 12).map((symbol) => this.toCandidate(symbol)),
        };
      }

      let matches = allMatches;
      if (target.line !== undefined) {
        const lineError = validatePositiveInteger(target.line, "line");
        if (lineError) return { ok: false, error: lineError };
        const lineIndex = target.line - 1;
        const onLine = matches.filter((symbol) => symbol.selection.line === lineIndex || symbol.range.contains(new vscode.Position(lineIndex, 0)));
        if (onLine.length > 0) matches = onLine;
      }

      if (matches.length > 1 && !target.firstMatch) {
        return {
          ok: false,
          ambiguous: true,
          error: `'${target.symbol}' matches ${matches.length} symbols in ${target.path}. Select a candidate by qualified name, kind, or exact line.`,
          candidates: matches.map((symbol) => this.toCandidate(symbol)),
        };
      }

      const selected = matches[0]!;
      const candidate = this.toCandidate(selected);
      return {
        ok: true,
        workspacePath,
        uri: workspacePath.uri,
        doc,
        documentVersion: doc.version,
        position: selected.selection,
        range: selected.range,
        confidence: "exact-symbol",
        symbolName: selected.name,
        symbol: candidate,
      };
    }

    if (target.line === undefined) return { ok: false, error: "Provide `symbol` or `line` in target." };
    const lineError = validatePositiveInteger(target.line, "line");
    if (lineError) return { ok: false, error: lineError };
    const lineIndex = target.line - 1;
    if (lineIndex >= doc.lineCount) {
      return { ok: false, error: `Line ${target.line} is out of range (${doc.lineCount} lines in ${target.path}).` };
    }

    const lineText = doc.lineAt(lineIndex).text;
    let column: number;
    let confidence: ResolvedCodeTarget["confidence"];
    if (target.matchText !== undefined) {
      if (!target.matchText) return { ok: false, error: "matchText must not be empty." };
      const index = lineText.indexOf(target.matchText);
      if (index < 0) {
        return {
          ok: false,
          error: `matchText '${target.matchText}' was not found on ${target.path}:${target.line}. Current line: ${JSON.stringify(lineText)}`,
        };
      }
      column = index;
      confidence = "exact-text";
    } else if (target.column !== undefined) {
      const columnError = validatePositiveInteger(target.column, "column");
      if (columnError) return { ok: false, error: columnError };
      if (target.column > lineText.length + 1) {
        return { ok: false, error: `Column ${target.column} is out of range for ${target.path}:${target.line} (${lineText.length + 1} maximum).` };
      }
      column = target.column - 1;
      confidence = "explicit-position";
    } else {
      column = firstNonWhitespace(lineText);
      confidence = "line-anchor";
    }

    return {
      ok: true,
      workspacePath,
      uri: workspacePath.uri,
      doc,
      documentVersion: doc.version,
      position: new vscode.Position(lineIndex, column),
      range: new vscode.Range(lineIndex, 0, lineIndex, lineText.length),
      confidence,
    };
  }

  private toCandidate(symbol: FlatCodeSymbol): SymbolCandidate {
    const identity = this._identity.fromUri(symbol.uri);
    const qualifiedName = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
    const display = identity.ok ? this._identity.display(identity.value) : { path: symbol.uri.fsPath };
    return {
      id: `${symbol.uri.toString()}#${symbol.selection.line + 1}:${symbol.selection.character + 1}:${symbol.kind}:${qualifiedName}`,
      name: symbol.name,
      qualifiedName,
      kind: symbol.kindName,
      path: display.path,
      rootId: display.rootId,
      line: symbol.selection.line + 1,
      endLine: symbol.range.end.line + 1,
      container: symbol.container,
    };
  }
}

function symbolMatches(symbol: FlatCodeSymbol, requested: string, kind?: string): boolean {
  const qualified = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
  const nameMatches = symbol.name === requested || qualified === requested || qualified.endsWith(`.${requested}`);
  return nameMatches && (!kind || symbol.kindName.toLowerCase() === kind.toLowerCase());
}

function validatePositiveInteger(value: number, field: string): string | undefined {
  if (!Number.isInteger(value) || value < 1) return `${field} must be a positive 1-based integer.`;
  return undefined;
}

function firstNonWhitespace(value: string): number {
  const index = value.search(/\S/);
  return index < 0 ? 0 : index;
}
