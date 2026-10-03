/* Runs the guided toolchain setup for the Settings panel: scan, recommend, build the plan, hand it
   to a visible terminal, read back what happened, rescan.

   The panel is a view of `state`; every change is posted whole. The terminal is the only place
   anything is installed, and only after the user types Y in it. Editor extensions (a VS Code
   action, not a shell command) install when the user confirms the plan in the panel, and workspace
   folders are added last because turning a folder into a multi-root workspace can restart the
   extension host. */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { advise } from "./advisor.js";
import { resolveNodeArchive, resolveTemurinArchive } from "./archives.js";
import { buildInstallScript, describeCommand, parseInstallResult } from "./install-script.js";
import type { ToolchainInventoryCache } from "./inventory.js";
import { buildInstallPlan, type InstallPlan } from "./plan.js";
import { scanProjectNeeds, type ProjectNeeds } from "./project-needs.js";
import type { Platform } from "./recipes.js";
import type { ProjectSetupState, SetupRunStep } from "./setup-types.js";

export interface SetupControllerOptions {
  storageDir: string;
  inventory: ToolchainInventoryCache;
  post(state: ProjectSetupState): void;
  /** Absolute paths of the files the user and the agent are working in. */
  inPlayFiles(): string[];
  /** Something was installed: forget missing commands, refresh the agent's toolchain context. */
  onInstalled(): void;
}

const POLL_MS = 1_000;

/** The toolchain a missing command belongs to, for opening the panel focused on it. */
export function toolchainForCommand(command: string): string | undefined {
  const name = command.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (/^(python\d*(\.\d+)?|py|pip\d*|pytest|mypy|ruff|uv|poetry|pipenv)$/.test(name)) return "Python";
  if (/^(node|npm|npx|pnpm|yarn|corepack)$/.test(name)) return "Node";
  if (/^(java|javac|mvn|gradle)$/.test(name)) return "Java";
  if (name === "go" || name === "gofmt") return "Go";
  if (name === "dotnet") return ".NET";
  if (/^(cargo|rustc|rustup)$/.test(name)) return "Rust";
  if (/^(gcc|g\+\+|clang|clang\+\+|make|cmake|cl)$/.test(name)) return "C/C++";
  return undefined;
}

