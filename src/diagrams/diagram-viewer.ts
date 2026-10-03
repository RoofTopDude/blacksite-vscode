/* The Mermaid diagram viewer: one diagram per editor tab, with pan, zoom, a minimap, a live
   source editor, and export (apps/diagram in the webview does all of that).

   A diagram can also be backed by a file in the project's saved diagrams
   (.blacksite/context/diagrams/, see diagram-store.ts). That tab follows the file: when the
   agent patches it with diagram_edit, or anything else saves it, the tab redraws in place and
   keeps its pan and zoom. Edits made in the tab's source panel can be saved back to the file.

   A diagram in the chat is drawn to the width of a side panel, which is exactly where a
   non-trivial one stops being legible. This is where it goes to be read properly. Every way
   in funnels through one command — the Open action on rendered Markdown in any panel (via
   workspace-ui-host.ts), the CodeLens above a ```mermaid fence in a Markdown file, and the
   command palette with the cursor in a fence — so they all behave the same way.

   Panels are keyed by source: opening a diagram that is already open reveals its tab rather
   than stacking a duplicate. The webview persists its own state (source, edits, theme), which
   is what lets the serializer bring a tab back after a window reload. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderWebviewHtml } from "../webview-html.js";
import {
  MAX_DIAGRAM_SOURCE_CHARS,
  diagramDisplayTitle,
  diagramFileStem,
  findMermaidFences,
  mermaidFenceAt,
} from "../shared/mermaid-source.js";
import { DiagramStore } from "./diagram-store.js";

export const DIAGRAM_VIEW_TYPE = "blacksite.diagramViewer";
export const OPEN_DIAGRAM_COMMAND = "blacksite.openDiagram";
export const SAVE_DIAGRAM_COMMAND = "blacksite.saveDiagramToProject";

/** A 4× PNG of a very large diagram is the biggest thing the viewer sends; anything past this
 *  is not an export the webview produced. */
const MAX_EXPORT_BYTES = 48 * 1024 * 1024;
const MAX_TITLE_CHARS = 120;

/** A usable diagram source from an untrusted message or command argument, or undefined. */
export function openDiagramSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_DIAGRAM_SOURCE_CHARS) return undefined;
  return value;
}

export interface OpenDiagramArgs {
  source?: unknown;
  /** Absolute path of a saved diagram to open file-backed. */
  file?: unknown;
}

/** What apps/diagram persists through writeUiState("diagram", …). */
interface PersistedViewerState {
  diagram?: { source?: unknown; file?: { path?: unknown } | null };
}

/** What one open tab is showing, and the file behind it if it has one. */
interface PanelEntry {
  panel: vscode.WebviewPanel;
  /** The key this tab is registered under in DiagramViewer's panel map. */
  key: string;
  source: string;
  /** Absolute path of the saved diagram this tab follows. */
  file?: string;
  watcher?: vscode.FileSystemWatcher;
}

const fileKey = (file: string): string => `file:${path.resolve(file)}`;

export type DiagramExportFormat = "svg" | "png";

export interface DiagramSaveRequest {
  format: DiagramExportFormat;
  fileName: string;
  /** SVG markup, or base64 PNG bytes (no data: prefix). */
  data: string;
}

/** Validate a save message from the webview. The file name only seeds the save dialog, but
 *  it is still reduced to a bare name so it cannot point the dialog somewhere unexpected. */
export function parseSaveRequest(message: Record<string, unknown>): DiagramSaveRequest | undefined {
  const format = message.format;
  if (format !== "svg" && format !== "png") return undefined;
  if (typeof message.data !== "string" || !message.data || message.data.length > MAX_EXPORT_BYTES) return undefined;
  // win32.basename strips both separators, so the result is the same whichever OS runs the host.
  const requested = typeof message.fileName === "string" ? path.win32.basename(message.fileName) : "";
  const stem = requested.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80) || "diagram";
  return { format, fileName: `${stem}.${format}`, data: message.data };
}

