import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { EditApprovalProvider, WorkspaceEditApplier } from "./workspace-edit-applier.js";
import { captureDiagnosticBaseline, collectDiagnosticSnapshot, collectForUris } from "./post-edit-diagnostics.js";
import { formatActiveSignature } from "./lsp-signature-format.js";
import { missingExtensionFor } from "./graph/language-support.js";
import { noProviderNotice } from "./lsp-provider-hint.js";
import { ActionRegistry } from "./lsp/action-registry.js";
import { MutationCoordinator } from "./lsp/mutation-coordinator.js";
import { inspectWorkspaceEdit, type InspectedResourceOperation } from "./lsp/workspace-edit-inspector.js";
import {
  ProviderExecutor,
  providerFailureMessage,
  providerMetadata,
  type ProviderOutcome,
} from "./lsp/provider-executor.js";
import {
  TargetResolver,
  type CodeTarget,
  type FlatCodeSymbol,
  type ResolvedCodeTarget,
  type TargetResolutionError,
} from "./lsp/target-resolver.js";
import { WorkspaceIdentity } from "./lsp/workspace-identity.js";

// ── Public surface (keeps vscode types out of AgentSession) ──────────────────

export interface LspContext {
  autoApprove: boolean;
  signal?: AbortSignal;
  transactionId?: string;
  /** Request-local reviewer for unattended mutations. */
  approvalProvider?: EditApprovalProvider;
  showPreview?: boolean;
}

export interface SymbolRef {
  id?: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  path: string;
  rootId?: string;
  line: number;
  endLine?: number;
  container?: string;
}

export type LspResult =
  | { ok: true; notice?: string; [key: string]: unknown }
  | { ok: false; error: string; ambiguous?: boolean; candidates?: unknown[]; [key: string]: unknown };

export interface LspProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult>;
}

// ── Internal types ───────────────────────────────────────────────────────────

type Target = CodeTarget;

interface CodeLocation {
  path: string;
  rootId?: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  snippet: string;
  symbol?: string;
  kind?: string;
}

type Resolved = ResolvedCodeTarget;

type CommandOutcome = ProviderOutcome<unknown> & { touchedUris: vscode.Uri[]; commandRejected?: boolean; saved?: boolean };

interface HierarchyRelative {
  item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem;
  callCount?: number;
  callSites?: Array<{ line: number; column: number; endLine: number; endColumn: number }>;
}

type SymbolCache = Map<string, Promise<FlatCodeSymbol[]>>;

const MAX_RESULTS = 100;
const HARD_MAX = 500;
const MAX_HIERARCHY_DEPTH = 4;
const HIERARCHY_TOTAL_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,pyi,rs,go,java,kt,kts,cs,cpp,cc,cxx,c,h,hpp,swift,rb,php,vue,svelte}";
const DIAGNOSTIC_EXCLUDE_GLOB = "**/{node_modules,.git,out,dist,build,coverage,vendor,target,.venv,venv}/**";
const NAV_COMMANDS: Record<string, string> = {
  definition:     "vscode.executeDefinitionProvider",
  typeDefinition: "vscode.executeTypeDefinitionProvider",
  declaration:    "vscode.executeDeclarationProvider",
  implementation: "vscode.executeImplementationProvider",
  references:     "vscode.executeReferenceProvider",
};
const SYMBOL_KIND_NAMES = [
  "file", "module", "namespace", "package", "class", "method", "property", "field",
  "constructor", "enum", "interface", "function", "variable", "constant", "string",
  "number", "boolean", "array", "object", "key", "null", "enum-member", "struct",
  "event", "operator", "type-parameter",
];

// ── LspService ───────────────────────────────────────────────────────────────

export class LspService implements LspProvider {
  private readonly _identity: WorkspaceIdentity;
  private readonly _providers = new ProviderExecutor();
  private readonly _targets: TargetResolver;
  private readonly _actionsRegistry = new ActionRegistry();
  private readonly _mutations: MutationCoordinator;

  constructor(
    private readonly _workspaceRoot: string,
    private readonly _applier: WorkspaceEditApplier,
  ) {
    this._identity = new WorkspaceIdentity(_workspaceRoot);
    this._targets = new TargetResolver(this._identity, (uri, signal) => this._loadFlatSymbols(uri, signal));
    this._mutations = MutationCoordinator.forWorkspace(_workspaceRoot);
  }

