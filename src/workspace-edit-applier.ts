import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceIdentity } from "./lsp/workspace-identity.js";
import {
  inspectWorkspaceEdit,
  type InspectedResourceOperation,
  type WorkspaceEditInspection,
} from "./lsp/workspace-edit-inspector.js";

export interface ApplyResult {
  applied: boolean;
  files: number;
  edits: number;
  /** Per-file line impact for previewable text edits. This is returned with the
   *  mutation result so the transcript can surface every affected file. */
  changes?: Array<{ path: string; additions: number; deletions: number }>;
  resourceOperations: number;
  resourceOperationDetails: InspectedResourceOperation[];
  touchedUris: vscode.Uri[];
  saved: boolean;
  reason?: "rejected" | "conflict" | "apply_failed" | "outside_workspace";
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
  provideTextDocumentContent(uri: vscode.Uri): string { return this._contents.get(uri.path.replace(/^\//, "")) ?? ""; }
  dispose(): void { this._emitter.dispose(); }
}

export interface EditApprovalRequest {
  summary: string;
  fileCount: number;
  resourceOperations?: number;
  resourceOperationDetails?: string[];
  destructive?: boolean;
  snippetEdits?: number;
  unpreviewableCommand?: string;
}

export type EditApprovalProvider = (request: EditApprovalRequest) => Promise<"apply" | "all" | "reject" | null>;

export interface WorkspaceEditApplyOptions {
  summary: string;
  autoApprove: boolean;
  expectedVersions?: ReadonlyMap<string, number>;
  /** A request-local approver takes precedence over the interactive chat provider. This is
   *  what keeps simultaneous unattended loop lanes scoped to their own ticket reviewer. */
  approvalProvider?: EditApprovalProvider;
  /** Unattended runs must not steal editor focus by opening proposal tabs. */
  showPreview?: boolean;
}

/** Shared preview, approval, version-check, apply, and save primitive. */
export class WorkspaceEditApplier {
  private readonly _proposed = new ProposedContentProvider();
  private readonly _registration: vscode.Disposable;
  private _counter = 0;
  private _applyQueue: Promise<void> = Promise.resolve();
  private _approvalProvider?: EditApprovalProvider;
  private readonly _identity: WorkspaceIdentity;

  constructor(private readonly _workspaceRoot: string) {
    this._registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this._proposed);
    this._identity = new WorkspaceIdentity(_workspaceRoot);
  }

  setApprovalProvider(provider: EditApprovalProvider | undefined): void { this._approvalProvider = provider; }

  dispose(): void {
    this._registration.dispose();
    this._proposed.dispose();
  }

  async apply(edit: vscode.WorkspaceEdit, opts: WorkspaceEditApplyOptions): Promise<ApplyResult> {
    const result = this._applyQueue.then(() => this._applyInternal(edit, opts));
    this._applyQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Commands cannot be diffed through the WorkspaceEdit API, so approval is explicit. */
  async confirmCommand(command: vscode.Command, approvalProvider?: EditApprovalProvider): Promise<boolean> {
    const summary = [
      `Run code action command: ${command.title || command.command}`,
      `Command ID: ${command.command}`,
      "This command may change files in ways VS Code cannot provide as a previewable WorkspaceEdit.",
    ].join("\n");
    const provider = approvalProvider ?? this._approvalProvider;
    const outcome = provider
      ? await provider({ summary, fileCount: 0, unpreviewableCommand: command.command })
      : null;
    if (outcome) return outcome !== "reject";
    const choice = await vscode.window.showWarningMessage(
      "Run an unpreviewable code action command?",
      { modal: true, detail: summary },
      "Run",
      "Reject",
    );
    return choice === "Run";
  }

  private async _applyInternal(edit: vscode.WorkspaceEdit, opts: WorkspaceEditApplyOptions): Promise<ApplyResult> {
    const inspection = inspectWorkspaceEdit(edit);
    const entries = inspection.textEntries;
    const resourceOperations = inspection.resourceOperations.length + inspection.opaqueResourceOperations;
    const files = Math.max(inspection.touchedUris.length, entries.length, edit.size);
    const edits = inspection.textEdits + inspection.snippetEdits;
    const changes = this._lineChanges(entries);
    if (edit.size === 0) return result(false, files, edits, inspection, true, "apply_failed");

    const outside = inspection.touchedUris.find((uri) => !this._identity.contains(uri));
    if (outside) return result(false, files, edits, inspection, false, "outside_workspace");

    const versions = await this._documentVersions(entries);
    if (!versionsMatch(opts.expectedVersions, versions)) {
      return result(false, files, edits, inspection, false, "conflict");
    }

    let decision: "apply" | "all" | "reject" = "apply";
    // Resource operations always receive explicit approval, even after Apply All.
    if (!opts.autoApprove || resourceOperations > 0 || inspection.snippetEdits > 0) {
      decision = await this._previewAndConfirm(entries, opts.summary, inspection, opts.approvalProvider, opts.showPreview !== false);
      if (decision === "reject") return result(false, files, edits, inspection, true, "rejected");
    }

    const currentVersions = await this._documentVersions(entries);
    if (!versionsMatch(versions, currentVersions) || !versionsMatch(opts.expectedVersions, currentVersions)) {
      return result(false, files, edits, inspection, false, "conflict");
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return result(false, files, edits, inspection, false, "apply_failed");
    const saveUris = [
      ...inspection.textUris,
      ...inspection.resourceOperations.flatMap((operation) => operation.to ? [operation.to] : []),
    ];
    const saved = await this._save(saveUris);
    return {
      applied: true,
      files,
      edits,
      resourceOperations,
      resourceOperationDetails: inspection.resourceOperations,
      touchedUris: inspection.touchedUris,
      saved,
      changes,
      autoApproveAll: decision === "all" || undefined,
    };
  }

  /** Convert every previewable TextEdit into a compact, per-file line impact.
   *  Range-based accounting is linear in the number of edits and avoids doing a
   *  quadratic whole-file diff for large formatter or refactor operations. */
  private _lineChanges(entries: ReadonlyArray<[vscode.Uri, readonly vscode.TextEdit[]]>): Array<{ path: string; additions: number; deletions: number }> {
    return entries.map(([uri, edits]) => {
      let additions = 0;
      let deletions = 0;
      for (const edit of edits) {
        additions += changedLineCount(edit.newText);
        deletions += changedLineCount(edit.range);
      }
      return { path: this._rel(uri), additions, deletions };
    });
  }

  private async _previewAndConfirm(
    entries: ReadonlyArray<[vscode.Uri, readonly vscode.TextEdit[]]>,
    summary: string,
    inspection: WorkspaceEditInspection,
    approvalProvider: EditApprovalProvider | undefined,
    showPreview: boolean,
  ): Promise<"apply" | "all" | "reject"> {
    const resourceOperations = inspection.resourceOperations.length + inspection.opaqueResourceOperations;
    try {
      if (showPreview) {
        for (const [uri, edits] of entries.slice(0, MAX_PREVIEW_DIFFS)) {
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            const proposed = applyTextEdits(document, edits);
            const base = path.basename(uri.fsPath);
            const proposedUri = this._proposed.set(`${++this._counter}/${base}`, proposed);
            await vscode.commands.executeCommand("vscode.diff", uri, proposedUri, `${base} ↔ Blacksite proposed`, { preview: false });
          } catch { /* the approval summary still reports an unpreviewable text resource */ }
        }
      }

      const detail = [
        summary,
        ...entries.map(([uri, edits]) => `${this._rel(uri)} — ${edits.length} edit(s)`),
        ...inspection.resourceOperations.map((operation) => this._resourceOperationLabel(operation)),
        inspection.opaqueResourceOperations > 0
          ? `${inspection.opaqueResourceOperations} opaque file resource operation(s) cannot be rendered as text diffs.`
          : "",
        inspection.destructive ? "Destructive or overwrite-capable resource operations require explicit review." : "",
        inspection.snippetEdits > 0 ? `${inspection.snippetEdits} snippet edit(s) cannot be rendered through WorkspaceEdit.entries().` : "",
        showPreview && entries.length > MAX_PREVIEW_DIFFS
          ? `${entries.length} files total; the first ${MAX_PREVIEW_DIFFS} are shown as diffs.`
          : "",
      ].filter(Boolean).join("\n");

      const provider = approvalProvider ?? this._approvalProvider;
      let outcome = provider
        ? await provider({
            summary: detail,
            fileCount: Math.max(entries.length, inspection.touchedUris.length),
            resourceOperations: resourceOperations || undefined,
            resourceOperationDetails: inspection.resourceOperations.map((operation) => this._resourceOperationLabel(operation)),
            destructive: inspection.destructive || undefined,
            snippetEdits: inspection.snippetEdits || undefined,
          })
        : null;
      if (!outcome) {
        const choice = await vscode.window.showWarningMessage(
          `Apply Blacksite changes to ${filesLabel(entries.length, resourceOperations)}?`,
          { modal: true, detail },
          "Apply",
          "Apply All",
          "Reject",
        );
        outcome = choice === "Apply All" ? "all" : choice === "Apply" ? "apply" : "reject";
      }
      return outcome;
    } finally {
      await this._closeProposedDiffs();
      this._proposed.clear();
    }
  }

  private async _closeProposedDiffs(): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === PROPOSED_SCHEME);
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  /** Saves every touched document to disk, so a tool result reporting success always means the
   *  change is on disk too — file_read and every other file-op tool read raw bytes off disk, not
   *  the VS Code buffer, so a silently-unsaved edit would otherwise look "applied" here while
   *  looking untouched to every subsequent read. Retries once after a short delay: the common
   *  failure is a transient external lock (antivirus, a sync client, a file watcher) that usually
   *  clears within milliseconds, not a real conflict. */
  private async _save(uris: vscode.Uri[]): Promise<boolean> {
    const seen = new Set<string>();
    let saved = true;
    for (const uri of uris) {
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        if (!document.isDirty) continue;
        if (await document.save()) continue;
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!(await document.save())) saved = false;
      } catch { saved = false; }
    }
    return saved;
  }