export class DiagramViewer implements vscode.Disposable {
  private readonly _panels = new Map<string, PanelEntry>();
  private readonly _disposables: vscode.Disposable[] = [];
  private _fonts?: Promise<{ latin?: string; latinExt?: string }>;
  private _store?: DiagramStore;
  private _root?: string;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  /** Where saved diagrams live. Set once the workspace root is known, which is after the viewer
   *  is registered (the panel serializer has to be in place before VS Code restores tabs). */
  setWorkspaceRoot(root: string): void {
    this._root = root;
    this._store = new DiagramStore(root);
  }

  register(): this {
    this._disposables.push(
      vscode.commands.registerCommand(OPEN_DIAGRAM_COMMAND, (args?: OpenDiagramArgs) => this._openFromCommand(args)),
      vscode.commands.registerCommand(SAVE_DIAGRAM_COMMAND, (args?: OpenDiagramArgs) => this._saveFromCommand(args)),
      vscode.window.registerWebviewPanelSerializer(DIAGRAM_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: unknown) => {
          const persisted = (state as PersistedViewerState | undefined)?.diagram;
          const remembered = persisted?.file?.path;
          const file = typeof remembered === "string" && this._root ? path.resolve(this._root, remembered) : undefined;
          // A tab that followed a file comes back showing the file as it is now, if it still exists.
          const onDisk = file ? this._readSaved(file) : undefined;
          const source = openDiagramSource(onDisk ?? persisted?.source);
          if (!source) { panel.dispose(); return; }
          this._attach(panel, source, onDisk !== undefined ? file : undefined);
        },
      }),
    );
    return this;
  }

  dispose(): void {
    for (const entry of [...this._panels.values()]) entry.panel.dispose();
    this._panels.clear();
    for (const disposable of this._disposables.splice(0)) disposable.dispose();
  }

  /** Open a diagram in its own tab, or reveal the tab it is already open in. */
  open(source: string): void {
    const existing = this._panels.get(source);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      return;
    }
    this._create(source);
  }

  /** Open a saved diagram file-backed, or reveal the tab already following it. */
  openFile(file: string): boolean {
    const existing = this._panels.get(fileKey(file));
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      return true;
    }
    const source = openDiagramSource(this._readSaved(file));
    if (!source) return false;
    this._create(source, file);
    return true;
  }

  private _create(source: string, file?: string): void {
    const panel = vscode.window.createWebviewPanel(
      DIAGRAM_VIEW_TYPE,
      diagramDisplayTitle(source),
      vscode.ViewColumn.Active,
      this._webviewOptions(),
    );
    this._attach(panel, source, file);
  }

  /** A saved diagram's text, if `file` is inside the project's diagrams folder and readable. */
  private _readSaved(file: string): string | undefined {
    const store = this._store;
    const name = store?.nameOf(path.resolve(file));
    if (!store || !name) return undefined;
    const saved = store.read(name);
    return saved.ok ? saved.source : undefined;
  }

  private _webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      // Pan, zoom, and an in-progress edit survive switching tabs.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
  }

  private _attach(panel: vscode.WebviewPanel, source: string, file?: string): void {
    const entry: PanelEntry = { panel, key: file ? fileKey(file) : source, source, ...(file ? { file: path.resolve(file) } : {}) };
    this._panels.set(entry.key, entry);
    if (entry.file) this._watch(entry);
    panel.webview.options = this._webviewOptions();
    panel.iconPath = {
      light: vscode.Uri.joinPath(this._context.extensionUri, "media", "diagram-view-light.svg"),
      dark: vscode.Uri.joinPath(this._context.extensionUri, "media", "diagram-view-dark.svg"),
    };
    panel.title = diagramDisplayTitle(source);
    panel.webview.html = renderWebviewHtml(panel.webview, this._context.extensionUri, "diagram.js");

    const receive = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object") return;
      void this._onMessage(entry, message as Record<string, unknown>).catch((error: unknown) => {
        void panel.webview.postMessage({ type: "diagram_notice", level: "error", message: errorText(error) });
      });
    });
    panel.onDidDispose(() => {
      receive.dispose();
      entry.watcher?.dispose();
      if (this._panels.get(entry.key) === entry) this._panels.delete(entry.key);
    });
  }

  /** Redraw the tab whenever its file changes on disk. */
  private _watch(entry: PanelEntry): void {
    entry.watcher?.dispose();
    const file = entry.file;
    if (!file) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
    const refresh = (): void => {
      const source = openDiagramSource(this._readSaved(file));
      if (!source || source === entry.source) return;
      entry.source = source;
      entry.panel.title = diagramDisplayTitle(source);
      void entry.panel.webview.postMessage({ type: "diagram_update", source, file: this._fileInfo(file) });
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(() => {
      void entry.panel.webview.postMessage({
        type: "diagram_notice",
        level: "error",
        message: `${path.basename(file)} was deleted. This tab still shows the last version; Save to project writes it back.`,
      });
    });
    entry.watcher = watcher;
  }

  private _fileInfo(file: string): { name: string; path: string } {
    const relative = this._root ? path.relative(this._root, file).split(path.sep).join("/") : file;
    return { name: path.basename(file), path: relative.startsWith("..") ? file : relative };
  }

  private async _onMessage(entry: PanelEntry, message: Record<string, unknown>): Promise<void> {
    const panel = entry.panel;
    switch (message.type) {
      case "diagram_ready":
        await panel.webview.postMessage({
          type: "diagram_init",
          source: entry.source,
          ...(entry.file ? { file: this._fileInfo(entry.file) } : {}),
          fonts: await this._fontData(),
        });
        return;
      case "diagram_write": {
        // Edits from the tab's source panel, saved back to the file this tab follows.
        const source = openDiagramSource(message.source);
        const store = this._store;
        const name = entry.file ? store?.nameOf(entry.file) : undefined;
        if (!source || !store || !name) {
          await panel.webview.postMessage({ type: "diagram_notice", level: "error", message: "This diagram is not backed by a saved file." });
          return;
        }
        const written = store.write(name, source, { overwrite: true });
        if (!written.ok) {
          await panel.webview.postMessage({ type: "diagram_notice", level: "error", message: written.error });
          return;
        }
        entry.source = source;
        await panel.webview.postMessage({ type: "diagram_update", source, file: this._fileInfo(entry.file!) });
        await panel.webview.postMessage({ type: "diagram_notice", level: "info", message: `Saved ${written.name}` });
        return;
      }
      case "diagram_save_to_project": {
        const source = openDiagramSource(message.source);
        if (!source) return;
        const saved = this._saveNew(source);
        if (!saved) {
          await panel.webview.postMessage({ type: "diagram_notice", level: "error", message: "Open a folder to save diagrams with the project." });
          return;
        }
        // The tab becomes the file's tab from here on, so later edits can be saved back to it.
        this._panels.delete(entry.key);
        entry.file = saved.absolute;
        entry.key = fileKey(saved.absolute);
        entry.source = source;
        this._panels.set(entry.key, entry);
        this._watch(entry);
        await panel.webview.postMessage({ type: "diagram_update", source, file: this._fileInfo(saved.absolute) });
        await panel.webview.postMessage({
          type: "diagram_notice",
          level: "info",
          message: `Saved to ${saved.relative} — the agent can edit it with diagram_edit`,
        });
        return;
      }
      case "diagram_title":
        if (typeof message.title === "string" && message.title.trim()) {
          panel.title = message.title.trim().slice(0, MAX_TITLE_CHARS);
        }
        return;
      case "diagram_save": {
        const request = parseSaveRequest(message);
        if (!request) return;
        const saved = await this._save(request);
        if (saved) {
          await panel.webview.postMessage({ type: "diagram_notice", level: "info", message: `Saved ${path.basename(saved.fsPath)}` });
        }
        return;
      }
    }
  }

  private async _save(request: DiagramSaveRequest): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, request.fileName) : undefined,
      filters: request.format === "svg" ? { "SVG image": ["svg"] } : { "PNG image": ["png"] },
      saveLabel: "Export diagram",
      title: `Export diagram as ${request.format.toUpperCase()}`,
    });
    if (!target) return undefined;
    const bytes = request.format === "svg"
      ? new TextEncoder().encode(request.data)
      : new Uint8Array(Buffer.from(request.data, "base64"));
    await vscode.workspace.fs.writeFile(target, bytes);
    return target;
  }

  /** Lexend, base64, for the webview to embed in exported SVG and PNG. An exported file is
   *  opened where the panel's font is not installed, and a label measured in one face and
   *  drawn in another overflows its box. */
  private _fontData(): Promise<{ latin?: string; latinExt?: string }> {
    const read = async (name: string): Promise<string | undefined> => {
      const file = path.join(this._context.extensionUri.fsPath, "out", "webview", "fonts", name);
      try { return (await fs.promises.readFile(file)).toString("base64"); } catch { return undefined; }
    };
    this._fonts ??= Promise.all([read("lexend-latin.woff2"), read("lexend-latin-ext.woff2")])
      .then(([latin, latinExt]) => ({ latin, latinExt }));
    return this._fonts;
  }

  /** Write `source` as a new saved diagram, under a name derived from its title. */
  private _saveNew(source: string): { absolute: string; relative: string } | undefined {
    const store = this._store;
    if (!store) return undefined;
    const written = store.write(store.freeName(diagramFileStem(source)), source);
    const absolute = written.ok ? store.resolve(written.name) : undefined;
    return written.ok && absolute ? { absolute, relative: written.file } : undefined;
  }

  /** The Save action on a diagram in the chat or another panel. */
  private async _saveFromCommand(args?: OpenDiagramArgs): Promise<void> {
    const source = openDiagramSource(args?.source);
    if (!source) {
      void vscode.window.showWarningMessage(`Blacksite: That diagram is empty or longer than ${MAX_DIAGRAM_SOURCE_CHARS.toLocaleString()} characters.`);
      return;
    }
    const saved = this._saveNew(source);
    if (!saved) {
      void vscode.window.showWarningMessage("Blacksite: Open a folder to save diagrams with the project.");
      return;
    }
    const open = "Open";
    const choice = await vscode.window.showInformationMessage(
      `Blacksite: Saved ${saved.relative}. The agent can read and edit it, and the viewer follows it as it changes.`,
      open,
    );
    if (choice === open) this.openFile(saved.absolute);
  }

  private async _openFromCommand(args?: OpenDiagramArgs): Promise<void> {
    if (typeof args?.file === "string") {
      if (!this.openFile(args.file)) {
        void vscode.window.showWarningMessage("Blacksite: That saved diagram is missing, empty, or too large to open.");
      }
      return;
    }
    const fromArgs = openDiagramSource(args?.source);
    if (fromArgs) { this.open(fromArgs); return; }
    if (args?.source !== undefined) {
      void vscode.window.showWarningMessage(`Blacksite: That diagram is empty or longer than ${MAX_DIAGRAM_SOURCE_CHARS.toLocaleString()} characters.`);
      return;
    }

    const source = diagramSourceFromEditor(vscode.window.activeTextEditor);
    if (source) { this.open(source); return; }
    void vscode.window.showInformationMessage(
      "Blacksite: Put the cursor inside a ```mermaid block, or select Mermaid source, then run Open Mermaid Diagram again.",
    );
  }
}