  async dispatch(op: string, payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    try {
      switch (op) {
        case "symbols":     return await this._symbols(payload, ctx);
        case "navigate":    return await this._navigate(payload, ctx);
        case "hierarchy":   return await this._hierarchy(payload, ctx);
        case "hover":       return await this._hover(payload, ctx);
        case "diagnostics": return await this._diagnostics(payload, ctx);
        case "rename":      return await this._runMutation(ctx, (mutationCtx) => this._rename(payload, mutationCtx));
        case "actions":     return typeof payload["apply"] === "string" && payload["apply"]
          ? await this._runMutation(ctx, (mutationCtx) => this._actions(payload, mutationCtx))
          : await this._actions(payload, ctx);
        case "format":      return await this._runMutation(ctx, (mutationCtx) => this._format(payload, mutationCtx));
        case "insert":      return await this._runMutation(ctx, (mutationCtx) => this._insert(payload, mutationCtx));
        case "replace":     return await this._runMutation(ctx, (mutationCtx) => this._replace(payload, mutationCtx));
        case "replaceBatch": return await this._runMutation(ctx, (mutationCtx) => this._replaceBatch(payload, mutationCtx));
        case "inlayHints":  return await this._inlayHints(payload, ctx);
        default:            return { ok: false, error: `Unknown code-intelligence op: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private _runMutation(ctx: LspContext, operation: (ctx: LspContext) => Promise<LspResult>): Promise<LspResult> {
    return this._mutations.run(async (transactionId) => {
      let result: LspResult;
      try {
        result = await operation({ ...ctx, transactionId });
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error), mutationStatus: "uncertain" };
      }
      if (result["mutation"]) return result;
      const mutationStatus = result["mutationStatus"];
      const status = result.ok
        ? "applied"
        : mutationStatus === "conflict"
        ? "conflict"
        : mutationStatus === "uncertain" || mutationStatus === "apply_failed"
          ? "uncertain"
          : "rejected";
      return {
        ...result,
        mutation: {
          status,
          transactionId,
          textEdits: 0,
          resourceOperations: [],
          commands: [],
          touchedFiles: [],
          saved: status !== "uncertain",
          diagnostics: unknownDiagnosticSnapshot(),
        },
      };
    });
  }

  // ── code_symbols ───────────────────────────────────────────────────────────

  private async _symbols(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const query = typeof payload["query"] === "string" ? payload["query"].trim() : "";
    const p     = typeof payload["path"] === "string" ? payload["path"] : "";
    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);

    if (query) {
      const outcome = await this._providers.execute<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        [query],
        { signal: ctx.signal, maxAttempts: 3, isEmpty: (value) => value.length === 0 },
      );
      if (outcome.status !== "ok") return { ok: false, error: providerFailureMessage("workspace symbol", outcome), ...providerMetadata(outcome) };
      const normalized = outcome.value.flatMap((symbol) => {
        const identity = this._identity.fromUri(symbol.location.uri);
        if (!identity.ok) return [];
        return [{
          name: symbol.name,
          kind: kindName(symbol.kind),
          container: symbol.containerName || undefined,
          ...this._identity.display(identity.value),
          line: symbol.location.range.start.line + 1,
        }];
      }).sort((a, b) => (a.rootId ?? "").localeCompare(b.rootId ?? "")
        || a.path.localeCompare(b.path)
        || a.line - b.line
        || a.name.localeCompare(b.name));
      const symbols = normalized.slice(0, limit);
      return {
        ok: true,
        scope: "workspace",
        query,
        symbols,
        totalFound: normalized.length,
        excludedOutsideWorkspace: outcome.value.length - normalized.length || undefined,
        truncated: normalized.length > symbols.length,
        ...providerMetadata(outcome),
      };
    }

    if (p) {
      const identity = this._identity.resolve(p, stringValue(payload["rootId"]));
      if (!identity.ok) return identity;
      try { await vscode.workspace.openTextDocument(identity.value.uri); }
      catch { return { ok: false, error: `Could not open ${p}.` }; }
      const outcome = await this._providers.execute<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        [identity.value.uri],
        { signal: ctx.signal, maxAttempts: 3, isEmpty: (value) => value.length === 0 },
      );
      if (outcome.status !== "ok") return { ok: false, error: providerFailureMessage("document symbol", outcome), ...providerMetadata(outcome) };
      const notice = outcome.value.length === 0 ? this._noProviderHint(p, "symbol") : undefined;
      return {
        ok: true,
        scope: "document",
        ...this._identity.display(identity.value),
        symbols: buildSymbolTree(outcome.value),
        notice,
        ...providerMetadata(outcome),
      };
    }

    return { ok: false, error: "Provide `path` for a document symbol tree or `query` to search workspace symbols." };
  }

  // ── code_navigate ──────────────────────────────────────────────────────────

  private async _navigate(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const kind = String(payload["kind"] ?? "");
    const command = NAV_COMMANDS[kind];
    if (!command) return { ok: false, error: `Unknown navigate kind '${kind}'. Use definition | typeDefinition | declaration | implementation | references.` };

    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return { ...resolved };

    const limit   = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const context = clamp(num(payload["context"]) ?? 0, 0, 3);
    const wantBody = payload["includeBody"] === true && kind !== "references";

    const outcome = await this._providers.execute<(vscode.Location | vscode.LocationLink)[]>(
      command,
      [resolved.uri, resolved.position],
      { signal: ctx.signal, maxAttempts: 3, isEmpty: (value) => value.length === 0 },
    );
    if (outcome.status !== "ok") return { ok: false, error: providerFailureMessage(kind, outcome), ...providerMetadata(outcome) };

    const uniqueLocations = dedupeLocations(outcome.value);
    const deduped = uniqueLocations
      .filter((loc) => this._identity.contains(locParts(loc).uri))
      .sort(compareLocations);
    const sliced = deduped.slice(0, limit);
    const symbolCache: SymbolCache = new Map();
    const locations = await mapWithConcurrency(sliced, 8, async (loc) => {
      const { uri, range } = locParts(loc);
      return this._toCodeLocation(uri, range, context, wantBody, ctx, symbolCache);
    });

    const notice = locations.length === 0 ? this._noProviderHint(target.path, kind) : undefined;
    return {
      ok: true,
      kind,
      target: { path: target.path, line: resolved.position.line + 1, column: resolved.position.character + 1, symbol: resolved.symbolName },
      locations,
      totalFound: deduped.length,
      duplicateLocations: outcome.value.length - uniqueLocations.length || undefined,
      excludedOutsideWorkspace: uniqueLocations.length - deduped.length || undefined,
      truncated: deduped.length > sliced.length,
      notice,
      ...providerMetadata(outcome),
    };
  }

  // ── code_hierarchy (call + type hierarchy) ──────────────────────────────────

  private async _hierarchy(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const kind = String(payload["kind"] ?? "");
    if (!["callers", "callees", "supertypes", "subtypes"].includes(kind)) {
      return { ok: false, error: `Unknown hierarchy kind '${kind}'. Use callers | callees | supertypes | subtypes.` };
    }
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return { ...resolved };
    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const requestedDepth = num(payload["depth"]) ?? 1;
    if (!Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > MAX_HIERARCHY_DEPTH) {
      return { ok: false, error: `depth must be an integer from 1 to ${MAX_HIERARCHY_DEPTH}.` };
    }
    const depth = requestedDepth;
    const deadline = Date.now() + HIERARCHY_TOTAL_TIMEOUT_MS;

    const prepareCommand = kind === "callers" || kind === "callees" ? "vscode.prepareCallHierarchy" : "vscode.prepareTypeHierarchy";
    const prepared = await this._providers.execute<Array<vscode.CallHierarchyItem | vscode.TypeHierarchyItem>>(
      prepareCommand,
      [resolved.uri, resolved.position],
      { signal: ctx.signal, totalTimeoutMs: remainingMs(deadline), maxAttempts: 3, isEmpty: (value) => value.length === 0 },
    );
    if (prepared.status !== "ok") return { ok: false, error: providerFailureMessage(kind, prepared), ...providerMetadata(prepared) };
    const root = prepared.value[0];
    if (!root) {
      return {
        ok: true,
        kind,
        target: { path: target.path, line: resolved.position.line + 1, symbol: resolved.symbolName },
        results: [],
        totalFound: 0,
        notice: this._noProviderHint(target.path, kind),
        ...providerMetadata(prepared),
      };
    }

    const providerOutcome = await this._hierarchyRelatives(kind, root, ctx, deadline, true);
    if (providerOutcome.status !== "ok") {
      return { ok: false, error: providerFailureMessage(kind, providerOutcome), ...providerMetadata(providerOutcome) };
    }
    const relatives = providerOutcome.value;

    const safeRelatives = relatives.filter(({ item }) => this._identity.contains(item.uri)).sort(compareHierarchyRelatives);
    const sliced = safeRelatives.slice(0, limit);
    const results = sliced.map((relative) => this._hierarchyResult(relative));
    const graph = await this._expandHierarchyGraph(kind, root, safeRelatives, depth, limit, ctx, deadline);

    const notice = relatives.length === 0 ? this._noProviderHint(target.path, kind) : undefined;
    return {
      ok: true,
      kind,
      target: { path: target.path, line: resolved.position.line + 1, symbol: resolved.symbolName },
      results,
      totalFound: safeRelatives.length,
      excludedOutsideWorkspace: relatives.length - safeRelatives.length || undefined,
      truncated: safeRelatives.length > sliced.length,
      depth,
      graph,
      notice,
      ...providerMetadata(providerOutcome),
    };
  }

  private async _hierarchyRelatives(
    kind: string,
    item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem,
    ctx: LspContext,
    deadline: number,
    warmUp: boolean,
  ): Promise<ProviderOutcome<HierarchyRelative[]>> {
    const opts = {
      signal: ctx.signal,
      totalTimeoutMs: remainingMs(deadline),
      maxAttempts: warmUp ? 3 : 1,
      isEmpty: (value: unknown[]) => value.length === 0,
    };
    if (kind === "callers") {
      const outcome = await this._providers.execute<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", [item], opts);
      return mapProviderValue(outcome, (calls) => calls.map((call) => ({
        item: call.from,
        callCount: call.fromRanges.length,
        callSites: call.fromRanges.map(normalizeRange),
      })));
    }
    if (kind === "callees") {
      const outcome = await this._providers.execute<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", [item], opts);
      return mapProviderValue(outcome, (calls) => calls.map((call) => ({
        item: call.to,
        callCount: call.fromRanges.length,
        callSites: call.fromRanges.map(normalizeRange),
      })));
    }
    const command = kind === "supertypes" ? "vscode.provideSupertypes" : "vscode.provideSubtypes";
    const outcome = await this._providers.execute<vscode.TypeHierarchyItem[]>(command, [item], opts);
    return mapProviderValue(outcome, (items) => items.map((relative) => ({ item: relative })));
  }

  private async _expandHierarchyGraph(
    kind: string,
    root: vscode.CallHierarchyItem | vscode.TypeHierarchyItem,
    firstRelatives: HierarchyRelative[],
    requestedDepth: number,
    limit: number,
    ctx: LspContext,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const nodeBudget = limit + 1; // `limit` relatives plus the root node.
    const edgeBudget = Math.min(HARD_MAX * 4, Math.max(limit, limit * 4));
    const rootId = hierarchyItemId(root);
    const nodes = new Map<string, Record<string, unknown>>([[rootId, this._hierarchyNode(root, rootId, 0)]]);
    const edges = new Map<string, Record<string, unknown>>();
    const queue: Array<{ item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem; id: string; depth: number }> = [];
    const failures: Array<{ nodeId: string; status: string; message: string }> = [];
    let depthReached = 0;
    let truncated = false;

    const addRelatives = (
      fromId: string,
      relatives: HierarchyRelative[],
      relativeDepth: number,
    ): void => {
      for (const relative of [...relatives].sort(compareHierarchyRelatives)) {
        if (!this._identity.contains(relative.item.uri)) continue;
        const id = hierarchyItemId(relative.item);
        if (nodes.size >= nodeBudget && !nodes.has(id)) { truncated = true; continue; }
        if (!nodes.has(id)) {
          nodes.set(id, this._hierarchyNode(relative.item, id, relativeDepth));
          if (relativeDepth < requestedDepth) queue.push({ item: relative.item, id, depth: relativeDepth });
        }
        const edgeKey = `${fromId}>${id}`;
        if (!edges.has(edgeKey)) {
          if (edges.size >= edgeBudget) { truncated = true; continue; }
          edges.set(edgeKey, {
            from: fromId,
            to: id,
            callCount: relative.callCount,
            callSites: relative.callSites,
          });
        }
        depthReached = Math.max(depthReached, relativeDepth);
      }
    };

    addRelatives(rootId, firstRelatives, 1);
    while (queue.length && !ctx.signal?.aborted && Date.now() < deadline && !truncated) {
      const current = queue.shift()!;
      const outcome = await this._hierarchyRelatives(kind, current.item, ctx, deadline, false);
      if (outcome.status !== "ok") {
        failures.push({ nodeId: current.id, status: outcome.status, message: providerFailureMessage(kind, outcome) });
        if (outcome.status === "cancelled") break;
        continue;
      }
      addRelatives(current.id, outcome.value, current.depth + 1);
    }
    if (queue.length || Date.now() >= deadline || ctx.signal?.aborted) truncated = true;

    return {
      status: failures.length || truncated ? "partial" : "complete",
      direction: kind,
      requestedDepth,
      depthReached,
      nodeBudget,
      edgeBudget,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      failures: failures.length ? failures : undefined,
      truncated,
    };
  }

  private _hierarchyNode(
    item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem,
    id: string,
    depth: number,
  ): Record<string, unknown> {
    return {
      id,
      symbol: item.name,
      kind: kindName(item.kind),
      ...this._displayUri(item.uri),
      depth,
      range: normalizeRange(item.range),
      selectionRange: normalizeRange(item.selectionRange),
      detail: item.detail || undefined,
    };
  }

  private _hierarchyResult({ item, callCount, callSites }: HierarchyRelative): Record<string, unknown> {
    return {
      id: hierarchyItemId(item),
      symbol: item.name,
      kind: kindName(item.kind),
      ...this._displayUri(item.uri),
      line: item.selectionRange.start.line + 1,
      detail: item.detail || undefined,
      callCount,
      callSites,
    };
  }

  // ── code_hover ─────────────────────────────────────────────────────────────

  private async _hover(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return { ...resolved };

    const [hoverOutcome, signatureOutcome] = await Promise.all([
      this._providers.execute<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        [resolved.uri, resolved.position],
        { signal: ctx.signal, maxAttempts: 3, isEmpty: (value) => value.length === 0 },
      ),
      this._providers.execute<vscode.SignatureHelp | undefined>(
        "vscode.executeSignatureHelpProvider",
        [resolved.uri, resolved.position],
        { signal: ctx.signal },
      ),
    ]);
    if (hoverOutcome.status === "cancelled" || signatureOutcome.status === "cancelled") {
      return { ok: false, error: "Cancelled.", providerStatus: "cancelled" };
    }

    const hovers = hoverOutcome.status === "ok" ? hoverOutcome.value : [];
    const signatureHelp = signatureOutcome.status === "ok" ? signatureOutcome.value : undefined;
    const text = hovers
      .flatMap((h) => h.contents.map(stringifyMarkdown))
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");
    const sigLine = formatActiveSignature(signatureHelp);
    const combined = [sigLine, text].filter(Boolean).join("\n\n");

    if (!combined) {
      const hint = this._noProviderHint(target.path, "hover");
      if (hoverOutcome.status !== "ok") {
        return { ok: false, error: hint ?? providerFailureMessage("hover", hoverOutcome), ...providerMetadata(hoverOutcome) };
      }
      return { ok: false, error: hint ?? "No hover information at the target.", ...providerMetadata(hoverOutcome) };
    }
    const truncated = combined.length > 4000;
    return {
      ok: true,
      text: combined.slice(0, 4000),
      ...this._identity.display(resolved.workspacePath),
      line: resolved.position.line + 1,
      column: resolved.position.character + 1,
      endLine: resolved.range.end.line + 1,
      endColumn: resolved.range.end.character + 1,
      symbol: resolved.symbolName,
      kind: resolved.symbol?.kind,
      truncated: truncated || undefined,
      ...providerMetadata(hoverOutcome),
      signatureProviderStatus: signatureOutcome.status,
    };
  }

  // ── code_diagnostics ───────────────────────────────────────────────────────

  private async _diagnostics(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    const severity = typeof payload["severity"] === "string" ? payload["severity"].toLowerCase() : "";
    if (severity && !["error", "warning", "info", "hint"].includes(severity)) {
      return { ok: false, error: "severity must be error, warning, info, or hint." };
    }
    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const activateWorkspace = payload["activateWorkspace"] === true;
    if (p && activateWorkspace) return { ok: false, error: "Use either path or activateWorkspace, not both." };
    let uris: vscode.Uri[] | undefined;
    let coverageCapped = false;
    if (p) {
      const identity = this._identity.resolve(p, stringValue(payload["rootId"]));
      if (!identity.ok) return identity;
      try { await vscode.workspace.openTextDocument(identity.value.uri); }
      catch { return { ok: false, error: `Could not open ${p}.` }; }
      uris = [identity.value.uri];
    } else if (activateWorkspace) {
      const activationLimit = clamp(num(payload["activationLimit"]) ?? 200, 1, HARD_MAX);
      const discovered = await vscode.workspace.findFiles(DIAGNOSTIC_SOURCE_GLOB, DIAGNOSTIC_EXCLUDE_GLOB, activationLimit + 1);
      coverageCapped = discovered.length > activationLimit;
      uris = discovered.slice(0, activationLimit).filter((uri) => this._identity.contains(uri));
      await mapWithConcurrency(uris, 8, async (uri) => {
        try { await vscode.workspace.openTextDocument(uri); }
        catch { /* unreadable files remain reflected by activatedFiles coverage */ }
      });
    }

    const snapshot = await collectDiagnosticSnapshot(this._workspaceRoot, {
      uris,
      severity,
      limit,
      signal: ctx.signal,
      waitForChange: !!uris,
      scope: p ? "file" : activateWorkspace ? "activated_workspace" : "published_workspace",
      coverageCapped,
    });
    const notice = p && snapshot.problems.length === 0 ? this._noProviderHint(p, "diagnostics") : undefined;
    return { ok: true, ...snapshot, notice };
  }

  // ── code_rename ────────────────────────────────────────────────────────────

  private async _rename(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const newName = String(payload["newName"] ?? "").trim();
    if (!newName) return { ok: false, error: "newName is required." };

    const resolved = await this._resolveTarget(target, ctx, true);
    if (!resolved.ok) return { ...resolved };

    const declineReason = await this._checkPrepareRename(resolved.uri, resolved.position, ctx);
    if (declineReason) return { ok: false, error: declineReason };

    const renameOutcome = await this._providers.execute<vscode.WorkspaceEdit | undefined>(
      "vscode.executeDocumentRenameProvider",
      [resolved.uri, resolved.position, newName],
      { signal: ctx.signal },
    );
    if (renameOutcome.status !== "ok") {
      return { ok: false, error: providerFailureMessage("rename", renameOutcome), ...providerMetadata(renameOutcome) };
    }
    const edit = renameOutcome.value;
    if (!edit || edit.size === 0) {
      const hint = this._noProviderHint(target.path, "rename");
      return { ok: false, error: hint ?? "The language server returned no rename edits (the symbol may not be renameable here).", ...providerMetadata(renameOutcome) };
    }
    const invalidEdit = this._validateTextEditUris(edit);
    if (invalidEdit) return { ok: false, error: invalidEdit };
    const diagnosticUris = inspectWorkspaceEdit(edit).touchedUris;
    const baseline = await captureDiagnosticBaseline(diagnosticUris, this._workspaceRoot);

    const label = resolved.symbolName ?? target.symbol ?? "symbol";
    const res = await this._applier.apply(edit, {
      summary: `Rename '${label}' to '${newName}'`,
      autoApprove: ctx.autoApprove,
      expectedVersions: expectedVersion(resolved.uri, resolved.documentVersion),
      approvalProvider: ctx.approvalProvider,
      showPreview: ctx.showPreview,
    });
    if (!res.applied) return { ok: false, error: applyFailure("rename", res.reason), mutationStatus: res.reason };

    const diagnostics = await collectForUris(diagnosticUris, this._workspaceRoot, { baseline, signal: ctx.signal });
    return {
      ok: true,
      newName,
      files: res.files,
      edits: res.edits,
      diagnostics,
      mutation: this._mutationReceipt(ctx, res, diagnostics, [], diagnosticUris),
      autoApproveAll: res.autoApproveAll || undefined,
      ...providerMetadata(renameOutcome),
    };
  }

  /** vscode.prepareRename validates the position before we attempt the real rename,
      and — unlike execProvider — its rejection carries a specific, useful reason
      (e.g. "You cannot rename this element") that we don't want swallowed to
      undefined. A provider that doesn't implement prepareRename resolves rather
      than rejects, so this only fires on an explicit decline. */
  private async _checkPrepareRename(uri: vscode.Uri, position: vscode.Position, ctx: LspContext): Promise<string | undefined> {
    const outcome = await this._providers.execute<unknown>("vscode.prepareRename", [uri, position], { signal: ctx.signal });
    if (outcome.status === "ok") return undefined;
    return providerFailureMessage("prepare rename", outcome);
  }

  // ── code_actions ───────────────────────────────────────────────────────────

  private async _actions(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const line = num(payload["line"]);
    if (line === undefined) return { ok: false, error: "line is required." };
    const endLine = num(payload["endLine"]) ?? line;
    const only = typeof payload["only"] === "string" ? payload["only"] : undefined;
    const apply = typeof payload["apply"] === "string" ? payload["apply"].trim() : "";

    const identity = this._identity.resolve(p, stringValue(payload["rootId"]));
    if (!identity.ok) return identity;
    const uri = identity.value.uri;
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${p}.` }; }

    if (!Number.isInteger(line) || line < 1 || line > doc.lineCount) return { ok: false, error: `line must be between 1 and ${doc.lineCount}.` };
    if (!Number.isInteger(endLine) || endLine < line || endLine > doc.lineCount) return { ok: false, error: `endLine must be between ${line} and ${doc.lineCount}.` };
    const startLine = line - 1;
    const lastLine  = endLine - 1;
    const range = new vscode.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);

    // itemResolveCount forces VS Code to resolve lazy `.edit` payloads so we can apply them.
    let chosen: vscode.CodeAction | vscode.Command | undefined;
    let usedTitleAlias = false;
    let actionOutcome: ProviderOutcome<(vscode.CodeAction | vscode.Command)[]> | undefined;
    if (apply) {
      const cached = this._actionsRegistry.resolve(apply, uri, doc.version);
      if (cached.ok) chosen = cached.action;
      else if (looksLikeActionId(apply)) return cached;
    }

    if (!chosen) {
      actionOutcome = await this._providers.execute<(vscode.CodeAction | vscode.Command)[]>(
        "vscode.executeCodeActionProvider",
        [uri, range, only, apply ? 50 : 0],
        { signal: ctx.signal },
      );
      if (actionOutcome.status !== "ok") {
        return { ok: false, error: providerFailureMessage("code action", actionOutcome), ...providerMetadata(actionOutcome) };
      }
    }
    const raw = actionOutcome?.status === "ok" ? actionOutcome.value : [];

    if (!apply) {
      const actions = this._actionsRegistry.register(raw, uri, doc.version);
      if (actions.length === 0) {
        const notice = this._noProviderHint(p, "code action");
        return { ok: true, actions, message: "No code actions available for that range.", notice, ...providerMetadata(actionOutcome!) };
      }
      return { ok: true, actions, ...providerMetadata(actionOutcome!) };
    }

    const lower = apply.toLowerCase();
    const exact = raw.filter((action) => action.title.toLowerCase() === lower);
    if (!chosen && exact.length > 1) {
      return { ok: false, ambiguous: true, error: `Multiple code actions are titled '${apply}'. List actions and apply one by actionId.` };
    }
    if (!chosen && exact[0]) {
      chosen = exact[0];
      usedTitleAlias = true;
    }
    if (!chosen) {
      const prefixes = raw.filter((action) => action.title.toLowerCase().startsWith(lower));
      const suffix = prefixes.length ? ` Prefix matches: ${prefixes.map((action) => action.title).slice(0, 8).join(", ")}. Use an exact title or actionId.` : "";
      return { ok: false, error: `No exact code action matched '${apply}'.${suffix}` };
    }
    if (isCodeAction(chosen) && chosen.disabled) return { ok: false, error: `Code action is disabled: ${chosen.disabled.reason}` };

    let applied = false;
    let diagUris: vscode.Uri[] = [uri];
    const baseline = await captureDiagnosticBaseline(this._publishedWorkspaceUris(diagUris), this._workspaceRoot);
    let commandOutcome: CommandOutcome | undefined;
    if (isCodeAction(chosen)) {
      if (chosen.edit && chosen.edit.size > 0) {
        const invalidEdit = this._validateTextEditUris(chosen.edit);
        if (invalidEdit) return { ok: false, error: invalidEdit };
        if (chosen.command && !(await this._applier.confirmCommand(chosen.command, ctx.approvalProvider))) {
          return { ok: false, error: "User rejected the unpreviewable command portion of the code action." };
        }
        const editUris = inspectWorkspaceEdit(chosen.edit).touchedUris;
        const res = await this._applier.apply(chosen.edit, {
          summary: `Code action: ${chosen.title}`,
          autoApprove: ctx.autoApprove,
          expectedVersions: expectedVersion(uri, doc.version),
          approvalProvider: ctx.approvalProvider,
          showPreview: ctx.showPreview,
        });
        if (!res.applied) return { ok: false, error: applyFailure("code action", res.reason), mutationStatus: res.reason };
        applied = true;
        diagUris = editUris;
        const executedCommand = chosen.command;
        let commandOutcome: CommandOutcome | undefined;
        if (executedCommand) commandOutcome = await this._runCommand(executedCommand, ctx, true);
        if (commandOutcome && commandOutcome.status !== "ok") {
          diagUris = dedupeUris([...diagUris, ...commandOutcome.touchedUris]);
          const diagnostics = await collectForUris(diagUris, this._workspaceRoot, { baseline, signal: ctx.signal });
          const receipt = this._mutationReceipt(
            ctx,
            { ...res, saved: res.saved && commandOutcome.saved !== false },
            diagnostics,
            [{ id: executedCommand!.command, status: commandReceiptStatus(commandOutcome) }],
            diagUris,
          );
          return {
            ok: false,
            error: commandFailureMessage(`code action command '${executedCommand!.command}'`, commandOutcome),
            mutationStatus: "uncertain",
            diagnostics,
            mutation: { ...receipt, status: "uncertain" },
          };
        }
        if (commandOutcome) diagUris = dedupeUris([...diagUris, ...commandOutcome.touchedUris]);
        const diagnostics = await collectForUris(diagUris, this._workspaceRoot, { baseline, signal: ctx.signal });
        return {
          ok: true,
          title: chosen.title,
          files: res.files,
          edits: res.edits,
          diagnostics,
          mutation: this._mutationReceipt(
            ctx,
            { ...res, saved: res.saved && commandOutcome?.saved !== false },
            diagnostics,
            executedCommand ? [{ id: executedCommand.command, status: "completed" }] : [],
            diagUris,
          ),
          notice: usedTitleAlias ? "Code-action title application is deprecated; list actions and apply by actionId." : undefined,
          autoApproveAll: res.autoApproveAll || undefined,
          ...(actionOutcome ? providerMetadata(actionOutcome) : {}),
        };
      }
      if (chosen.command) {
        commandOutcome = await this._runCommand(chosen.command, ctx);
        applied = commandOutcome.status === "ok";
      }
    } else {
      commandOutcome = await this._runCommand(chosen, ctx);
      applied = commandOutcome.status === "ok";
    }

    const commandId = isCodeAction(chosen) ? chosen.command?.command : chosen.command;
    if (commandOutcome && commandOutcome.status !== "ok") {
      diagUris = dedupeUris([...diagUris, ...commandOutcome.touchedUris]);
      const diagnostics = await collectForUris(diagUris, this._workspaceRoot, { baseline, signal: ctx.signal });
      const status = commandOutcome.commandRejected ? "rejected" : "uncertain";
      return {
        ok: false,
        error: commandFailureMessage(`code action command '${commandId}'`, commandOutcome),
        mutationStatus: status,
        diagnostics,
        mutation: {
          status,
          transactionId: ctx.transactionId,
          textEdits: 0,
          resourceOperations: [],
          commands: commandId ? [{ id: commandId, status: commandReceiptStatus(commandOutcome) }] : [],
          touchedFiles: commandOutcome.touchedUris.map((entryUri) => this._displayUri(entryUri)),
          saved: status === "rejected",
          diagnostics,
        },
      };
    }
    if (!applied) return { ok: false, error: `Code action '${chosen.title}' could not be resolved to an edit headlessly.` };
    diagUris = dedupeUris([...diagUris, ...(commandOutcome?.touchedUris ?? [])]);
    const diagnostics = await collectForUris(diagUris, this._workspaceRoot, { baseline, signal: ctx.signal });
    return {
      ok: true,
      title: chosen.title,
      ranEditorCommand: true,
      diagnostics,
      mutation: {
          status: commandOutcome?.saved === false ? "uncertain" : "applied",
        transactionId: ctx.transactionId,
        textEdits: 0,
        resourceOperations: [],
        commands: commandId ? [{ id: commandId, status: "completed" }] : [],
        touchedFiles: (commandOutcome?.touchedUris ?? []).map((entryUri) => this._displayUri(entryUri)),
          saved: commandOutcome?.saved !== false,
        diagnostics,
      },
      notice: usedTitleAlias ? "Code-action title application is deprecated; list actions and apply by actionId." : undefined,
      ...(actionOutcome ? providerMetadata(actionOutcome) : {}),
    };
  }

