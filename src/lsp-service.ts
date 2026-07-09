import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { WorkspaceEditApplier } from "./workspace-edit-applier.js";
import { collectForUris } from "./post-edit-diagnostics.js";
import {
  execProvider,
  incomingCalls,
  LSP_TIMEOUT_MS,
  outgoingCalls,
  subtypes,
  supertypes,
  withWarmup,
} from "./lsp-queries.js";
import { withAbort, withDeadline } from "./lsp-cancellation.js";
import { formatActiveSignature } from "./lsp-signature-format.js";
import { missingExtensionFor } from "./graph/language-support.js";
import { noProviderNotice } from "./lsp-provider-hint.js";

// ── Public surface (keeps vscode types out of AgentSession) ──────────────────

export interface LspContext {
  autoApprove: boolean;
  signal?: AbortSignal;
}

export interface SymbolRef {
  name: string;
  kind: string;
  path: string;
  line: number;
  container?: string;
}

export type LspResult =
  | { ok: true; notice?: string; [key: string]: unknown }
  | { ok: false; error: string; ambiguous?: boolean; candidates?: SymbolRef[] };

export interface LspProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult>;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface Target {
  path: string;
  symbol?: string;
  kind?: string;
  line?: number;
  column?: number;
  matchText?: string;
  firstMatch?: boolean;
}

interface FlatSym {
  name: string;
  kind: number;
  container?: string;
  selection: vscode.Position;
  range: vscode.Range;
  uri: vscode.Uri;
}

interface CodeLocation {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  snippet: string;
  symbol?: string;
  kind?: string;
}

type Resolved = { ok: true; uri: vscode.Uri; position: vscode.Position; range: vscode.Range; doc: vscode.TextDocument; symbolName?: string };

const MAX_RESULTS = 100;
const HARD_MAX = 500;
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
const SEVERITY_NAMES = ["error", "warning", "info", "hint"];
const SEVERITY_THRESHOLD: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

// ── LspService ───────────────────────────────────────────────────────────────

export class LspService implements LspProvider {
  constructor(
    private readonly _workspaceRoot: string,
    private readonly _applier: WorkspaceEditApplier,
  ) {}

