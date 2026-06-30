import * as vscode from "vscode";
import * as path from "path";

// ── Shared "preview a WorkspaceEdit, then apply on approval" primitive ────────
// Used by both DiffEditService (file_edit) and LspService (rename/actions/format)
// so every mutating operation shares one diff-preview + approval UX.

export interface ApplyResult {
  applied: boolean;
  files: number;
  edits: number;
  /** True when the user chose "Apply All" — caller flips its session auto-approve flag. */
  autoApproveAll?: boolean;
}

const PROPOSED_SCHEME = "blacksite-proposed";
const MAX_PREVIEW_DIFFS = 6;

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _contents = new Map<string, string>();
  private readonly _emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._emitter.event;

  set(key: string, content: string): vscode.Uri {
    this._contents.set(key, content);
    const uri = vscode.Uri.parse(`${PROPOSED_SCHEME}:${key}`);
    this._emitter.fire(uri);
    return uri;
  }

  clear(): void { this._contents.clear(); }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.path.replace(/^\//, "")) ?? "";
  }

  dispose(): void { this._emitter.dispose(); }
}

/**
 * Resolve an edit approval; mirrors the modal's Apply / Apply All / Reject choices.
 * Returning `null` declines to handle it (e.g. no live UI turn), so the applier falls
 * back to the native modal.
 */
export type EditApprovalProvider = (request: { summary: string; fileCount: number }) => Promise<"apply" | "all" | "reject" | null>;

export class WorkspaceEditApplier {
  private readonly _proposed = new ProposedContentProvider();
  private readonly _registration: vscode.Disposable;
  private _counter = 0;
  private _applyQueue: Promise<unknown> = Promise.resolve();
  private _approvalProvider?: EditApprovalProvider;

  constructor(private readonly _workspaceRoot: string) {
    this._registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this._proposed);
  }

  /**
   * Route the apply/reject decision through the host UI (the chat webview) instead of a
   * native modal. When unset, falls back to the VS Code modal. The diff preview opens in
   * the editor either way.
   */
  setApprovalProvider(provider: EditApprovalProvider | undefined): void {
    this._approvalProvider = provider;
  }

  dispose(): void {
    this._registration.dispose();
    this._proposed.dispose();
  }

  /** Preview (unless auto-approving) then apply a WorkspaceEdit, saving touched documents. */
  async apply(edit: vscode.WorkspaceEdit, opts: { summary: string; autoApprove: boolean }): Promise<ApplyResult> {
    const result = new Promise<ApplyResult>((resolve, reject) => {
      this._applyQueue = this._applyQueue.then(async () => {
        try {
          const res = await this._applyInternal(edit, opts);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
    });
    return result;
  }

  private async _applyInternal(edit: vscode.WorkspaceEdit, opts: { summary: string; autoApprove: boolean }): Promise<ApplyResult> {
    const entries = edit.entries();
    const files = entries.length;
    const edits = entries.reduce((n, [, es]) => n + es.length, 0);

    if (files === 0 || edits === 0) {
      // No text edits to preview (may still carry resource ops) — apply directly.
      const applied = await vscode.workspace.applyEdit(edit);
      return { applied, files, edits };
    }

    let decision: "apply" | "all" | "reject" = "apply";
    if (!opts.autoApprove) {
      decision = await this._previewAndConfirm(entries, opts.summary);
      if (decision === "reject") return { applied: false, files, edits };
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) await this._save(entries.map(([uri]) => uri));
    return { applied, files, edits, autoApproveAll: decision === "all" || undefined };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _previewAndConfirm(
    entries: ReadonlyArray<[vscode.Uri, readonly vscode.TextEdit[]]>,
    summary: string,
  ): Promise<"apply" | "all" | "reject"> {
    for (const [uri, edits] of entries.slice(0, MAX_PREVIEW_DIFFS)) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const proposed = applyTextEdits(doc, edits);
        const base = path.basename(uri.fsPath);
        const proposedUri = this._proposed.set(`${++this._counter}/${base}`, proposed);
        await vscode.commands.executeCommand("vscode.diff", uri, proposedUri, `${base} ↔ Blacksite proposed`, { preview: false });
      } catch { /* skip preview for files we can't open */ }
    }

    const detail = [
      summary,
      "",
      ...entries.map(([uri, edits]) => `${this._rel(uri)} — ${edits.length} edit(s)`),
      entries.length > MAX_PREVIEW_DIFFS ? `\n(${entries.length} files total; first ${MAX_PREVIEW_DIFFS} shown as diffs)` : "",
    ].filter((l) => l !== "").join("\n");

    // In-UI approval: the diff is already open in the editor; the decision is made in the
    // chat webview rather than a native modal. Falls back to the modal when the provider
    // declines (returns null) or is unset.
    let outcome = this._approvalProvider
      ? await this._approvalProvider({ summary: detail, fileCount: entries.length })
      : null;
    if (!outcome) {
      const choice = await vscode.window.showWarningMessage(
        `Apply Blacksite changes to ${entries.length} file(s)?`,
        { modal: true, detail },
        "Apply",
        "Apply All",
        "Reject",
      );
      outcome = choice === "Apply All" ? "all" : choice === "Apply" ? "apply" : "reject";
    }

    await this._closeProposedDiffs();
    this._proposed.clear();

    return outcome;
  }

  private async _closeProposedDiffs(): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSED_SCHEME);
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  private async _save(uris: vscode.Uri[]): Promise<void> {
    const seen = new Set<string>();
    for (const uri of uris) {
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.isDirty) await doc.save();
      } catch { /* ignore */ }
    }
  }

  private _rel(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const base = folder?.uri.fsPath ?? this._workspaceRoot;
    const rel = path.relative(base, uri.fsPath).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : uri.fsPath.replace(/\\/g, "/");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Apply a set of TextEdits to a document's text (right-to-left) and return the result. */
function applyTextEdits(doc: vscode.TextDocument, edits: readonly vscode.TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
  let text = doc.getText();
  for (const e of sorted) {
    const start = doc.offsetAt(e.range.start);
    const end = doc.offsetAt(e.range.end);
    text = text.slice(0, start) + e.newText + text.slice(end);
  }
  return text;
}