  // ── code_format ────────────────────────────────────────────────────────────

  private async _format(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const identity = this._identity.resolve(p, stringValue(payload["rootId"]));
    if (!identity.ok) return identity;
    const uri = identity.value.uri;
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${p}.` }; }

    const cfg = vscode.workspace.getConfiguration("editor", uri);
    const options = { tabSize: cfg.get<number>("tabSize") ?? 2, insertSpaces: cfg.get<boolean>("insertSpaces") ?? true };

    const rangeArg = payload["range"] as { startLine?: unknown; endLine?: unknown } | undefined;
    const requestedRange = validateLineRange(doc, rangeArg);
    if (!requestedRange.ok) return requestedRange;
    let formatOutcome: ProviderOutcome<vscode.TextEdit[] | undefined>;
    if (requestedRange.range) {
      formatOutcome = await this._providers.execute("vscode.executeFormatRangeProvider", [uri, requestedRange.range, options], { signal: ctx.signal });
    } else {
      formatOutcome = await this._providers.execute("vscode.executeFormatDocumentProvider", [uri, options], { signal: ctx.signal });
    }
    if (formatOutcome.status !== "ok") return { ok: false, error: providerFailureMessage("formatting", formatOutcome), ...providerMetadata(formatOutcome) };
    const edits = formatOutcome.value;

    if (!edits || edits.length === 0) {
      const notice = this._noProviderHint(p, "formatting");
      return { ok: true, formatted: false, message: "The formatter returned no changes.", notice, ...providerMetadata(formatOutcome) };
    }

    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) edit.replace(uri, e.range, e.newText);
    const baseline = await captureDiagnosticBaseline([uri], this._workspaceRoot);
    const res = await this._applier.apply(edit, {
      summary: `Format ${identity.value.path}`,
      autoApprove: ctx.autoApprove,
      expectedVersions: expectedVersion(uri, doc.version),
      approvalProvider: ctx.approvalProvider,
      showPreview: ctx.showPreview,
    });
    if (!res.applied) return { ok: false, error: applyFailure("formatting", res.reason), mutationStatus: res.reason };
    const diagnostics = await collectForUris([uri], this._workspaceRoot, { baseline, signal: ctx.signal });
    return {
      ok: true,
      formatted: true,
      edits: res.edits,
      diagnostics,
      mutation: this._mutationReceipt(ctx, res, diagnostics, [], [uri]),
      autoApproveAll: res.autoApproveAll || undefined,
      ...providerMetadata(formatOutcome),
    };
  }

  // ── code_inlay_hints ───────────────────────────────────────────────────────

  private async _inlayHints(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const identity = this._identity.resolve(p, stringValue(payload["rootId"]));
    if (!identity.ok) return identity;
    const uri = identity.value.uri;
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${p}.` }; }

    // executeInlayHintProvider has no whole-document overload (unlike format's two
    // commands) — it always requires a range, so synthesize one when omitted.
    const rangeArg = payload["range"] as { startLine?: unknown; endLine?: unknown } | undefined;
    const requestedRange = validateLineRange(doc, rangeArg);
    if (!requestedRange.ok) return requestedRange;
    let range: vscode.Range;
    if (requestedRange.range) {
      range = requestedRange.range;
    } else {
      const lastLine = doc.lineCount - 1;
      range = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
    }

    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const outcome = await this._providers.execute<vscode.InlayHint[] | undefined>(
      "vscode.executeInlayHintProvider", [uri, range], { signal: ctx.signal },
    );
    if (outcome.status !== "ok") return { ok: false, error: providerFailureMessage("inlay hint", outcome), ...providerMetadata(outcome) };
    const raw = outcome.value ?? [];
    const sorted = [...raw].sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
    const sliced = sorted.slice(0, limit);
    const hints = sliced.map((h) => ({
      line: h.position.line + 1,
      column: h.position.character + 1,
      label: typeof h.label === "string" ? h.label : h.label.map((part) => part.value).join(""),
      labelParts: typeof h.label === "string" ? undefined : h.label.map((part) => ({
        value: part.value,
        tooltip: stringifyInlayTooltip(part.tooltip),
        location: part.location && this._identity.contains(part.location.uri) ? {
          ...this._displayUri(part.location.uri),
          range: normalizeRange(part.location.range),
        } : undefined,
        hasCommand: !!part.command || undefined,
      })),
      kind: h.kind === vscode.InlayHintKind.Type ? "type" : h.kind === vscode.InlayHintKind.Parameter ? "parameter" : undefined,
      tooltip: stringifyInlayTooltip(h.tooltip),
      paddingLeft: h.paddingLeft || undefined,
      paddingRight: h.paddingRight || undefined,
      hasTextEdits: !!h.textEdits?.length || undefined,
    }));

    if (hints.length === 0) {
      const notice = this._noProviderHint(p, "inlay hint");
      return { ok: true, ...this._identity.display(identity.value), hints, notice, ...providerMetadata(outcome) };
    }
    return { ok: true, ...this._identity.display(identity.value), hints, totalFound: sorted.length, truncated: sorted.length > sliced.length, ...providerMetadata(outcome) };
  }

  private async _insert(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const text = typeof payload["text"] === "string" ? payload["text"] : "";
    if (!text) return { ok: false, error: "text is required." };
    const positionMode = String(payload["position"] ?? "after");
    if (!["before", "after", "start", "end"].includes(positionMode)) {
      return { ok: false, error: "position must be before, after, start, or end." };
    }

    const resolved = await this._resolveTarget(target, ctx, true);
    if (!resolved.ok) return { ...resolved };

    const insertPosition = resolveInsertPosition(resolved.doc, resolved.range, positionMode as "before" | "after" | "start" | "end");
    const edit = new vscode.WorkspaceEdit();
    edit.insert(resolved.uri, insertPosition, text);
    const baseline = await captureDiagnosticBaseline([resolved.uri], this._workspaceRoot);

    const label = resolved.symbolName ?? target.symbol ?? `${target.path}:${resolved.position.line + 1}`;
    const res = await this._applier.apply(edit, {
      summary: `Insert code ${positionMode} ${label}`,
      autoApprove: ctx.autoApprove,
      expectedVersions: expectedVersion(resolved.uri, resolved.documentVersion),
      approvalProvider: ctx.approvalProvider,
      showPreview: ctx.showPreview,
    });
    if (!res.applied) return { ok: false, error: applyFailure("insertion", res.reason), mutationStatus: res.reason };

    const diagnostics = await collectForUris([resolved.uri], this._workspaceRoot, { baseline, signal: ctx.signal });
    return {
      ok: true,
      ...this._displayUri(resolved.uri),
      line: insertPosition.line + 1,
      column: insertPosition.character + 1,
      diagnostics,
      mutation: this._mutationReceipt(ctx, res, diagnostics, [], [resolved.uri]),
      autoApproveAll: res.autoApproveAll || undefined,
    };
  }

  // ── code_replace / code_replace_batch ─────────────────────────────────────

  /** Shared resolve-target → compute-range → validate-non-identical pipeline for one
   *  replacement, used by both _replace (single) and _replaceBatch (many). Read-only —
   *  it never mutates the document, so _replaceBatch can resolve every edit before
   *  committing any of them. */
  private async _resolveReplacement(
    payload: Record<string, unknown>,
    ctx: LspContext,
  ): Promise<{ ok: true; uri: vscode.Uri; range: vscode.Range; text: string; label: string; documentVersion: number }
    | { ok: false; error: string; ambiguous?: boolean; candidates?: SymbolRef[] }> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const text = typeof payload["text"] === "string" ? payload["text"] : "";
    if (!text) return { ok: false, error: "text is required — to delete a symbol entirely, use code_actions or file_edit instead." };

    const resolved = await this._resolveTarget(target, ctx, true);
    if (!resolved.ok) return { ...resolved };

    // A symbol target always replaces its full LSP-resolved range. A line-only target
    // replaces just the anchor line unless endLine widens it to an explicit range —
    // the same convention code_actions/code_format use for line ranges.
    let range = resolved.range;
    if (!target.symbol) {
      const endLine = num(payload["endLine"]);
      if (endLine !== undefined) {
        const startLine = range.start.line;
        if (!Number.isInteger(endLine) || endLine < startLine + 1 || endLine > resolved.doc.lineCount) {
          return { ok: false, error: `endLine must be an integer between ${startLine + 1} and ${resolved.doc.lineCount}.` };
        }
        const lastLine = endLine - 1;
        range = new vscode.Range(startLine, 0, lastLine, resolved.doc.lineAt(lastLine).text.length);
      }
    }

    if (resolved.doc.getText(range) === text) {
      return { ok: false, error: "The resolved range already matches the replacement text — nothing to change." };
    }

    const label = resolved.symbolName ?? target.symbol ?? `${target.path}:${range.start.line + 1}-${range.end.line + 1}`;
    return { ok: true, uri: resolved.uri, range, text, label, documentVersion: resolved.documentVersion };
  }

  private async _replace(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const resolved = await this._resolveReplacement(payload, ctx);
    if (!resolved.ok) return { ...resolved };

    const edit = new vscode.WorkspaceEdit();
    edit.replace(resolved.uri, resolved.range, resolved.text);
    const baseline = await captureDiagnosticBaseline([resolved.uri], this._workspaceRoot);

    const res = await this._applier.apply(edit, {
      summary: `Replace ${resolved.label}`,
      autoApprove: ctx.autoApprove,
      expectedVersions: expectedVersion(resolved.uri, resolved.documentVersion),
      approvalProvider: ctx.approvalProvider,
      showPreview: ctx.showPreview,
    });
    if (!res.applied) return { ok: false, error: applyFailure("replacement", res.reason), mutationStatus: res.reason };

    const diagnostics = await collectForUris([resolved.uri], this._workspaceRoot, { baseline, signal: ctx.signal });
    return {
      ok: true,
      ...this._displayUri(resolved.uri),
      symbol: resolved.label,
      startLine: resolved.range.start.line + 1,
      endLine: resolved.range.end.line + 1,
      diagnostics,
      mutation: this._mutationReceipt(ctx, res, diagnostics, [], [resolved.uri]),
      autoApproveAll: res.autoApproveAll || undefined,
    };
  }

  private async _replaceBatch(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const rawEdits = Array.isArray(payload["edits"]) ? payload["edits"] : [];
    if (rawEdits.length === 0) return { ok: false, error: "At least one edit is required." };

    const resolvedEdits: Array<{ uri: vscode.Uri; range: vscode.Range; text: string; label: string; documentVersion: number }> = [];
    for (const [i, raw] of rawEdits.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `edits[${i}] must be an object.` };
      const resolved = await this._resolveReplacement(raw as Record<string, unknown>, ctx);
      if (!resolved.ok) return { ok: false, error: `edits[${i}]: ${resolved.error}`, ambiguous: resolved.ambiguous, candidates: resolved.candidates };
      resolvedEdits.push(resolved);
    }

    // Overlapping ranges in the same file would leave it ambiguous which edit "wins" for
    // the shared region — refuse rather than guess, same philosophy as file_edit's
    // ambiguous-match refusal.
    const perFile = new Map<string, Array<{ range: vscode.Range; label: string }>>();
    for (const e of resolvedEdits) {
      const key = e.uri.toString();
      const siblings = perFile.get(key) ?? [];
      const clash = siblings.find((s) => !!e.range.intersection(s.range));
      if (clash) return { ok: false, error: `Edits for '${clash.label}' and '${e.label}' target overlapping ranges in the same file — split them into separate calls.` };
      siblings.push({ range: e.range, label: e.label });
      perFile.set(key, siblings);
    }

    const edit = new vscode.WorkspaceEdit();
    for (const e of resolvedEdits) edit.replace(e.uri, e.range, e.text);
    const uniqueUris = [...new Map(resolvedEdits.map((entry) => [entry.uri.toString(), entry.uri])).values()];
    const baseline = await captureDiagnosticBaseline(uniqueUris, this._workspaceRoot);

    const fileCount = perFile.size;
    const res = await this._applier.apply(edit, {
      summary: `Replace ${resolvedEdits.length} symbol(s) across ${fileCount} file(s)`,
      autoApprove: ctx.autoApprove,
      expectedVersions: new Map(resolvedEdits.map((entry) => [entry.uri.toString(), entry.documentVersion])),
      approvalProvider: ctx.approvalProvider,
      showPreview: ctx.showPreview,
    });
    if (!res.applied) return { ok: false, error: applyFailure("batch replacement", res.reason), mutationStatus: res.reason };

    const diagnostics = await collectForUris(uniqueUris, this._workspaceRoot, { baseline, signal: ctx.signal });
    return {
      ok: true,
      files: fileCount,
      edits: resolvedEdits.length,
      results: resolvedEdits.map((e) => ({
        ...this._displayUri(e.uri),
        symbol: e.label,
        startLine: e.range.start.line + 1,
        endLine: e.range.end.line + 1,
      })),
      diagnostics,
      mutation: this._mutationReceipt(ctx, res, diagnostics, [], uniqueUris),
      autoApproveAll: res.autoApproveAll || undefined,
    };
  }

  private async _runCommand(command: vscode.Command, ctx: LspContext, approved = false): Promise<CommandOutcome> {
    if (!approved && !(await this._applier.confirmCommand(command, ctx.approvalProvider))) {
      return { status: "error", message: "User rejected the unpreviewable command.", durationMs: 0, attempts: 0, touchedUris: [], commandRejected: true };
    }
    const touched = new Map<string, vscode.Uri>();
    const saveCandidates = new Map<string, vscode.Uri>();
    const remember = (uri: vscode.Uri): void => {
      if (this._identity.contains(uri)) touched.set(uri.toString(), uri);
    };
    const rememberSaveCandidate = (uri: vscode.Uri): void => {
      remember(uri);
      if (this._identity.contains(uri)) saveCandidates.set(uri.toString(), uri);
    };
    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => rememberSaveCandidate(event.document.uri)),
      vscode.workspace.onDidCreateFiles((event) => event.files.forEach(rememberSaveCandidate)),
      vscode.workspace.onDidRenameFiles((event) => event.files.forEach(({ oldUri, newUri }) => { remember(oldUri); rememberSaveCandidate(newUri); })),
      vscode.workspace.onDidDeleteFiles((event) => event.files.forEach(remember)),
    ];
    try {
      const outcome = await this._providers.execute(command.command, command.arguments ?? [], { signal: ctx.signal, allowUndefined: true });
      // VS Code commands can resolve in the same turn in which they emit their
      // final workspace event. Give those event callbacks one microtask to run.
      await Promise.resolve();
      const saved = outcome.status === "ok" ? await this._saveCommandDocuments([...saveCandidates.values()]) : undefined;
      return { ...outcome, touchedUris: [...touched.values()], saved };
    } finally {
      subscriptions.forEach((subscription) => subscription.dispose());
    }
  }

  private async _saveCommandDocuments(uris: vscode.Uri[]): Promise<boolean> {
    let saved = true;
    for (const uri of dedupeUris(uris)) {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty && !(await document.save())) saved = false;
      } catch {
        saved = false;
      }
    }
    return saved;
  }

  // ── Position resolution ────────────────────────────────────────────────────

  private async _resolveTarget(target: Target, ctx?: LspContext, mutation = false): Promise<Resolved | TargetResolutionError> {
    return this._targets.resolve(target, { signal: ctx?.signal, mutation });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _loadFlatSymbols(uri: vscode.Uri, signal?: AbortSignal): Promise<ProviderOutcome<FlatCodeSymbol[]>> {
    const outcome = await this._providers.execute<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      "vscode.executeDocumentSymbolProvider",
      [uri],
      { signal, maxAttempts: 3, isEmpty: (value) => value.length === 0 },
    );
    if (outcome.status !== "ok") return outcome;
    const out: FlatCodeSymbol[] = [];
    const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], container?: string): void => {
      for (const s of list) {
        if (isDocumentSymbol(s)) {
          out.push({ name: s.name, kind: s.kind, kindName: kindName(s.kind), container, selection: s.selectionRange.start, range: s.range, uri });
          if (s.children?.length) walk(s.children, container ? `${container}.${s.name}` : s.name);
        } else {
          out.push({
            name: s.name,
            kind: s.kind,
            kindName: kindName(s.kind),
            container: s.containerName || undefined,
            selection: s.location.range.start,
            range: s.location.range,
            uri: s.location.uri,
          });
        }
      }
    };
    walk(outcome.value);
    return { ...outcome, value: out };
  }

  private async _flatDocumentSymbols(uri: vscode.Uri, ctx?: LspContext): Promise<FlatCodeSymbol[]> {
    const outcome = await this._loadFlatSymbols(uri, ctx?.signal);
    return outcome.status === "ok" ? outcome.value : [];
  }

  private async _toCodeLocation(
    uri: vscode.Uri,
    range: vscode.Range,
    context: number,
    wantBody: boolean,
    ctx?: LspContext,
    symbolCache?: SymbolCache,
  ): Promise<CodeLocation> {
    let snippet = "";
    let symbol: string | undefined;
    let kind: string | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (wantBody) {
        const body = await this._symbolBody(doc, range.start, ctx, symbolCache);
        snippet = body.text;
        symbol = body.name;
        kind = body.kind;
      } else if (context > 0) {
        const start = Math.max(0, range.start.line - context);
        const end   = Math.min(doc.lineCount - 1, range.end.line + context);
        snippet = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
      } else {
        snippet = doc.lineAt(range.start.line).text.trim();
      }
    } catch { /* snippet stays empty */ }
    return {
      ...this._displayUri(uri),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
      snippet,
      symbol,
      kind,
    };
  }

  private async _symbolBody(
    doc: vscode.TextDocument,
    position: vscode.Position,
    ctx?: LspContext,
    symbolCache?: SymbolCache,
  ): Promise<{ text: string; name?: string; kind?: string }> {
    const key = `${doc.uri.toString()}@${doc.version}`;
    let pending = symbolCache?.get(key);
    if (!pending) {
      pending = this._flatDocumentSymbols(doc.uri, ctx);
      symbolCache?.set(key, pending);
    }
    const flat = await pending;
    let best: FlatCodeSymbol | undefined;
    for (const s of flat) {
      if (s.range.contains(position) && (!best || rangeSize(s.range) < rangeSize(best.range))) best = s;
    }
    if (!best) return { text: doc.lineAt(position.line).text.trim() };
    let text = doc.getText(best.range);
    const lines = text.split("\n");
    if (lines.length > 200) text = `${lines.slice(0, 200).join("\n")}\n… (truncated)`;
    return { text, name: best.name, kind: kindName(best.kind) };
  }

  private _displayUri(uri: vscode.Uri): { path: string; rootId?: string } {
    const identity = this._identity.fromUri(uri);
    return identity.ok ? this._identity.display(identity.value) : { path: uri.fsPath.replace(/\\/g, "/") };
  }

  private _validateTextEditUris(edit: vscode.WorkspaceEdit): string | undefined {
    const invalid = inspectWorkspaceEdit(edit).touchedUris.find((uri) => !this._identity.contains(uri));
    return invalid ? `The language provider proposed an edit outside the open workspace: ${invalid.fsPath || invalid.toString()}` : undefined;
  }

  private _mutationReceipt(
    ctx: LspContext,
    result: {
      edits: number;
      saved?: boolean;
      changes?: Array<{ path: string; additions: number; deletions: number }>;
      resourceOperations?: number;
      resourceOperationDetails?: InspectedResourceOperation[];
      touchedUris?: vscode.Uri[];
    },
    diagnostics: unknown,
    commands: Array<{ id: string; status: "completed" | "failed" | "timed_out" }> = [],
    touchedUris: vscode.Uri[] = [],
  ): Record<string, unknown> {
    return {
      status: result.saved === false ? "uncertain" : "applied",
      transactionId: ctx.transactionId,
      textEdits: result.edits,
      changes: result.changes ?? [],
      resourceOperations: result.resourceOperationDetails?.length
        ? result.resourceOperationDetails.map((operation) => ({
            kind: operation.kind,
            from: operation.from ? this._displayUri(operation.from) : undefined,
            to: operation.to ? this._displayUri(operation.to) : undefined,
            destructive: operation.destructive || undefined,
          }))
        : result.resourceOperations ? [{ kind: "unknown", count: result.resourceOperations }] : [],
      commands,
      touchedFiles: dedupeUris([...(result.touchedUris ?? []), ...touchedUris]).map((uri) => this._displayUri(uri)),
      saved: result.saved !== false,
      diagnostics,
    };
  }

  private _publishedWorkspaceUris(required: vscode.Uri[]): vscode.Uri[] {
    const published = vscode.languages.getDiagnostics()
      .map(([uri]) => uri)
      .filter((uri) => this._identity.contains(uri));
    return dedupeUris([...required, ...published]);
  }

  /** Explains an empty result: if the file's language has a known recommended
      extension that isn't installed, say so; otherwise undefined (leaves the
      caller's own generic message in place — a real server may simply have
      found nothing, which is not an error). */
  private _noProviderHint(path: string, feature: string): string | undefined {
    const missing = missingExtensionFor(path);
    return missing ? noProviderNotice(feature, missing.lang, missing.extensionId) : undefined;
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function parseTarget(payload: Record<string, unknown>): Target | null {
  const t = payload["target"];
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (typeof o["path"] !== "string" || !o["path"]) return null;
  return {
    path: o["path"],
    rootId: typeof o["rootId"] === "string" ? o["rootId"] : undefined,
    symbol: typeof o["symbol"] === "string" ? o["symbol"] : undefined,
    kind: typeof o["kind"] === "string" ? o["kind"] : undefined,
    line: typeof o["line"] === "number" ? o["line"] : undefined,
    column: typeof o["column"] === "number" ? o["column"] : undefined,
    matchText: typeof o["matchText"] === "string" ? o["matchText"] : undefined,
    firstMatch: o["firstMatch"] === true,
  };
}

function buildSymbolTree(list: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): unknown[] {
  return list.map((s) => {
    if (isDocumentSymbol(s)) {
      return {
        name: s.name,
        kind: kindName(s.kind),
        line: s.range.start.line + 1,
        endLine: s.range.end.line + 1,
        detail: s.detail || undefined,
        children: s.children?.length ? buildSymbolTree(s.children) : undefined,
      };
    }
    return {
      name: s.name,
      kind: kindName(s.kind),
      line: s.location.range.start.line + 1,
      container: s.containerName || undefined,
    };
  });
}

function locParts(loc: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  if ("targetUri" in loc) return { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange };
  return { uri: loc.uri, range: loc.range };
}

function resolveInsertPosition(
  doc: vscode.TextDocument,
  range: vscode.Range,
  mode: "before" | "after" | "start" | "end",
): vscode.Position {
  if (mode === "before") return new vscode.Position(range.start.line, 0);
  if (mode === "start") return range.start;
  if (mode === "end") return range.end;
  const afterLine = range.end.line;
  if (afterLine >= doc.lineCount - 1) {
    return range.end;
  }
  return new vscode.Position(afterLine + 1, 0);
}

function isDocumentSymbol(s: vscode.DocumentSymbol | vscode.SymbolInformation): s is vscode.DocumentSymbol {
  return (s as vscode.DocumentSymbol).selectionRange !== undefined;
}

function isCodeAction(a: vscode.CodeAction | vscode.Command): a is vscode.CodeAction {
  return typeof (a as vscode.Command).command !== "string";
}

function stringifyMarkdown(c: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof c === "string") return c;
  if ("value" in c) return c.value;
  return "";
}