  private async _documentVersions(entries: ReadonlyArray<[vscode.Uri, readonly vscode.TextEdit[]]>): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    for (const [uri] of entries) {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        versions.set(uri.toString(), document.version);
      } catch { /* applyEdit will surface failure when the resource cannot be read */ }
    }
    return versions;
  }

  private _rel(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const base = folder?.uri.fsPath ?? this._workspaceRoot;
    const relative = path.relative(base, uri.fsPath).replace(/\\/g, "/");
    return relative && !relative.startsWith("..") ? relative : uri.fsPath.replace(/\\/g, "/");
  }

  private _resourceOperationLabel(operation: InspectedResourceOperation): string {
    if (operation.kind === "rename") return `Rename ${this._rel(operation.from!)} → ${this._rel(operation.to!)}`;
    if (operation.kind === "delete") return `Delete ${this._rel(operation.from!)}${operation.recursive ? " recursively" : ""}`;
    return `Create ${this._rel(operation.to!)}${operation.overwrite ? " (overwrite allowed)" : ""}`;
  }
}

function applyTextEdits(document: vscode.TextDocument, edits: readonly vscode.TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));
  let text = document.getText();
  for (const edit of sorted) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    text = text.slice(0, start) + edit.newText + text.slice(end);
  }
  return text;
}