  async dispatch(op: string, payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    try {
      switch (op) {
        case "symbols":     return await this._symbols(payload, ctx);
        case "navigate":    return await this._navigate(payload, ctx);
        case "hierarchy":   return await this._hierarchy(payload, ctx);
        case "hover":       return await this._hover(payload, ctx);
        case "diagnostics": return await this._diagnostics(payload);
        case "rename":      return await this._rename(payload, ctx);
        case "actions":     return await this._actions(payload, ctx);
        case "format":      return await this._format(payload, ctx);
        case "insert":      return await this._insert(payload, ctx);
        case "inlayHints":  return await this._inlayHints(payload, ctx);
        default:            return { ok: false, error: `Unknown code-intelligence op: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── code_symbols ───────────────────────────────────────────────────────────

  private async _symbols(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const query = typeof payload["query"] === "string" ? payload["query"].trim() : "";
    const p     = typeof payload["path"] === "string" ? payload["path"] : "";
    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);

    if (query) {
      const raw = await this._withWarmup(
        () => withAbort(this._exec<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query), ctx.signal),
        (r) => !r || r.length === 0,
        ctx,
      ) ?? [];
      const symbols = raw.slice(0, limit).map((s) => ({
        name: s.name,
        kind: kindName(s.kind),
        container: s.containerName || undefined,
        path: this._relPath(s.location.uri),
        line: s.location.range.start.line + 1,
      }));
      return { ok: true, scope: "workspace", query, symbols, totalFound: raw.length, truncated: raw.length > symbols.length };
    }

    if (p) {
      const uri = this._resolveUri(p);
      const raw = await withAbort(this._exec<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", uri), ctx.signal) ?? [];
      const notice = raw.length === 0 ? this._noProviderHint(p, "symbol") : undefined;
      return { ok: true, scope: "document", path: this._relPath(uri), symbols: buildSymbolTree(raw), notice };
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
    if (!resolved.ok) return resolved;

    const limit   = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const context = clamp(num(payload["context"]) ?? 0, 0, 3);
    const wantBody = payload["includeBody"] === true && kind !== "references";

    const raw = await this._withWarmup(
      () => withAbort(this._exec<(vscode.Location | vscode.LocationLink)[]>(command, resolved.uri, resolved.position), ctx.signal),
      (r) => !r || r.length === 0,
      ctx,
    ) ?? [];

    const sliced = raw.slice(0, limit);
    const locations: CodeLocation[] = [];
    for (const loc of sliced) {
      const { uri, range } = locParts(loc);
      locations.push(await this._toCodeLocation(uri, range, context, wantBody, ctx));
    }

    const notice = locations.length === 0 ? this._noProviderHint(target.path, kind) : undefined;
    return {
      ok: true,
      kind,
      target: { path: target.path, line: resolved.position.line + 1, column: resolved.position.character + 1, symbol: resolved.symbolName },
      locations,
      totalFound: raw.length,
      truncated: raw.length > sliced.length,
      notice,
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
    if (!resolved.ok) return resolved;
    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);

    const relatives: Array<{ item: vscode.CallHierarchyItem | vscode.TypeHierarchyItem; callCount?: number }> = [];
    if (kind === "callers") {
      const calls = await this._withWarmup(() => withAbort(incomingCalls(resolved.uri, resolved.position), ctx.signal), (r) => !r || r.length === 0, ctx) ?? [];
      for (const c of calls) relatives.push({ item: c.from, callCount: c.fromRanges.length });
    } else if (kind === "callees") {
      const calls = await this._withWarmup(() => withAbort(outgoingCalls(resolved.uri, resolved.position), ctx.signal), (r) => !r || r.length === 0, ctx) ?? [];
      for (const c of calls) relatives.push({ item: c.to, callCount: c.fromRanges.length });
    } else {
      const query = kind === "supertypes" ? supertypes : subtypes;
      const items = await this._withWarmup(() => withAbort(query(resolved.uri, resolved.position), ctx.signal), (r) => !r || r.length === 0, ctx) ?? [];
      for (const item of items) relatives.push({ item });
    }

    const sliced = relatives.slice(0, limit);
    const results = sliced.map(({ item, callCount }) => ({
      symbol: item.name,
      kind: kindName(item.kind),
      path: this._relPath(item.uri),
      line: item.selectionRange.start.line + 1,
      detail: item.detail || undefined,
      callCount,
    }));

    const notice = relatives.length === 0 ? this._noProviderHint(target.path, kind) : undefined;
    return {
      ok: true,
      kind,
      target: { path: target.path, line: resolved.position.line + 1, symbol: resolved.symbolName },
      results,
      totalFound: relatives.length,
      truncated: relatives.length > sliced.length,
      notice,
    };
  }

  // ── code_hover ─────────────────────────────────────────────────────────────

  private async _hover(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;

    const [hovers, signatureHelp] = await Promise.all([
      this._withWarmup(
        () => withAbort(this._exec<vscode.Hover[]>("vscode.executeHoverProvider", resolved.uri, resolved.position), ctx.signal),
        (r) => !r || r.length === 0,
        ctx,
      ),
      // Not warmup-wrapped: an empty result here (cursor outside a call expression) is a
      // normal, frequent, correct outcome, not a cold-server symptom.
      withAbort(this._exec<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", resolved.uri, resolved.position), ctx.signal),
    ]);

    const text = (hovers ?? [])
      .flatMap((h) => h.contents.map(stringifyMarkdown))
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");
    const sigLine = formatActiveSignature(signatureHelp);
    const combined = [sigLine, text].filter(Boolean).join("\n\n");

    if (!combined) {
      const hint = this._noProviderHint(target.path, "hover");
      return { ok: false, error: hint ?? "No hover information at the target (the language server may still be indexing)." };
    }
    return { ok: true, text: combined.slice(0, 4000), path: target.path, line: resolved.position.line + 1, symbol: resolved.symbolName };
  }

  // ── code_diagnostics ───────────────────────────────────────────────────────

  private async _diagnostics(payload: Record<string, unknown>): Promise<LspResult> {
    const p     = typeof payload["path"] === "string" ? payload["path"] : "";
    const sev   = typeof payload["severity"] === "string" ? payload["severity"].toLowerCase() : "";
    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const threshold = SEVERITY_THRESHOLD[sev];

    const entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = p
      ? [[this._resolveUri(p), vscode.languages.getDiagnostics(this._resolveUri(p))]]
      : vscode.languages.getDiagnostics();

    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    const flat: Array<{ uri: vscode.Uri; d: vscode.Diagnostic }> = [];
    for (const [uri, diags] of entries) {
      for (const d of diags) {
        const name = SEVERITY_NAMES[d.severity] ?? "info";
        counts[name as keyof typeof counts]++;
        if (threshold !== undefined && d.severity > threshold) continue;
        flat.push({ uri, d });
      }
    }
    flat.sort((a, b) => a.d.severity - b.d.severity);

    const sliced = flat.slice(0, limit);
    const docCache = new Map<string, vscode.TextDocument>();
    const problems = [];
    for (const { uri, d } of sliced) {
      let snippet = "";
      try {
        const key = uri.toString();
        let doc = docCache.get(key);
        if (!doc) { doc = await vscode.workspace.openTextDocument(uri); docCache.set(key, doc); }
        snippet = doc.lineAt(d.range.start.line).text.trim();
      } catch { /* snippet stays empty */ }
      problems.push({
        path: this._relPath(uri),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        severity: SEVERITY_NAMES[d.severity] ?? "info",
        message: d.message,
        source: typeof d.source === "string" ? d.source : undefined,
        code: stringifyCode(d.code),
        snippet,
      });
    }

    return { ok: true, scope: p ? "file" : "workspace", counts, problems, totalFound: flat.length, truncated: flat.length > sliced.length };
  }

  // ── code_rename ────────────────────────────────────────────────────────────

  private async _rename(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const newName = String(payload["newName"] ?? "").trim();
    if (!newName) return { ok: false, error: "newName is required." };

    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;

    const declineReason = await this._checkPrepareRename(resolved.uri, resolved.position, ctx);
    if (declineReason) return { ok: false, error: declineReason };

    const edit = await withAbort(this._exec<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", resolved.uri, resolved.position, newName), ctx.signal);
    if (!edit || edit.size === 0) {
      const hint = this._noProviderHint(target.path, "rename");
      return { ok: false, error: hint ?? "The language server returned no rename edits (the symbol may not be renameable here)." };
    }

    const label = resolved.symbolName ?? target.symbol ?? "symbol";
    const res = await this._applier.apply(edit, { summary: `Rename '${label}' to '${newName}'`, autoApprove: ctx.autoApprove });
    if (!res.applied) return { ok: false, error: "User rejected the rename." };

    const diagnostics = await collectForUris(edit.entries().map(([uri]) => uri), this._workspaceRoot);
    return { ok: true, newName, files: res.files, edits: res.edits, diagnostics, autoApproveAll: res.autoApproveAll || undefined };
  }

  /** vscode.prepareRename validates the position before we attempt the real rename,
      and — unlike execProvider — its rejection carries a specific, useful reason
      (e.g. "You cannot rename this element") that we don't want swallowed to
      undefined. A provider that doesn't implement prepareRename resolves rather
      than rejects, so this only fires on an explicit decline. */
  private async _checkPrepareRename(uri: vscode.Uri, position: vscode.Position, ctx: LspContext): Promise<string | undefined> {
    try {
      await withDeadline(
        Promise.resolve(vscode.commands.executeCommand("vscode.prepareRename", uri, position)),
        LSP_TIMEOUT_MS,
        ctx.signal,
      );
      return undefined;
    } catch (err) {
      if (ctx.signal?.aborted) throw err; // real cancellation, not a rename-specific decline
      return `Cannot rename here: ${err instanceof Error ? err.message : String(err)}`;
    }
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

    const uri = this._resolveUri(p);
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${p}.` }; }

    const startLine = clamp(line - 1, 0, doc.lineCount - 1);
    const lastLine  = clamp(endLine - 1, startLine, doc.lineCount - 1);
    const range = new vscode.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);

    // itemResolveCount forces VS Code to resolve lazy `.edit` payloads so we can apply them.
    const raw = await withAbort(this._exec<(vscode.CodeAction | vscode.Command)[]>(
      "vscode.executeCodeActionProvider", uri, range, only, apply ? 50 : 0,
    ), ctx.signal) ?? [];

    if (!apply) {
      const actions = raw.map((a) => isCodeAction(a)
        ? { title: a.title, kind: a.kind?.value, isPreferred: a.isPreferred || undefined }
        : { title: a.title, command: a.command });
      if (actions.length === 0) {
        const notice = this._noProviderHint(p, "code action");
        return { ok: true, actions, message: "No code actions available for that range.", notice };
      }
      return { ok: true, actions };
    }

    const lower = apply.toLowerCase();
    const chosen = raw.find((a) => a.title.toLowerCase() === lower) ?? raw.find((a) => a.title.toLowerCase().startsWith(lower));
    if (!chosen) {
      return { ok: false, error: `No code action matched '${apply}'. Available: ${raw.map((a) => a.title).slice(0, 8).join(", ") || "none"}.` };
    }

    let applied = false;
    let diagUris: vscode.Uri[] = [uri];
    if (isCodeAction(chosen)) {
      if (chosen.edit && chosen.edit.size > 0) {
        const res = await this._applier.apply(chosen.edit, { summary: `Code action: ${chosen.title}`, autoApprove: ctx.autoApprove });
        if (!res.applied) return { ok: false, error: "User rejected the code action." };
        applied = true;
        diagUris = chosen.edit.entries().map(([u]) => u);
        if (chosen.command) await this._runCommand(chosen.command);
        const diagnostics = await collectForUris(diagUris, this._workspaceRoot);
        return { ok: true, title: chosen.title, files: res.files, edits: res.edits, diagnostics, autoApproveAll: res.autoApproveAll || undefined };
      }
      if (chosen.command) { await this._runCommand(chosen.command); applied = true; }
    } else {
      await this._runCommand(chosen); applied = true;
    }

    if (!applied) return { ok: false, error: `Code action '${chosen.title}' could not be resolved to an edit headlessly.` };
    const diagnostics = await collectForUris(diagUris, this._workspaceRoot);
    return { ok: true, title: chosen.title, ranEditorCommand: true, diagnostics };
  }