/** The diagram the user most plausibly means in an editor: a selection, the fence under the
 *  cursor, or a whole .mmd / .mermaid file. */
export function diagramSourceFromEditor(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) return undefined;
  const { document, selection } = editor;
  if (!selection.isEmpty) return openDiagramSource(document.getText(selection));
  const fence = mermaidFenceAt(document.getText(), selection.active.line);
  if (fence) return openDiagramSource(fence.source);
  if (/\.(?:mmd|mermaid)$/i.test(document.fileName) || document.languageId === "mermaid") {
    return openDiagramSource(document.getText());
  }
  return undefined;
}

/** "Open diagram" above every ```mermaid fence in a Markdown file. */
export class MermaidCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._changed.event;
  private readonly _config = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("blacksite.diagrams.codeLens")) this._changed.fire();
  });

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("blacksite").get<boolean>("diagrams.codeLens", true)) return [];
    return findMermaidFences(document.getText())
      .filter((fence) => openDiagramSource(fence.source))
      .map((fence) => new vscode.CodeLens(new vscode.Range(fence.startLine, 0, fence.startLine, 0), {
        title: "$(preview) Open diagram",
        tooltip: "Open this diagram in the Blacksite viewer, with pan, zoom, and export",
        command: OPEN_DIAGRAM_COMMAND,
        arguments: [{ source: fence.source }],
      }));
  }

  dispose(): void {
    this._config.dispose();
    this._changed.dispose();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