export class ToolchainSetupController implements vscode.Disposable {
  private _state: ProjectSetupState = { status: "idle", platform: process.platform };
  private _projects: ProjectNeeds[] = [];
  private _terminal: vscode.Terminal | undefined;
  private _poll: ReturnType<typeof setInterval> | undefined;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _opts: SetupControllerOptions) {
    this._disposables.push(vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === this._terminal) void this._checkResult(true);
    }));
  }

  get state(): ProjectSetupState { return this._state; }

  private _set(next: Partial<ProjectSetupState>): void {
    this._state = { ...this._state, ...next };
    this._opts.post(this._state);
  }

  /** Re-send the current state (a webview that just opened the panel). */
  publish(): void { this._opts.post(this._state); }

  async scan(focus?: ProjectSetupState["focus"]): Promise<void> {
    if (this._state.status === "running" || this._state.status === "planning") { this.publish(); return; }
    this._set({ status: "scanning", error: undefined, focus: focus ?? this._state.focus });
    try {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
      const [{ projects, truncated }, inventory] = await Promise.all([
        Promise.resolve().then(() => scanProjectNeeds(folders)),
        this._opts.inventory.refresh(),
      ]);
      this._projects = projects;
      const installedExtensions = new Set(vscode.extensions.all.map((extension) => extension.id.toLowerCase()));
      const report = advise({
        projects, inventory, platform: process.platform as Platform, installedExtensions, inPlayFiles: this._opts.inPlayFiles(), truncated,
      });
      this._set({
        status: this._state.run && !this._state.run.finished ? "running" : "ready",
        report,
        machine: { installs: inventory.installs, managers: inventory.managers, missing: inventory.missing, probedAt: inventory.probedAt },
      });
    } catch (error) {
      this._set({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async _plan(selectedIds: readonly string[]): Promise<InstallPlan> {
    const plan = await buildInstallPlan(this._state.report!, new Set(selectedIds), {
      platform: process.platform as Platform,
      arch: process.arch,
      managers: this._state.machine?.managers ?? [],
      projects: this._projects,
      resolveNode: (major) => resolveNodeArchive(major, process.platform as Platform, process.arch),
      resolveTemurin: (feature) => resolveTemurinArchive(feature, process.platform as Platform, process.arch),
    });
    // Installing into a workspace the user has not trusted would run its tooling (npm scripts, …).
    if (!vscode.workspace.isTrusted) {
      const dropped = plan.steps.filter((step) => step.phase === "project" || step.phase === "dependencies");
      if (dropped.length > 0) {
        plan.steps = plan.steps.filter((step) => !dropped.includes(step));
        plan.problems.push(`${dropped.length} project step(s) were left out because this workspace is not trusted. Trust it (Manage Workspace Trust) to install into projects.`);
      }
    }
    return plan;
  }

  private static _runSteps(plan: InstallPlan): SetupRunStep[] {
    return plan.steps.map((step) => ({
      id: step.id, title: step.title, project: step.project, phase: step.phase, target: step.target,
      commands: step.commands.map(describeCommand), elevation: step.elevation, undo: step.undo,
    }));
  }

  /** Build the plan for the Review step without running anything. */
  async preview(selectedIds: readonly string[]): Promise<void> {
    if (!this._state.report || this._state.status === "running" || this._state.status === "planning") return;
    this._set({ status: "planning", error: undefined });
    try {
      const plan = await this._plan(selectedIds);
      this._set({
        status: "ready",
        preview: { ids: [...selectedIds], steps: ToolchainSetupController._runSteps(plan), extensions: plan.extensions, workspaceFolders: plan.workspaceFolders, problems: plan.problems, added: plan.added },
      });
    } catch (error) {
      this._set({ status: "ready", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async apply(selectedIds: readonly string[]): Promise<void> {
    const report = this._state.report;
    if (!report || this._state.status === "running" || this._state.status === "planning") return;
    const attentionBefore = report.projects.filter((project) => project.needsAttention).map((project) => project.display);
    this._set({ status: "planning", error: undefined });
    let plan: InstallPlan;
    try {
      plan = await this._plan(selectedIds);
    } catch (error) {
      this._set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const steps = ToolchainSetupController._runSteps(plan);
    const run: NonNullable<ProjectSetupState["run"]> = {
      steps, extensions: [], workspaceFolders: plan.workspaceFolders, problems: [...plan.problems, ...plan.added.map((title) => `Also included, because a step you chose needs it: ${title}.`)],
      finished: false, attentionBefore,
    };
    this._set({ status: plan.steps.length > 0 ? "running" : "done", run, preview: undefined });

    for (const id of plan.extensions) {
      try {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", id);
        run.extensions.push({ id, ok: true });
      } catch (error) {
        run.extensions.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      this._set({ run: { ...run } });
    }

    if (plan.steps.length === 0) {
      run.finished = true;
      this._set({ status: "done", run: { ...run } });
      this._addWorkspaceFolders(plan.workspaceFolders);
      await this.scan();
      return;
    }

    try {
      const dir = path.join(this._opts.storageDir, "toolchain-setup");
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = Date.now();
      const extension = process.platform === "win32" ? "ps1" : "sh";
      const scriptPath = path.join(dir, `setup-${stamp}.${extension}`);
      const resultPath = path.join(dir, `setup-${stamp}.result.json`);
      const script = buildInstallScript(plan.steps, { platform: process.platform as Platform, resultPath, cacheDir: path.join(this._opts.storageDir, "toolchain-cache") });
      // A BOM makes Windows PowerShell 5.1 read the script as UTF-8 rather than the ANSI code page.
      await fs.promises.writeFile(scriptPath, process.platform === "win32" ? `\uFEFF${script}` : script, { encoding: "utf8", mode: 0o700 });
      this._resultPath = resultPath;
      this._pendingFolders = plan.workspaceFolders;
      this._terminal?.dispose();
      this._terminal = process.platform === "win32"
        ? vscode.window.createTerminal({ name: "Blacksite: Toolchain setup", shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath] })
        : vscode.window.createTerminal({ name: "Blacksite: Toolchain setup", shellPath: "/bin/bash", shellArgs: [scriptPath] });
      this._terminal.show();
      this._poll = setInterval(() => { void this._checkResult(false); }, POLL_MS);
    } catch (error) {
      run.finished = true;
      run.problems.push(`Could not start the setup terminal: ${error instanceof Error ? error.message : String(error)}`);
      this._set({ status: "done", run: { ...run } });
    }
  }

  private _resultPath: string | undefined;
  private _pendingFolders: string[] = [];

  private async _checkResult(terminalClosed: boolean): Promise<void> {
    const run = this._state.run;
    if (!this._resultPath || !run || run.finished) return;
    let text: string | undefined;
    try { text = await fs.promises.readFile(this._resultPath, "utf8"); } catch { /* not written yet */ }
    const result = text ? parseInstallResult(text) : undefined;
    if (!result && !terminalClosed) return;
    if (this._poll) { clearInterval(this._poll); this._poll = undefined; }
    this._resultPath = undefined;
    const byId = new Map(result?.steps.map((step) => [step.id, step]) ?? []);
    const next = {
      ...run,
      finished: true,
      declined: result?.declined,
      steps: run.steps.map((step) => ({ ...step, exitCode: byId.get(step.id)?.exitCode, skipped: byId.get(step.id)?.skipped || byId.get(step.id)?.exitCode === -1 })),
      problems: result ? run.problems : [...run.problems, "The setup terminal closed before it finished. Steps it did not reach were not run."],
    };
    this._set({ status: "done", run: next });
    if (result && !result.declined) {
      this._opts.onInstalled();
      this._addWorkspaceFolders(this._pendingFolders);
    }
    this._pendingFolders = [];
    await this.scan();
  }

  private _addWorkspaceFolders(dirs: readonly string[]): void {
    const existing = new Set((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
    const add = dirs.filter((dir) => !existing.has(dir)).map((dir) => ({ uri: vscode.Uri.file(dir) }));
    if (add.length > 0) vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, ...add);
  }

  /** Close the panel's view of a run: the terminal keeps whatever it is doing. */
  dismissRun(): void {
    if (this._state.status === "running") return;
    this._set({ run: undefined, status: this._state.report ? "ready" : "idle" });
  }

  dispose(): void {
    if (this._poll) clearInterval(this._poll);
    for (const disposable of this._disposables) disposable.dispose();
  }
}
