/* Editor-tab webview for the Map Notes timeline: a scrollable, interactive
   history of the working-memory notes the agent (and user) attached to the
   Codebase Map, enriched with each noted file's recent git history and
   one-click commit diffs. Modeled on GraphProvider.openFullPage(): a regular
   WebviewPanel so VS Code's split-editor controls can place it beside code.
   Message shapes mirror src/webview/react/lib/notes/protocol.ts — keep in sync. */

import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { GraphAnnotationStore } from "./graph-annotation-store.js";
import { fromNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";

const MAX_HISTORY_COMMITS = 40;
const GIT_TIMEOUT_MS = 8000;
/** Virtual-document scheme serving a file's content at a specific commit, so
    commit diffs open in VS Code's native diff editor without touching disk. */
const GIT_SCHEME = "blacksite-note-git";

interface GitDocParams {
  /** Repository toplevel (absolute). */
  top: string;
  /** Commit-ish; empty string means "empty file" (initial-commit base). */
  rev: string;
  /** Repo-relative POSIX path. */
  rel: string;
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** Parse `git log --format=%H%x09%ct%x09%an%x09%s` output. Exported for tests. */
export function parseNoteFileLog(stdout: string): Array<{ hash: string; at: number; author: string; subject: string }> {
  const out: Array<{ hash: string; at: number; author: string; subject: string }> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    const [hash = "", at = "", author = "", ...subject] = line.split("\t");
    const epoch = Number(at);
    if (!/^[0-9a-f]{7,40}$/i.test(hash) || !Number.isFinite(epoch)) continue;
    out.push({ hash, at: epoch, author, subject: subject.join("\t") });
  }
  return out;
}

export class NotesTimelineProvider implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private readonly _subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _annotations: GraphAnnotationStore,
    /** Focus the Map surface and fly to a file's star (wired to GraphProvider). */
    private readonly _revealOnMap?: (nodeId: string) => void,
  ) {
    this._subscriptions.push(
      this._annotations.onDidChange(() => this._postNotes()),
      vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
        provideTextDocumentContent: async (uri) => {
          const params = this._parseGitDocUri(uri);
          if (!params) return "";
          if (!params.rev) return ""; /* empty base for an initial commit */
          return (await runGit(params.top, ["show", `${params.rev}:${params.rel}`])) ?? "";
        },
      }),
    );
  }

  dispose(): void {
    this._panel?.dispose();
    for (const sub of this._subscriptions) sub.dispose();
  }

  /** Open (or reveal) the timeline tab. */
  open(): void {
    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "blacksite.map.notes",
      "Blacksite: Map Notes",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
      },
    );
    this._panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    panel.webview.html = renderWebviewHtml(panel.webview, this._context.extensionUri, "notes.js");
    const receive = panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
    );
    // Resync on every reveal — annotations can change (e.g. via the Map) while this tab is
    // hidden; retainContextWhenHidden keeps it alive but doesn't guarantee an intervening
    // onDidChange push was observed the instant it fired.
    const viewState = panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) this._postNotes();
    });
    panel.onDidDispose(() => {
      receive.dispose();
      viewState.dispose();
      this._panel = undefined;
    });
    this._postNotes();
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (String(msg.type ?? "")) {
      case "ready":
        this._postNotes();
        break;
      case "open_file": {
        const rel = String(msg.path ?? "");
        const absolute = rel ? fromNodeId(this._roots(), rel) : null;
        if (!absolute) return;
        try {
          const doc = await vscode.workspace.openTextDocument(absolute);
          const line = Number(msg.line);
          const options: vscode.TextDocumentShowOptions = { preview: true };
          if (Number.isFinite(line) && line >= 0) options.selection = new vscode.Range(line, 0, line, 0);
          await vscode.window.showTextDocument(doc, options);
        } catch {
          vscode.window.showWarningMessage(`Blacksite: Could not open ${rel}.`);
        }
        break;
      }
      case "reveal_on_map":
        this._revealOnMap?.(String(msg.path ?? ""));
        break;
      case "remove_note": {
        const id = String(msg.id ?? "").trim();
        if (id) this._annotations.remove(id);
        break;
      }
      case "file_history":
        await this._sendFileHistory(String(msg.path ?? ""));
        break;
      case "open_commit_diff":
        await this._openCommitDiff(String(msg.path ?? ""), String(msg.hash ?? ""), typeof msg.subject === "string" ? msg.subject : undefined);
        break;
    }
  }

  private _postNotes(): void {
    if (!this._panel) return;
    const roots = this._roots();
    void this._panel.webview.postMessage({
      type: "notes_state",
      notes: this._annotations.read().annotations,
      workspaceName: path.basename(roots[0]?.path ?? "") || "workspace",
    });
  }

  /** Locate a noted file in its git repo: absolute path, repo toplevel, and
      repo-relative POSIX path — or null when it isn't in a repo. */
  private async _locateInRepo(rel: string): Promise<{ absolute: string; top: string; repoRel: string } | null> {
    const absolute = rel ? fromNodeId(this._roots(), rel) : null;
    if (!absolute) return null;
    const dir = path.dirname(absolute);
    const topRaw = await runGit(dir, ["rev-parse", "--show-toplevel"]);
    const top = topRaw?.split("\n")[0]?.trim();
    if (!top) return null;
    const repoRel = path.relative(top, absolute).replace(/\\/g, "/");
    if (repoRel.startsWith("..")) return null;
    return { absolute, top, repoRel };
  }

  private async _sendFileHistory(rel: string): Promise<void> {
    if (!this._panel) return;
    const post = (commits: unknown[], error?: string) =>
      void this._panel?.webview.postMessage({ type: "file_history", path: rel, commits, ...(error ? { error } : {}) });
    const located = await this._locateInRepo(rel);
    if (!located) {
      post([], "No git history available for this file.");
      return;
    }
    const stdout = await runGit(located.top, [
      "-c", "core.quotePath=false",
      "log",
      "--follow",
      "-n", String(MAX_HISTORY_COMMITS),
      "--format=%H%x09%ct%x09%an%x09%s",
      "--",
      located.repoRel,
    ]);
    if (stdout == null) {
      post([], "Could not read git history for this file.");
      return;
    }
    post(parseNoteFileLog(stdout));
  }

  private _gitDocUri(params: GitDocParams, label: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: GIT_SCHEME,
      /* The path's basename names the diff tab; keep the real extension last
         so the editor picks the right language for highlighting. */
      path: `/${label}`,
      query: JSON.stringify(params),
    });
  }

  private _parseGitDocUri(uri: vscode.Uri): GitDocParams | null {
    try {
      const parsed = JSON.parse(uri.query) as Partial<GitDocParams>;
      if (typeof parsed.top !== "string" || typeof parsed.rel !== "string" || typeof parsed.rev !== "string") return null;
      if (!/^[0-9a-f]{0,40}$/i.test(parsed.rev)) return null; /* commit hash or empty only — never an arbitrary git argument */
      return { top: parsed.top, rev: parsed.rev, rel: parsed.rel };
    } catch {
      return null;
    }
  }

  /** Open commit-vs-parent in the native diff editor (initial commits diff
      against an empty base). */
  private async _openCommitDiff(rel: string, hash: string, subject?: string): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return;
    const located = await this._locateInRepo(rel);
    if (!located) {
      vscode.window.showWarningMessage(`Blacksite: ${rel} is not in a git repository.`);
      return;
    }
    const parentRaw = await runGit(located.top, ["rev-parse", `${hash}^`]);
    const parent = parentRaw?.split("\n")[0]?.trim() ?? "";
    const base = path.posix.basename(located.repoRel);
    const short = hash.slice(0, 7);
    const left = this._gitDocUri({ top: located.top, rev: /^[0-9a-f]{7,40}$/i.test(parent) ? parent : "", rel: located.repoRel }, `${short}~ ${base}`);
    const right = this._gitDocUri({ top: located.top, rev: hash, rel: located.repoRel }, `${short} ${base}`);
    const title = `${base} @ ${short}${subject ? ` — ${subject}` : ""}`;
    try {
      await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
    } catch {
      vscode.window.showWarningMessage(`Blacksite: Could not open the diff for ${short}.`);
    }
  }
}