  // ── code_format ────────────────────────────────────────────────────────────

  private async _format(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const uri = this._resolveUri(p);
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${p}.` }; }

    const cfg = vscode.workspace.getConfiguration("editor", uri);
    const options = { tabSize: cfg.get<number>("tabSize") ?? 2, insertSpaces: cfg.get<boolean>("insertSpaces") ?? true };

    const rangeArg = payload["range"] as { startLine?: unknown; endLine?: unknown } | undefined;
    let edits: vscode.TextEdit[] | undefined;
    if (rangeArg && num(rangeArg.startLine) !== undefined && num(rangeArg.endLine) !== undefined) {
      const startLine = clamp(num(rangeArg.startLine)! - 1, 0, doc.lineCount - 1);
      const lastLine  = clamp(num(rangeArg.endLine)! - 1, startLine, doc.lineCount - 1);
      const range = new vscode.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);
      edits = await withAbort(this._exec<vscode.TextEdit[]>("vscode.executeFormatRangeProvider", uri, range, options), ctx.signal);
    } else {
      edits = await withAbort(this._exec<vscode.TextEdit[]>("vscode.executeFormatDocumentProvider", uri, options), ctx.signal);
    }

    if (!edits || edits.length === 0) {
      const notice = this._noProviderHint(p, "formatting");
      return { ok: true, formatted: false, message: "No formatting changes (already formatted or no formatter for this language).", notice };
    }

    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) edit.replace(uri, e.range, e.newText);
    const res = await this._applier.apply(edit, { summary: `Format ${this._relPath(uri)}`, autoApprove: ctx.autoApprove });
    if (!res.applied) return { ok: false, error: "User rejected the formatting." };
    return { ok: true, formatted: true, edits: res.edits, autoApproveAll: res.autoApproveAll || undefined };
  }

  // ── code_inlay_hints ───────────────────────────────────────────────────────

  private async _inlayHints(payload: Record<string, unknown>, ctx: LspContext): Promise<LspResult> {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const uri = this._resolveUri(p);
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${p}.` }; }

    // executeInlayHintProvider has no whole-document overload (unlike format's two
    // commands) — it always requires a range, so synthesize one when omitted.
    const rangeArg = payload["range"] as { startLine?: unknown; endLine?: unknown } | undefined;
    let range: vscode.Range;
    if (rangeArg && num(rangeArg.startLine) !== undefined && num(rangeArg.endLine) !== undefined) {
      const startLine = clamp(num(rangeArg.startLine)! - 1, 0, doc.lineCount - 1);
      const lastLine  = clamp(num(rangeArg.endLine)! - 1, startLine, doc.lineCount - 1);
      range = new vscode.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);
    } else {
      const lastLine = doc.lineCount - 1;
      range = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);
    }

    const limit = clamp(num(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const raw = await withAbort(this._exec<vscode.InlayHint[]>("vscode.executeInlayHintProvider", uri, range), ctx.signal) ?? [];
    const sliced = raw.slice(0, limit);
    const hints = sliced.map((h) => ({
      line: h.position.line + 1,
      column: h.position.character + 1,
      label: typeof h.label === "string" ? h.label : h.label.map((part) => part.value).join(""),
      kind: h.kind === vscode.InlayHintKind.Type ? "type" : h.kind === vscode.InlayHintKind.Parameter ? "parameter" : undefined,
    }));

    if (hints.length === 0) {
      const notice = this._noProviderHint(p, "inlay hint");
      return { ok: true, path: this._relPath(uri), hints, notice };
    }
    return { ok: true, path: this._relPath(uri), hints, totalFound: raw.length, truncated: raw.length > sliced.length };
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

    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;

    const insertPosition = resolveInsertPosition(resolved.doc, resolved.range, positionMode as "before" | "after" | "start" | "end");
    const edit = new vscode.WorkspaceEdit();
    edit.insert(resolved.uri, insertPosition, text);

    const label = resolved.symbolName ?? target.symbol ?? `${target.path}:${resolved.position.line + 1}`;
    const res = await this._applier.apply(edit, {
      summary: `Insert code ${positionMode} ${label}`,
      autoApprove: ctx.autoApprove,
    });
    if (!res.applied) return { ok: false, error: "User rejected the insertion." };

    const diagnostics = await collectForUris([resolved.uri], this._workspaceRoot);
    return {
      ok: true,
      path: this._relPath(resolved.uri),
      line: insertPosition.line + 1,
      column: insertPosition.character + 1,
      diagnostics,
      autoApproveAll: res.autoApproveAll || undefined,
    };
  }

  private async _runCommand(command: vscode.Command): Promise<void> {
    await this._exec(command.command, ...(command.arguments ?? []));
  }

  // ── Position resolution ────────────────────────────────────────────────────

  private async _resolveTarget(target: Target, ctx?: LspContext): Promise<Resolved | { ok: false; error: string; ambiguous?: boolean; candidates?: SymbolRef[] }> {
    const uri = this._resolveUri(target.path);
    let doc: vscode.TextDocument;
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { return { ok: false, error: `Could not open ${target.path}.` }; }

    if (target.symbol) {
      const flat = await this._flatDocumentSymbols(uri, ctx);
      const matches = flat.filter((s) => symbolMatches(s, target.symbol!, target.kind));
      if (matches.length === 0) {
        const near = flat.slice(0, 8).map((s) => s.name).join(", ");
        return { ok: false, error: `Symbol '${target.symbol}' not found in ${target.path}.${near ? ` Nearby symbols: ${near}.` : ""}` };
      }
      if (matches.length > 1 && !target.firstMatch) {
        return {
          ok: false,
          ambiguous: true,
          error: `'${target.symbol}' matches ${matches.length} symbols in ${target.path}. Pass kind, line, or firstMatch:true to disambiguate.`,
          candidates: matches.map((m) => this._toRef(m)),
        };
      }
      const m = matches[0]!;
      return { ok: true, uri, position: m.selection, range: m.range, doc, symbolName: m.name };
    }

    if (typeof target.line === "number") {
      const lineIdx = Math.max(0, target.line - 1);
      if (lineIdx >= doc.lineCount) return { ok: false, error: `Line ${target.line} is out of range (${doc.lineCount} lines in ${target.path}).` };
      const lineText = doc.lineAt(lineIdx).text;
      let col: number;
      if (target.matchText) {
        const i = lineText.indexOf(target.matchText);
        col = i >= 0 ? i : firstNonWs(lineText);
      } else if (typeof target.column === "number") {
        col = Math.max(0, target.column - 1);
      } else {
        col = firstNonWs(lineText);
      }
      return {
        ok: true,
        uri,
        position: new vscode.Position(lineIdx, col),
        range: new vscode.Range(lineIdx, 0, lineIdx, lineText.length),
        doc,
      };
    }

    return { ok: false, error: "Provide `symbol` or `line` in target." };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _flatDocumentSymbols(uri: vscode.Uri, ctx?: LspContext): Promise<FlatSym[]> {
    const syms = await this._withWarmup(
      () => withAbort(this._exec<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", uri), ctx?.signal),
      (r) => !r || r.length === 0,
      ctx ?? { autoApprove: false },
    ) ?? [];

    const out: FlatSym[] = [];
    const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], container?: string): void => {
      for (const s of list) {
        if (isDocumentSymbol(s)) {
          out.push({ name: s.name, kind: s.kind, container, selection: s.selectionRange.start, range: s.range, uri });
          if (s.children?.length) walk(s.children, container ? `${container}.${s.name}` : s.name);
        } else {
          out.push({ name: s.name, kind: s.kind, container: s.containerName || undefined, selection: s.location.range.start, range: s.location.range, uri: s.location.uri });
        }
      }
    };
    walk(syms);
    return out;
  }

  private async _toCodeLocation(uri: vscode.Uri, range: vscode.Range, context: number, wantBody: boolean, ctx?: LspContext): Promise<CodeLocation> {
    let snippet = "";
    let symbol: string | undefined;
    let kind: string | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (wantBody) {
        const body = await this._symbolBody(doc, range.start, ctx);
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
      path: this._relPath(uri),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
      snippet,
      symbol,
      kind,
    };
  }

  private async _symbolBody(doc: vscode.TextDocument, position: vscode.Position, ctx?: LspContext): Promise<{ text: string; name?: string; kind?: string }> {
    const flat = await this._flatDocumentSymbols(doc.uri, ctx);
    let best: FlatSym | undefined;
    for (const s of flat) {
      if (s.range.contains(position) && (!best || rangeSize(s.range) < rangeSize(best.range))) best = s;
    }
    if (!best) return { text: doc.lineAt(position.line).text.trim() };
    let text = doc.getText(best.range);
    const lines = text.split("\n");
    if (lines.length > 200) text = `${lines.slice(0, 200).join("\n")}\n… (truncated)`;
    return { text, name: best.name, kind: kindName(best.kind) };
  }

  private _toRef(s: FlatSym): SymbolRef {
    return { name: s.name, kind: kindName(s.kind), path: this._relPath(s.uri), line: s.selection.line + 1, container: s.container };
  }

  private async _exec<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
    /* Shared primitive layer — same timeout the Map's symbol queries use. */
    return execProvider<T>(command, ...args);
  }

  private async _withWarmup<T>(fn: () => Promise<T | undefined>, isEmpty: (r: T | undefined) => boolean, ctx: LspContext): Promise<T | undefined> {
    return withWarmup(fn, isEmpty, { signal: ctx.signal });
  }

  private _resolveUri(p: string): vscode.Uri {
    if (path.isAbsolute(p)) return vscode.Uri.file(p);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = path.join(folder.uri.fsPath, p);
      if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
    return vscode.Uri.file(path.join(this._workspaceRoot, p));
  }

  private _relPath(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const base = folder?.uri.fsPath ?? this._workspaceRoot;
    const rel = path.relative(base, uri.fsPath).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : uri.fsPath.replace(/\\/g, "/");
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
    symbol: typeof o["symbol"] === "string" ? o["symbol"] : undefined,
    kind: typeof o["kind"] === "string" ? o["kind"] : undefined,
    line: typeof o["line"] === "number" ? o["line"] : undefined,
    column: typeof o["column"] === "number" ? o["column"] : undefined,
    matchText: typeof o["matchText"] === "string" ? o["matchText"] : undefined,
    firstMatch: o["firstMatch"] === true,
  };
}

function symbolMatches(s: FlatSym, name: string, kind?: string): boolean {
  const qualified = s.container ? `${s.container}.${s.name}` : s.name;
  const nameOk = s.name === name || qualified === name || qualified.endsWith(`.${name}`);
  if (!nameOk) return false;
  if (kind && kindName(s.kind).toLowerCase() !== kind.toLowerCase()) return false;
  return true;
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

function stringifyCode(code: vscode.Diagnostic["code"]): string | undefined {
  if (code == null) return undefined;
  if (typeof code === "string" || typeof code === "number") return String(code);
  if (typeof code === "object" && "value" in code) return String(code.value);
  return undefined;
}

function kindName(k: number): string { return SYMBOL_KIND_NAMES[k] ?? "symbol"; }
function num(v: unknown): number | undefined { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : undefined; }
function clamp(v: number, min: number, max: number): number { return Math.min(Math.max(v, min), max); }
function firstNonWs(s: string): number { const i = s.search(/\S/); return i >= 0 ? i : 0; }
function rangeSize(r: vscode.Range): number { return (r.end.line - r.start.line) * 1000 + (r.end.character - r.start.character); }
