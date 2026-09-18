import { bindWorkspaceUi } from "./workspace-ui-host.js";
// The Skills panel: the user's authoring surface for skills.
//
// Follows BaseContextProvider's shape (view-scoped subscriptions, resync on reveal, state
// posted as one message) rather than inventing a second pattern. What is specific here is
// the draft lane: the panel lints a skill the user is still typing, which needs the same
// rules the store enforces on save but must not touch disk. lintSkill is therefore called
// directly rather than going through SkillStore.write.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import {
  lintSkill,
  parseSkillFile,
  serializeSkillFile,
  RECOMMENDED_BODY_LINES,
  MAX_DESCRIPTION_CHARS,
  type SkillFrontmatter,
} from "./skills/skill-format.js";
import { resolveSkillAvailability, type SkillStore } from "./skills/skill-store.js";

const SKILL_FILE = "SKILL.md";

/** Seed body for a new skill — a shape to edit, not a blank page. */
const STARTER_BODY = `# What this covers

Describe when this procedure applies, and when it does not.

## Steps

1. …
2. …

## Failure modes

- …
`;

export class SkillsProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _viewSubscriptions: vscode.Disposable[] = [];
  private readonly _watcher?: vscode.FileSystemWatcher;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _workspaceRoot: string,
    private readonly _store: SkillStore,
    /** Capability tokens the active session has, for the availability column. */
    private readonly _capabilities: () => ReadonlySet<string>,
    /** Prefills the chat input; the user still presses send. See _draftWithAgent. */
    private readonly _injectChatContext?: (text: string, label: string) => void,
  ) {
    // Skills are plain files the user may edit in the editor, in another window, or via
    // git. Watching them keeps the panel honest without a refresh button being the only
    // way to see reality.
    try {
      this._watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this._store.workspaceSkillsDir(), "**/*.md"),
      );
      const onChange = () => { this._store.invalidate(); this._postState(); };
      this._watcher.onDidChange(onChange);
      this._watcher.onDidCreate(onChange);
      this._watcher.onDidDelete(onChange);
    } catch { /* no workspace folder — the panel still lists bundled and user skills */ }
  }

  dispose(): void {
    this._watcher?.dispose();
    this._disposeViewSubscriptions();
    this._view = undefined;
  }

  /** Called when the agent writes a skill, so the panel does not show a stale catalog. */
  refresh(): void {
    this._store.invalidate();
    this._postState();
  }

  private _disposeViewSubscriptions(): void {
    for (const subscription of this._viewSubscriptions.splice(0)) subscription.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._disposeViewSubscriptions();
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "skills.js");
    this._viewSubscriptions.push(
      bindWorkspaceUi(webviewView.webview, this._context),
      webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => void this._onMessage(msg)),
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this._postState(); }),
      webviewView.onDidDispose(() => { if (this._view === webviewView) this._view = undefined; }),
    );
    this._postState();
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (String(msg.type ?? "")) {
      case "ready":
      case "refresh":
        this._store.invalidate();
        this._postState();
        break;

      case "set_enabled":
        this._store.setEnabled(String(msg.name ?? ""), msg.enabled === true);
        this._postState();
        break;

      case "lint_draft":
        this._postLint(msg);
        break;

      case "save_draft":
        await this._saveDraft(msg);
        break;

      case "open_skill":
        await this._openSkill(String(msg.name ?? ""));
        break;

      case "delete_skill":
        await this._deleteSkill(String(msg.name ?? ""));
        break;

      case "draft_with_agent":
        await this._draftWithAgent(String(msg.prompt ?? ""));
        break;
    }
  }

  /** Frontmatter for a draft, assembled from the form fields rather than parsed from text. */
  private _draftFrontmatter(msg: Record<string, unknown>): SkillFrontmatter {
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.map(String).map((s) => s.trim()).filter(Boolean) : [];
    const mode = String(msg.mode ?? "").trim().toLowerCase();
    return {
      name: String(msg.name ?? "").trim().toLowerCase(),
      description: String(msg.description ?? "").trim(),
      ...(list(msg.scope).length ? { scope: list(msg.scope) } : {}),
      ...(list(msg.requires).length ? { requires: list(msg.requires) } : {}),
      ...(mode === "plan" || mode === "review" || mode === "debug" ? { mode } : {}),
    };
  }

  private _postLint(msg: Record<string, unknown>): void {
    if (!this._view) return;
    const frontmatter = this._draftFrontmatter(msg);
    const body = String(msg.body ?? "");
    const existing = frontmatter.name ? this._store.find(frontmatter.name) : null;
    void this._view.webview.postMessage({
      type: "skill_lint",
      issues: lintSkill(frontmatter, body),
      bodyLines: body ? body.split("\n").length : 0,
      recommendedBodyLines: RECOMMENDED_BODY_LINES,
      descriptionMax: MAX_DESCRIPTION_CHARS,
      // Warn before the save, not after: "you are about to shadow the bundled skill of the
      // same name" is a decision, and finding out afterwards reads as the edit having failed.
      shadowWarning: existing && existing.origin !== "workspace"
        ? `A ${existing.origin} skill named '${frontmatter.name}' already exists. Saving creates a workspace copy that shadows it; the original is left unchanged.`
        : undefined,
    });
  }

  private async _saveDraft(msg: Record<string, unknown>): Promise<void> {
    const frontmatter = this._draftFrontmatter(msg);
    const body = String(msg.body ?? "").trim() || STARTER_BODY;
    const issues = lintSkill(frontmatter, body);
    if (issues.some((issue) => issue.severity === "error")) {
      this._postLint(msg);
      return;
    }
    try {
      const written = this._store.write(frontmatter.name, serializeSkillFile(frontmatter, body));
      this._postState();
      void this._view?.webview.postMessage({ type: "skill_saved", name: frontmatter.name, path: written.path });
      vscode.window.showInformationMessage(`Blacksite: Saved skill '${frontmatter.name}' to ${written.path}.`);
    } catch (err) {
      vscode.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _openSkill(name: string): Promise<void> {
    const record = this._store.find(name);
    if (!record) return;
    const file = path.join(record.dir, SKILL_FILE);
    if (!fs.existsSync(file)) {
      vscode.window.showWarningMessage(`Blacksite: ${SKILL_FILE} for '${name}' no longer exists.`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(file);
    // Bundled skills live inside the installed extension; opening one read-only makes it
    // obvious that edits there would be lost on the next update.
    await vscode.window.showTextDocument(document, { preview: false });
    if (record.origin === "bundled") {
      vscode.window.showInformationMessage(
        `'${name}' is a built-in skill. Edits here are replaced on update — use "Copy to workspace" to make a version this repository owns.`,
      );
    }
  }

  private async _deleteSkill(name: string): Promise<void> {
    const record = this._store.find(name);
    if (!record) return;
    if (record.origin !== "workspace") {
      vscode.window.showWarningMessage(
        `Blacksite: '${name}' is a ${record.origin} skill and cannot be deleted here. Disable it instead.`,
      );
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete the skill '${name}'?`,
      { modal: true, detail: `This removes ${path.relative(this._workspaceRoot, record.dir).replace(/\\/g, "/")} and everything in it.` },
      "Delete",
    );
    if (confirm !== "Delete") return;
    if (this._store.remove(name)) this._postState();
    else vscode.window.showWarningMessage(`Blacksite: Could not delete '${name}'.`);
  }

  /**
   * Hand the drafting job to the agent.
   *
   * Prefills the chat input rather than sending it, matching "Explain Selection" and
   * "Ask About This File": the request is composed for the user, and they send it. A panel
   * button that silently starts an agent run is a worse surprise than one extra keystroke,
   * and prefilling leaves room to redirect the brief before any tokens are spent.
   */
  private async _draftWithAgent(prompt: string): Promise<void> {
    const description = prompt.trim();
    if (!description) return;
    this._injectChatContext?.(
      [
        "Draft a new skill for this workspace, then save it with skill_write.",
        "",
        "The procedure to capture, in my words:",
        description,
        "",
        "Load the `authoring-skills` skill first if you have not already — it covers what belongs in a",
        "skill, how to write a description that actually gets the skill loaded, and progressive disclosure.",
        "Inspect the repository for the real conventions this procedure should encode rather than writing",
        "it generically. Show me the SKILL.md you intend to write before saving it.",
      ].join("\n"),
      "New skill",
    );
    await vscode.commands.executeCommand("blacksite.chat.focus");
  }

  private _postState(): void {
    if (!this._view) return;
    const records = this._store.list();
    let capabilities: ReadonlySet<string>;
    try { capabilities = this._capabilities(); }
    catch { capabilities = new Set(); }

    const resolved = resolveSkillAvailability(records, { capabilities, loaded: [], focusFiles: [] });
    void this._view.webview.postMessage({
      type: "skills_state",
      recommendedBodyLines: RECOMMENDED_BODY_LINES,
      descriptionMax: MAX_DESCRIPTION_CHARS,
      workspaceDir: path.relative(this._workspaceRoot, this._store.workspaceSkillsDir()).replace(/\\/g, "/"),
      skills: resolved.map(({ record, available, reason }) => ({
        name: record.name,
        description: record.description,
        origin: record.origin,
        enabled: record.enabled,
        available,
        unavailableReason: reason,
        mode: record.mode,
        scope: record.scope ?? [],
        requires: record.requires ?? [],
        files: record.files,
        shadows: record.shadows,
        bodyLines: record.bodyLines,
        issues: record.issues,
      })),
    });
  }

  /** Seed a draft from the active editor selection, for the editor-context action. */
  async scaffoldFromSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const selection = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : "";
    await vscode.commands.executeCommand("blacksite.skills.focus");
    void this._view?.webview.postMessage({ type: "skill_scaffold", body: selection, starter: STARTER_BODY });
  }

  /** Open a workspace copy of a bundled/user skill for editing. */
  async copyToWorkspace(name: string): Promise<void> {
    const record = this._store.find(name);
    if (!record || record.origin === "workspace") return;
    try {
      const raw = fs.readFileSync(path.join(record.dir, SKILL_FILE), "utf8");
      const parsed = parseSkillFile(raw, record.name);
      const written = this._store.write(record.name, serializeSkillFile({ ...parsed.frontmatter, name: record.name }, parsed.body));
      this._postState();
      const document = await vscode.workspace.openTextDocument(path.join(this._workspaceRoot, written.path));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      vscode.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
