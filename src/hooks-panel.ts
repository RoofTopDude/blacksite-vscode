/* The Hooks page: lifecycle hooks as an editor tab.
 *
 * "Blacksite: Manage Hooks" was declared in package.json from 1.26.0 on but never registered,
 * so it answered "command not found", and the only way to configure a hook was hand-editing a
 * JSON array in user settings with nothing to say whether an entry would start. This page lists
 * every hook by event, edits them, shows whether each program can be found, runs one with a
 * sample payload, and shows recent runs.
 *
 * It writes to user settings only — the one place hooks are read from — so the trust model is
 * unchanged: a repository still cannot install a hook, and every hook here is one the user
 * added. */

import * as vscode from "vscode";
import { HOOK_EVENTS, locateHookProgram, validateHooks, type HookDefinition, type HookRunRecord } from "./hooks.js";
import { onHookRun, rawHookEntries, testHook, writeHookEntries } from "./hook-settings.js";
import { renderWebviewHtml } from "./webview-html.js";
import { bindWorkspaceUi } from "./workspace-ui-host.js";

interface RunView {
  at: string;
  event: string;
  command: string;
  toolName?: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

const MAX_RUNS = 30;

export class HooksPanel implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private readonly _runs: RunView[] = [];
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _tests = new Map<number, { summary: string; tone: string }>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _workspaceRoot: () => string,
    private readonly _showLog: () => void,
  ) {
    // Recorded even while the page is closed, so opening it after a failure shows the failure.
    this._subscriptions.push(onHookRun((record) => this._recordRun(record)));
    this._subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("blacksite.hooks.commands")) {
        this._tests.clear();
        this._post();
      }
    }));
    this._subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this._post()));
  }

  dispose(): void {
    this._panel?.dispose();
    for (const subscription of this._subscriptions) subscription.dispose();
    this._subscriptions.length = 0;
  }

  open(): void {
    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "blacksite.hooks",
      "Blacksite: Hooks",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
      },
    );
    this._panel = panel;
    panel.webview.html = renderWebviewHtml(panel.webview, this._context.extensionUri, "hooks.js");
    const workspaceUi = bindWorkspaceUi(panel.webview, this._context);
    const receive = panel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
      void this._onMessage(msg).catch((error: unknown) => {
        void panel.webview.postMessage({ type: "hooks_error", message: error instanceof Error ? error.message : String(error) });
      });
    });
    panel.onDidDispose(() => {
      receive.dispose();
      workspaceUi.dispose();
      this._panel = undefined;
    });
    this._post();
  }

  private _recordRun({ hook, input, failure, exitCode, decision, elapsedMs }: HookRunRecord): void {
    this._runs.unshift({
      at: new Date().toISOString(),
      event: input.event,
      command: [hook.command, ...(hook.args ?? [])].join(" ").slice(0, 200),
      toolName: input.toolName,
      ok: !failure && decision !== "block",
      detail: failure ? failure.split("\n")[0]!.slice(0, 300) : `exit ${exitCode ?? 0}${decision ? `, decision ${decision}` : ""}`,
      elapsedMs,
    });
    this._runs.length = Math.min(this._runs.length, MAX_RUNS);
    this._post();
  }

  /** The page's view of the setting: every raw entry, parsed where it parses, with the problem
   *  where it does not, so a broken entry can be fixed or removed here instead of in JSON. */
  private _state(): Record<string, unknown> {
    const raw = rawHookEntries();
    const root = this._workspaceRoot();
    const inspected = vscode.workspace.getConfiguration("blacksite.hooks").inspect<unknown[]>("commands");
    const shadowed = [inspected?.workspaceValue, inspected?.workspaceFolderValue].some((value) => Array.isArray(value) && value.length > 0);
    const entries = raw.map((entry, index) => {
      const { hooks, problems } = validateHooks([entry]);
      const hook = hooks[0];
      const found = hook ? locateHookProgram(hook.command, root) : undefined;
      return {
        index,
        hook: hook ?? null,
        raw: entry,
        problem: problems[0]?.message.replace(/^Invalid hook 1: /, "") ?? null,
        found: found ?? null,
        test: this._tests.get(index) ?? null,
      };
    });
    return {
      type: "hooks_state",
      events: HOOK_EVENTS,
      trusted: vscode.workspace.isTrusted,
      shadowed,
      tooMany: raw.length > 32,
      entries,
      runs: this._runs,
    };
  }

  private _post(): void {
    if (!this._panel) return;
    void this._panel.webview.postMessage(this._state());
  }

  /** A hook from the page's form, checked with the same rules the agent applies. */
  private _parseHook(value: unknown): HookDefinition {
    const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const hook: Record<string, unknown> = {
      event: input["event"],
      command: typeof input["command"] === "string" ? input["command"].trim() : input["command"],
    };
    if (Array.isArray(input["args"]) && input["args"].length) hook["args"] = input["args"];
    if (Array.isArray(input["tools"]) && input["tools"].length) hook["tools"] = input["tools"];
    if (typeof input["timeoutMs"] === "number" && input["timeoutMs"] !== 10_000) hook["timeoutMs"] = input["timeoutMs"];
    const { hooks, problems } = validateHooks([hook]);
    if (problems.length || !hooks[0]) throw new Error(problems[0]?.message.replace(/^Invalid hook 1: /, "") ?? "That hook is not valid.");
    return hooks[0];
  }

  /** The stored form: only the keys that are set, so settings.json stays readable. */
  private static _stored(hook: HookDefinition): Record<string, unknown> {
    return {
      event: hook.event,
      command: hook.command,
      ...(hook.args?.length ? { args: hook.args } : {}),
      ...(hook.tools?.length ? { tools: hook.tools } : {}),
      ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    };
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const index = typeof msg["index"] === "number" ? msg["index"] : -1;
    const raw = rawHookEntries();
    switch (msg["type"]) {
      case "ready":
        this._post();
        return;
      case "add": {
        if (raw.length >= 32) throw new Error("Hooks are limited to 32 entries.");
        const hook = this._parseHook(msg["hook"]);
        await writeHookEntries([...raw, HooksPanel._stored(hook)]);
        return;
      }
      case "update": {
        if (index < 0 || index >= raw.length) return;
        const hook = this._parseHook(msg["hook"]);
        await writeHookEntries(raw.map((entry, i) => (i === index ? HooksPanel._stored(hook) : entry)));
        return;
      }
      case "remove": {
        if (index < 0 || index >= raw.length) return;
        await writeHookEntries(raw.filter((_entry, i) => i !== index));
        return;
      }
      case "move": {
        // Hooks for one event run in order, and a blocking one stops the rest.
        const to = typeof msg["to"] === "number" ? msg["to"] : -1;
        if (index < 0 || index >= raw.length || to < 0 || to >= raw.length || to === index) return;
        const next = [...raw];
        const [moved] = next.splice(index, 1);
        next.splice(to, 0, moved);
        await writeHookEntries(next);
        return;
      }
      case "test": {
        if (index < 0 || index >= raw.length) return;
        if (!vscode.workspace.isTrusted) throw new Error("Hooks run only in a trusted workspace. Trust this workspace to test them.");
        const { hooks, problems } = validateHooks([raw[index]]);
        if (!hooks[0]) throw new Error(problems[0]?.message ?? "That hook is not valid.");
        this._tests.set(index, { summary: "Running…", tone: "live" });
        this._post();
        const result = await testHook(hooks[0], this._workspaceRoot());
        this._tests.set(index, { summary: result.summary, tone: result.tone });
        this._post();
        return;
      }
      case "open_settings_json":
        await vscode.commands.executeCommand("workbench.action.openSettingsJson", { revealSetting: { key: "blacksite.hooks.commands", edit: true } });
        return;
      case "show_log":
        this._showLog();
        return;
      case "open_docs":
        await vscode.env.openExternal(vscode.Uri.parse("https://rooftopdude.github.io/blacksite-vscode/docs/approvals-and-safety.html#lifecycle-hooks"));
        return;
    }
  }
}
