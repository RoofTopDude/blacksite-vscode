/**
 * Which Agent Plugins exist, which are on, and whether their MCP servers may run.
 *
 * Discovery is the client's call — the specification leaves it out — so Blacksite reads its own
 * folder and the cross-tool one, in the workspace and in the home directory:
 *
 *   workspace  .blacksite/plugins/<plugin>/, .agents/plugins/<plugin>/
 *   user       ~/.blacksite/plugins/<plugin>/, ~/.agents/plugins/<plugin>/   (installs go here)
 *
 * Trust follows what a plugin can do. Its skills are instructions — the same standing as a skill
 * committed to .blacksite/skills — so an enabled plugin's skills load. Its MCP servers launch
 * processes or contact endpoints, so they run only after the user trusts that exact mcp.json: the
 * trust is pinned to a hash of the file, and any change to it — a git pull, an edit, an update —
 * needs trusting again. A repository cannot pre-trust anything: trust is stored in VS Code state
 * on this machine, never in the workspace.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { McpServerEntry } from "../mcp-registry.js";
import type { PluginSkillSource } from "../skills/skill-store.js";
import { expandPluginPlaceholders, loadPlugin, type LoadedPlugin } from "./plugin-manifest.js";

export type PluginScope = "workspace" | "user";

export const WORKSPACE_PLUGIN_FOLDERS: readonly string[] = [".blacksite/plugins", ".agents/plugins"];
export const USER_PLUGIN_FOLDERS: readonly string[] = [".blacksite/plugins", ".agents/plugins"];

const STATE_KEY = "blacksite.plugins.state";

/** The slice of vscode.Memento the registry needs. */
export interface PluginStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface PluginState {
  enabled?: boolean;
  /** Hash of the mcp.json the user trusted. */
  mcpTrust?: string;
}

export interface PluginRecord {
  /** `${scope}:${name}` — unique across the registry. */
  key: string;
  scope: PluginScope;
  name: string;
  dir: string;
  /** Where it was found, for people: ".blacksite/plugins/x", "~/.agents/plugins/x". */
  location: string;
  plugin?: LoadedPlugin;
  /** Why the plugin could not be loaded, when it could not. */
  error?: string;
  enabled: boolean;
  /** True when the user trusted this plugin's current mcp.json, so its servers may run. */
  mcpTrusted: boolean;
}

export class PluginRegistry {
  private _cache: PluginRecord[] | null = null;
  private readonly _listeners = new Set<() => void>();

  constructor(
    private readonly _workspaceRoot: string,
    private readonly _workspaceState: PluginStateStore,
    private readonly _globalState: PluginStateStore,
    /** Client-managed persistent storage; each plugin's PLUGIN_DATA is a folder in it. */
    private readonly _dataRoot: string,
    private readonly _homeDir: string = os.homedir(),
  ) {}

  onDidChange(listener: () => void): { dispose(): void } {
    this._listeners.add(listener);
    return { dispose: () => { this._listeners.delete(listener); } };
  }

  invalidate(): void {
    this._cache = null;
    for (const listener of this._listeners) listener();
  }

  userPluginsDir(): string {
    return path.join(this._homeDir, USER_PLUGIN_FOLDERS[0]!);
  }

  private _store(scope: PluginScope): PluginStateStore {
    return scope === "workspace" ? this._workspaceState : this._globalState;
  }

  private _states(scope: PluginScope): Record<string, PluginState> {
    return this._store(scope).get<Record<string, PluginState>>(STATE_KEY) ?? {};
  }

  private async _setState(record: PluginRecord, patch: PluginState): Promise<void> {
    const states = { ...this._states(record.scope) };
    states[record.name] = { ...states[record.name], ...patch };
    await this._store(record.scope).update(STATE_KEY, states);
    this.invalidate();
  }

  /** Every plugin found, in precedence order. A second plugin with a name already seen in the same
   *  scope is reported as an error rather than silently shadowing — two copies is a mistake. */
  list(): PluginRecord[] {
    if (this._cache) return this._cache.map((record) => ({ ...record }));
    const records: PluginRecord[] = [];
    const scan = (scope: PluginScope, base: string, folders: readonly string[], label: (folder: string, name: string) => string): void => {
      const states = this._states(scope);
      const seen = new Set(records.filter((record) => record.scope === scope).map((record) => record.name));
      for (const folder of folders) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(path.join(base, folder), { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(base, folder, entry.name);
          if (!fs.existsSync(path.join(dir, "plugin.json"))) continue;
          const loaded = loadPlugin(dir);
          const name = loaded.ok ? loaded.plugin.manifest.name : entry.name;
          const location = label(folder, entry.name);
          if (seen.has(name)) {
            records.push({ key: `${scope}:${name}:${location}`, scope, name, dir, location, error: `Another ${scope} plugin named "${name}" is already loaded; this copy is ignored.`, enabled: false, mcpTrusted: false });
            continue;
          }
          seen.add(name);
          const state = states[name] ?? {};
          const plugin = loaded.ok ? loaded.plugin : undefined;
          records.push({
            key: `${scope}:${name}`,
            scope,
            name,
            dir,
            location,
            ...(plugin ? { plugin } : { error: (loaded as { error: string }).error }),
            enabled: !!plugin && state.enabled !== false,
            mcpTrusted: !!plugin?.mcpHash && state.mcpTrust === plugin.mcpHash,
          });
        }
      }
    };
    scan("workspace", this._workspaceRoot, WORKSPACE_PLUGIN_FOLDERS, (folder, name) => `${folder}/${name}`);
    scan("user", this._homeDir, USER_PLUGIN_FOLDERS, (folder, name) => `~/${folder}/${name}`);
    this._cache = records;
    return records.map((record) => ({ ...record }));
  }