function changedLineCount(value: string | vscode.Range): number {
  if (typeof value === "string") return value ? value.replace(/\r\n/g, "\n").split("\n").length : 0;
  if (value.isEmpty) return 0;
  const span = value.end.line - value.start.line + 1;
  // A range ending at the start of the next line does not consume that line.
  return value.end.character === 0 && value.end.line > value.start.line ? span - 1 : span;
}

function result(
  applied: boolean,
  files: number,
  edits: number,
  inspection: WorkspaceEditInspection,
  saved: boolean,
  reason: ApplyResult["reason"],
): ApplyResult {
  return {
    applied,
    files,
    edits,
    resourceOperations: inspection.resourceOperations.length + inspection.opaqueResourceOperations,
    resourceOperationDetails: inspection.resourceOperations,
    touchedUris: inspection.touchedUris,
    saved,
    reason,
  };
}

function versionsMatch(expected: ReadonlyMap<string, number> | undefined, actual: ReadonlyMap<string, number>): boolean {
  if (!expected) return true;
  for (const [uri, version] of expected) {
    if (actual.get(uri) !== version) return false;
  }
  return true;
}

function filesLabel(textFiles: number, resourceOperations: number): string {
  if (resourceOperations === 0) return `${textFiles} file(s)`;
  return `${textFiles} text file(s) plus ${resourceOperations} resource operation(s)`;
}