function stringifyInlayTooltip(tooltip: string | vscode.MarkdownString | undefined): string | undefined {
  if (typeof tooltip === "string") return tooltip;
  return tooltip?.value;
}

function dedupeLocations<T extends vscode.Location | vscode.LocationLink>(locations: T[]): T[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const { uri, range } = locParts(location);
    const key = `${uri.toString()}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareLocations(a: vscode.Location | vscode.LocationLink, b: vscode.Location | vscode.LocationLink): number {
  const left = locParts(a);
  const right = locParts(b);
  return left.uri.toString().localeCompare(right.uri.toString())
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character;
}

function compareHierarchyRelatives(a: HierarchyRelative, b: HierarchyRelative): number {
  return a.item.uri.toString().localeCompare(b.item.uri.toString())
    || a.item.selectionRange.start.line - b.item.selectionRange.start.line
    || a.item.selectionRange.start.character - b.item.selectionRange.start.character
    || a.item.name.localeCompare(b.item.name);
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
}

function hierarchyItemId(item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem): string {
  const identity = [
    item.uri.toString(),
    item.name,
    item.kind,
    item.selectionRange.start.line,
    item.selectionRange.start.character,
    item.selectionRange.end.line,
    item.selectionRange.end.character,
  ].join("\u0000");
  return `hierarchy:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function mapProviderValue<T, U>(outcome: ProviderOutcome<T>, map: (value: T) => U): ProviderOutcome<U> {
  return outcome.status === "ok" ? { ...outcome, value: map(outcome.value) } : outcome;
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function commandReceiptStatus(outcome: ProviderOutcome<unknown>): "failed" | "timed_out" {
  return outcome.status === "timeout" || outcome.status === "cancelled" ? "timed_out" : "failed";
}

function commandFailureMessage(feature: string, outcome: CommandOutcome): string {
  return outcome.commandRejected && outcome.status === "error"
    ? outcome.message
    : providerFailureMessage(feature, outcome);
}

function unknownDiagnosticSnapshot(): Record<string, unknown> {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 };
  return {
    status: "unknown",
    scope: "file",
    counts,
    allCounts: counts,
    errors: 0,
    warnings: 0,
    problems: [],
    totalFound: 0,
    truncated: false,
    freshness: { observedDiagnosticChange: false, waitedMs: 0, documentVersions: {} },
    coverage: { diagnosticUris: 0 },
  };
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await map(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeRange(range: vscode.Range): { line: number; column: number; endLine: number; endColumn: number } {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function validateLineRange(
  document: vscode.TextDocument,
  value: { startLine?: unknown; endLine?: unknown } | undefined,
): { ok: true; range?: vscode.Range } | { ok: false; error: string } {
  if (!value) return { ok: true };
  const startLine = num(value.startLine);
  const endLine = num(value.endLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return { ok: false, error: "range.startLine and range.endLine must be 1-based integers." };
  }
  if (startLine! < 1 || startLine! > document.lineCount) {
    return { ok: false, error: `range.startLine must be between 1 and ${document.lineCount}.` };
  }
  if (endLine! < startLine! || endLine! > document.lineCount) {
    return { ok: false, error: `range.endLine must be between ${startLine} and ${document.lineCount}.` };
  }
  const startIndex = startLine! - 1;
  const endIndex = endLine! - 1;
  return { ok: true, range: new vscode.Range(startIndex, 0, endIndex, document.lineAt(endIndex).text.length) };
}

function expectedVersion(uri: vscode.Uri, version: number): Map<string, number> {
  return new Map([[uri.toString(), version]]);
}

function applyFailure(operation: string, reason: "rejected" | "conflict" | "apply_failed" | "outside_workspace" | undefined): string {
  if (reason === "conflict") return `The document changed while the ${operation} was awaiting approval. Resolve the target again and retry.`;
  if (reason === "outside_workspace") return `The ${operation} targeted a URI outside the open workspace and was blocked.`;
  if (reason === "apply_failed") return `VS Code could not apply or persist the ${operation}.`;
  return `User rejected the ${operation}.`;
}

function looksLikeActionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function kindName(k: number): string { return SYMBOL_KIND_NAMES[k] ?? "symbol"; }
function num(v: unknown): number | undefined { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : undefined; }
function clamp(v: number, min: number, max: number): number { return Math.min(Math.max(v, min), max); }
function rangeSize(r: vscode.Range): number { return (r.end.line - r.start.line) * 1000 + (r.end.character - r.start.character); }