  find(key: string): PluginRecord | undefined {
    return this.list().find((record) => record.key === key);
  }

  /** Skills folders of enabled plugins, for the skill store. */
  skillSources(): PluginSkillSource[] {
    return this.list()
      .filter((record) => record.enabled && record.plugin?.skillsDir)
      .map((record) => ({ plugin: record.name, dir: record.plugin!.skillsDir! }));
  }

  /**
   * MCP servers of enabled plugins whose mcp.json the user trusted, as registry entries. Stdio
   * servers get PLUGIN_ROOT and PLUGIN_DATA, placeholders expanded, a ./-relative command resolved
   * against the plugin root, and the plugin root as the default working directory; PLUGIN_DATA is
   * created before anything can launch.
   */
  mcpEntries(): McpServerEntry[] {
    const entries: McpServerEntry[] = [];
    for (const record of this.list()) {
      if (!record.enabled || !record.mcpTrusted || !record.plugin) continue;
      const root = record.plugin.root;
      const data = path.join(this._dataRoot, `${record.scope}-${record.name}`);
      try { fs.mkdirSync(data, { recursive: true }); } catch { continue; }
      const expand = (value: string): string => expandPluginPlaceholders(value, root, data);
      for (const server of record.plugin.mcpServers) {
        const id = `plugin.${record.scope}.${record.name}.${server.name}`.replace(/[^\w.-]/g, "_");
        const name = `${server.name} (plugin ${record.name})`;
        if (server.type === "stdio") {
          entries.push({
            id,
            name,
            transport: "stdio",
            command: server.command.startsWith("./") ? path.resolve(root, server.command) : server.command,
            args: server.args.map(expand),
            cwd: server.cwd ? path.resolve(root, expand(server.cwd)) : root,
            env: [
              ...Object.entries(server.env).map(([key, value]) => ({ name: key, value: expand(value) })),
              { name: "PLUGIN_ROOT", value: root },
              { name: "PLUGIN_DATA", value: data },
            ],
            enabled: true,
            pluginKey: record.key,
          });
        } else {
          entries.push({
            id,
            name,
            transport: "http",
            url: server.url,
            ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
            transportHint: server.type === "sse" ? "sse" : "http",
            enabled: true,
            pluginKey: record.key,
          });
        }
      }
    }
    return entries;
  }

  async setEnabled(key: string, enabled: boolean): Promise<void> {
    const record = this.find(key);
    if (record?.plugin) await this._setState(record, { enabled });
  }

  /** Trust the plugin's current mcp.json, so its servers may run until the file changes. */
  async trustMcp(key: string): Promise<void> {
    const record = this.find(key);
    if (record?.plugin?.mcpHash) await this._setState(record, { mcpTrust: record.plugin.mcpHash });
  }

  async revokeMcp(key: string): Promise<void> {
    const record = this.find(key);
    if (record) await this._setState(record, { mcpTrust: undefined });
  }

  /**
   * Install a plugin folder for this user: validate it, then copy it into ~/.blacksite/plugins.
   * An existing install of the same name is replaced only when `replace` is set.
   */
  install(sourceDir: string, replace = false): { ok: true; key: string; plugin: LoadedPlugin } | { ok: false; error: string } {
    const loaded = loadPlugin(sourceDir);
    if (!loaded.ok) return loaded;
    const target = path.join(this.userPluginsDir(), loaded.plugin.manifest.name);
    if (path.resolve(target) === path.resolve(loaded.plugin.root)) {
      return { ok: false, error: "That folder is already the installed copy." };
    }
    if (fs.existsSync(target)) {
      if (!replace) return { ok: false, error: `A plugin named "${loaded.plugin.manifest.name}" is already installed.` };
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Symlinks are copied as links, never followed: a plugin cannot smuggle in files from
    // outside its folder by linking to them.
    fs.cpSync(loaded.plugin.root, target, { recursive: true, verbatimSymlinks: true });
    this.invalidate();
    const installed = loadPlugin(target);
    if (!installed.ok) return installed;
    return { ok: true, key: `user:${installed.plugin.manifest.name}`, plugin: installed.plugin };
  }

  /** Remove an installed (user) plugin. Workspace plugins belong to the repository. */
  async uninstall(key: string): Promise<boolean> {
    const record = this.find(key);
    if (!record || record.scope !== "user") return false;
    fs.rmSync(record.dir, { recursive: true, force: true });
    const states = { ...this._states("user") };
    delete states[record.name];
    await this._globalState.update(STATE_KEY, states);
    this.invalidate();
    return true;
  }
}
