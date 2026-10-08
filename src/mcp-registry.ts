/* The single source of truth for MCP configuration: which servers exist, which of their tools
 * the agent is allowed to know about, and where the credentials for each one live.
 *
 * Four stores, chosen for different reasons:
 *
 *   all-projects     *application-scoped* user settings (`blacksite.mcpServers`, globalValue
 *   servers          only). A server added once is there in every project. A repository-
 *                    controlled .vscode/settings.json must never be able to register a process
 *                    for us to launch, so workspace values of that setting are ignored.
 *   project servers  workspaceState. For a server that only makes sense in one project.
 *   policy + cache   globalState. A tool the user withheld from a server should stay withheld
 *                    everywhere that server is used, and the tool inventory describes the
 *                    server rather than the workspace.
 *   credentials      SecretStorage, always. Nothing here ever writes a token into settings,
 *                    workspace state, or a log line.
 *
 * Servers used to be added to workspaceState only, so a server set up in one project was missing
 * from every other one, while the docs said they lived in settings. New servers now default to
 * all projects, and either kind can be moved to the other (setScope).
 *
 * resolveForAgent() is the narrow gate between all of that and the runtime: it is the only
 * function that assembles a credential-bearing McpServer, and it stamps the tool policy onto
 * every one it produces. */

import * as os from "os";
import * as vscode from "vscode";
import { discoverMcpTools, type McpServer, type McpToolDescriptor, type McpToolPolicy } from "@blacksite/local-runtime";
import {
  McpOAuthClient,
  type McpOAuthConfig,
  type OAuthClientRegistration,
  type OAuthStorage,
  type OAuthTokenSet,
} from "./mcp-auth.js";
import {
  entryTarget, expandVariables, normalizeEntry, serializeEntry,
  type McpServerEntry,
} from "./mcp-config.js";

export type { McpAuthConfig, McpAuthMode, McpEnvVar, McpServerEntry, McpServerScope } from "./mcp-config.js";

const SERVERS_KEY = "blacksite.mcpServers";
const REMOVED_SERVERS_KEY = "blacksite.mcpRemovedServers";
const POLICY_KEY = "blacksite.mcpToolPolicy";
const CACHE_KEY = "blacksite.mcpToolCache";
const SECRET_PREFIX = "blacksite.mcp";

// ── Configuration shapes ──────────────────────────────────────────────────────

/** What a plugin-provided entry's owner is asked to do when the panel acts on it. */
export type PluginEntryAction = { kind: "update"; patch: Partial<McpServerEntry> } | { kind: "remove" };

export interface McpServerToolPolicy {
  /** Explicit per-tool verdicts, keyed by tool name. */
  tools: Record<string, boolean>;
  /** Verdict for a tool with no explicit entry — i.e. one that appeared after the user last
   *  reviewed this server. */
  fallback: "allow" | "deny";
  /** Tools the user chose to run without an approval prompt ("Always allow"). */
  autoApprove?: string[];
}

export interface McpToolCacheEntry {
  fetchedAt: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  protocolSupported?: boolean;
  capabilities?: string[];
  /** What the server says about how to use it. Shown to the agent, capped, as the server's words. */
  instructions?: string;
  tools: McpToolDescriptor[];
}

/** A tool as the panel shows it: everything the server offers, plus this workspace's verdict
 *  on it. The agent-facing path never sees a shape that can express "exists but withheld". */
export interface McpToolView extends McpToolDescriptor {
  enabled: boolean;
  /** True when the verdict comes from the fallback rather than an explicit choice. */
  implicit: boolean;
  /** Runs without an approval prompt: chosen with "Always allow", or read-only on a server set
   *  to run its read-only tools without asking. */
  autoApproved: boolean;
}

/** One tool the agent may call, with the server it belongs to. */
export interface McpAgentTool {
  serverId: string;
  serverName: string;
  tool: McpToolDescriptor;
}

/** Who the failure message is written for. The agent needs to be told what a person must do;
 *  a person reading the panel needs to be told what to press. */
type ResolveAudience = "agent" | "panel";

interface ResolveOptions {
  requireEnabled: boolean;
  audience: ResolveAudience;
}

export type McpResolution =
  | { ok: true; server: McpServer }
  | { ok: false; reason: "unknown" | "disabled" | "invalid" | "auth_required"; message: string };

export interface McpDiscoveryOutcome {
  ok: boolean;
  message: string;
  authRequired?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function secretKey(kind: string, serverId: string, suffix?: string): string {
  const parts = [SECRET_PREFIX, kind, encodeURIComponent(serverId)];
  if (suffix) parts.push(encodeURIComponent(suffix));
  return parts.join(".");
}

function targetOf(entry: McpServerEntry): string {
  return ((entry.transport === "http" ? entry.url : entry.command) ?? "").trim();
}

/**
 * Reject destinations that would leak credentials or launch something the user did not mean.
 *
 * Plain HTTP is allowed only for loopback, because a bearer token on a cleartext connection to
 * a remote host is a credential handed to the network. Embedded userinfo is rejected outright:
 * it is both a credential in a settings file and a well-worn phishing shape.
 */
export function validateHttpTarget(target: string): { ok: true; url: string } | { ok: false; message: string } {
  let url: URL;
  try { url = new URL(target); } catch { return { ok: false, message: "The server URL could not be parsed." }; }
  if (url.username || url.password) {
    return { ok: false, message: "The server URL must not embed a username or password. Use an auth mode instead." };
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, message: "Remote MCP servers must use HTTPS. Plain HTTP is allowed only for localhost." };
  }
  return { ok: true, url: url.href };
}

/** The read-only hint as the spec spells it. Untrusted metadata: only ever used to skip a
 *  prompt on a server the user explicitly set to run its read-only tools unasked. */
export function toolIsReadOnly(tool: McpToolDescriptor | undefined): boolean {
  return tool?.annotations?.["readOnlyHint"] === true;
}

export function toolIsDestructive(tool: McpToolDescriptor | undefined): boolean {
  // The spec's default for destructiveHint is true, but only when readOnlyHint is false; a tool
  // that says nothing is treated as an ordinary network call rather than flagged destructive.
  return tool?.annotations?.["destructiveHint"] === true && !toolIsReadOnly(tool);
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class McpRegistry implements OAuthStorage {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  readonly oauth: McpOAuthClient;

  private _pluginEntries: () => McpServerEntry[] = () => [];
  private _pluginAction: (entry: McpServerEntry, action: PluginEntryAction) => Promise<void> = async () => undefined;
  private readonly _subscriptions: vscode.Disposable[] = [];
  /** Servers background discovery has tried this window, so a failing one is not retried on
   *  every change event. Cleared for a server when its configuration changes. */
  private readonly _discoveryAttempted = new Set<string>();
  private readonly _discoveryErrors = new Map<string, string>();
  private readonly _discovering = new Set<string>();
  private readonly _refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _autoDiscovery = false;
  private _discoveryQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _roots: () => string[] = () => [],
  ) {
    this.oauth = new McpOAuthClient(this);
    // A server edited by hand in settings.json shows up in the panel and the agent's context
    // without a reload.
    const configEvent = vscode.workspace.onDidChangeConfiguration?.((event) => {
      if (event.affectsConfiguration("blacksite.mcpServers")) this._onDidChange.fire();
    });
    if (configEvent) this._subscriptions.push(configEvent);
  }

  /**
   * Servers from Agent Plugins (see src/plugins/plugin-registry.ts): listed alongside configured
   * ones, never stored with them. Updates and removals on them go to `onAction` — copying one
   * into workspace state, as an edit to a settings-declared server does, would turn a plugin's
   * command into an ordinary configured server and step around the trust its plugin requires.
   */
  setPluginSource(entries: () => McpServerEntry[], onAction: (entry: McpServerEntry, action: PluginEntryAction) => Promise<void>): void {
    this._pluginEntries = entries;
    this._pluginAction = onAction;
    this._onDidChange.fire();
  }

  /** Tell listeners the plugin-provided set changed (a plugin was enabled, trusted or removed). */
  notifyPluginsChanged(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const timer of this._refreshTimers.values()) clearTimeout(timer);
    this._refreshTimers.clear();
    for (const subscription of this._subscriptions) subscription.dispose();
    this._subscriptions.length = 0;
    this._onDidChange.dispose();
  }

  // ── Entries ─────────────────────────────────────────────────────────────────

  private _configRaw(): unknown[] {
    const value = vscode.workspace.getConfiguration("blacksite").inspect<unknown[]>("mcpServers")?.globalValue;
    return Array.isArray(value) ? value : [];
  }

  private _removedHere(): Set<string> {
    return new Set(this._context.workspaceState.get<string[]>(REMOVED_SERVERS_KEY, []) ?? []);
  }

  /**
   * Every server this project can use: all-projects servers from user settings, this project's
   * own servers, and plugin servers, deduped by id. A project server wins over an all-projects
   * one with the same id (older versions copied a settings server into workspace state to edit
   * it, and that copy is what the user last saw). Only `globalValue` is read from configuration —
   * see the file header for why a repository must not be able to contribute one.
   */
  listEntries(): McpServerEntry[] {
    const removed = this._removedHere();
    const byId = new Map<string, McpServerEntry>();
    for (const raw of this._configRaw()) {
      const entry = normalizeEntry(raw);
      if (entry && !removed.has(entry.id)) byId.set(entry.id, { ...entry, scope: "user" });
    }
    for (const entry of this._storedEntries()) byId.set(entry.id, { ...entry, scope: "workspace" });
    // Plugin ids are namespaced ("plugin.<scope>.<name>.<server>"), so they cannot collide with a
    // configured server; a configured one still wins if somebody copied the id by hand.
    for (const entry of this._pluginEntries()) {
      if (!byId.has(entry.id)) byId.set(entry.id, { ...entry, scope: "plugin" });
    }
    return [...byId.values()];
  }

  getEntry(serverId: string): McpServerEntry | undefined {
    return this.listEntries().find((entry) => entry.id === serverId);
  }

  enabledEntries(): McpServerEntry[] {
    return this.listEntries().filter((entry) => entry.enabled && targetOf(entry));
  }

  /** Add a server. "user" makes it available in every project; "workspace" only in this one. */
  async addEntry(input: Omit<McpServerEntry, "id"> & { id?: string }, scope: "user" | "workspace" = "workspace"): Promise<McpServerEntry> {
    const { scope: _ignored, pluginKey: _plugin, ...rest } = input;
    const entry: McpServerEntry = {
      ...rest,
      id: input.id || `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      enabled: input.enabled !== false,
    };
    await this._unremoveEntry(entry.id);
    if (scope === "user") await this._writeUserEntry(entry);
    else await this._writeEntries([...this._storedEntries().filter((stored) => stored.id !== entry.id), entry]);
    this._discoveryAttempted.delete(entry.id);
    return { ...entry, scope };
  }

  /** The same server, configured the same way, already present — what import skips. */
  findDuplicate(candidate: Pick<McpServerEntry, "transport" | "url" | "command" | "args">): McpServerEntry | undefined {
    const target = entryTarget(candidate);
    return this.listEntries().find((entry) => entry.transport === candidate.transport && entryTarget(entry) === target);
  }

  async updateEntry(serverId: string, patch: Partial<McpServerEntry>): Promise<void> {
    const source = this.getEntry(serverId);
    if (!source) return;
    if (source.pluginKey) {
      await this._pluginAction(source, { kind: "update", patch });
      return;
    }
    const { scope: _scope, pluginKey: _plugin, ...cleanPatch } = patch;
    const next: McpServerEntry = { ...source, ...cleanPatch, id: serverId };
    delete next.scope;
    const destinationChanged = source.transport !== next.transport || entryTarget(source) !== entryTarget(next);
    const connectionChanged = destinationChanged
      || JSON.stringify(source.auth ?? null) !== JSON.stringify(next.auth ?? null)
      || JSON.stringify(source.env ?? null) !== JSON.stringify(next.env ?? null)
      || JSON.stringify(source.headers ?? null) !== JSON.stringify(next.headers ?? null)
      || (source.cwd ?? "") !== (next.cwd ?? "")
      || source.transportHint !== next.transportHint;
    if (destinationChanged) {
      // A server id is not a credential audience. Retargeting an entry must not send the old
      // endpoint's token to the new endpoint or carry the old endpoint's allowlist forward.
      await this.clearCredentials(serverId);
      await this._writePolicies(this._policies(), serverId);
    }
    if (connectionChanged) {
      await this.clearCache(serverId);
      this._discoveryAttempted.delete(serverId);
      this._discoveryErrors.delete(serverId);
    }
    // Edited where it lives: an all-projects server changes for every project.
    if (source.scope === "user") await this._writeUserEntry(next);
    else await this._writeEntries(this._storedEntries().map((entry) => (entry.id === serverId ? next : entry)));
  }

  /**
   * Remove a server. An all-projects server is removed from every project unless `hereOnly`, which
   * hides it in this project and leaves it everywhere else (credentials kept, since the other
   * projects still use them).
   */
  async removeEntry(serverId: string, options: { hereOnly?: boolean } = {}): Promise<void> {
    const entry = this.getEntry(serverId);
    if (entry?.pluginKey) {
      await this._pluginAction(entry, { kind: "remove" });
      return;
    }
    const inUserSettings = this._configRaw().some((raw) => normalizeEntry(raw)?.id === serverId);
    if (options.hereOnly && inUserSettings) {
      const removed = this._removedHere();
      removed.add(serverId);
      await this._context.workspaceState.update(REMOVED_SERVERS_KEY, [...removed]);
      await this._writeEntries(this._storedEntries().filter((stored) => stored.id !== serverId));
      return;
    }
    // Do this while the entry (and therefore its secret env-var names) is still resolvable.
    await this.clearCredentials(serverId);
    if (inUserSettings) await this._writeUserEntries(this._configRaw().filter((raw) => normalizeEntry(raw)?.id !== serverId));
    await this._writeEntries(this._storedEntries().filter((stored) => stored.id !== serverId));
    await this._writePolicies(this._policies(), serverId);
    await this.clearCache(serverId);
  }

  /** Move a server between "every project" (user settings) and "this project" (workspace state).
   *  Credentials, tool choices and the inventory are keyed by id, so they move with it. */
  async setScope(serverId: string, scope: "user" | "workspace"): Promise<void> {
    const entry = this.getEntry(serverId);
    if (!entry || entry.pluginKey || entry.scope === scope) return;
    const plain: McpServerEntry = { ...entry };
    delete plain.scope;
    if (scope === "user") {
      await this._writeUserEntry(plain);
      await this._writeEntries(this._storedEntries().filter((stored) => stored.id !== serverId));
      await this._unremoveEntry(serverId);
    } else {
      await this._writeEntries([...this._storedEntries().filter((stored) => stored.id !== serverId), plain]);
      await this._writeUserEntries(this._configRaw().filter((raw) => normalizeEntry(raw)?.id !== serverId));
    }
  }

  private async _unremoveEntry(serverId: string): Promise<void> {
    const removed = this._removedHere();
    if (!removed.delete(serverId)) return;
    await this._context.workspaceState.update(REMOVED_SERVERS_KEY, [...removed]);
  }

  private _storedEntries(): McpServerEntry[] {
    const raw = this._context.workspaceState.get<unknown[]>(SERVERS_KEY, []) ?? [];
    return raw.map((entry) => normalizeEntry(entry)).filter((entry): entry is McpServerEntry => !!entry);
  }

  private async _writeEntries(entries: McpServerEntry[]): Promise<void> {
    await this._context.workspaceState.update(SERVERS_KEY, entries.map(serializeEntry));
    this._onDidChange.fire();
  }

  /** Replace (or append) one server in user settings, keeping every other raw entry exactly as
   *  the user wrote it — including ones this version cannot parse. */
  private async _writeUserEntry(entry: McpServerEntry): Promise<void> {
    const raw = this._configRaw();
    const index = raw.findIndex((item) => normalizeEntry(item)?.id === entry.id);
    const serialized = serializeEntry(entry);
    const next = index === -1 ? [...raw, serialized] : raw.map((item, i) => (i === index ? serialized : item));
    await this._writeUserEntries(next);
  }

  private async _writeUserEntries(entries: unknown[]): Promise<void> {
    await vscode.workspace.getConfiguration("blacksite").update("mcpServers", entries, vscode.ConfigurationTarget.Global);
    this._onDidChange.fire();
  }

  // ── Tool policy ─────────────────────────────────────────────────────────────

  private _policies(): Record<string, McpServerToolPolicy> {
    return this._context.globalState.get<Record<string, McpServerToolPolicy>>(POLICY_KEY, {}) ?? {};
  }

  policyRecord(serverId: string): McpServerToolPolicy {
    const stored = this._policies()[serverId];
    return {
      tools: stored?.tools ?? {},
      fallback: stored?.fallback === "deny" ? "deny" : "allow",
      autoApprove: Array.isArray(stored?.autoApprove) ? stored.autoApprove.filter((name) => typeof name === "string") : [],
    };
  }

  /** The runtime-facing policy. `allow` is left empty when the fallback already admits
   *  everything, so the common "nothing withheld" case ships the smallest possible object. */
  policyFor(serverId: string): McpToolPolicy {
    const record = this.policyRecord(serverId);
    const allow: string[] = [];
    const deny: string[] = [];
    for (const [name, enabled] of Object.entries(record.tools)) {
      (enabled ? allow : deny).push(name);
    }
    return { allow, deny, fallback: record.fallback };
  }

  async setToolEnabled(serverId: string, toolName: string, enabled: boolean): Promise<void> {
    const policies = this._policies();
    const record = this.policyRecord(serverId);
    record.tools = { ...record.tools, [toolName]: enabled };
    policies[serverId] = record;
    await this._writePolicies(policies);
  }

  /** Set every currently known tool at once. Also moves the fallback, so "disable all" keeps
   *  holding when the server later grows a tool nobody has reviewed. */
  async setAllTools(serverId: string, enabled: boolean): Promise<void> {
    const policies = this._policies();
    const tools: Record<string, boolean> = {};
    for (const tool of this.cachedTools(serverId)) tools[tool.name] = enabled;
    policies[serverId] = { ...this.policyRecord(serverId), tools, fallback: enabled ? "allow" : "deny" };
    await this._writePolicies(policies);
  }

  async setToolFallback(serverId: string, fallback: "allow" | "deny"): Promise<void> {
    const policies = this._policies();
    policies[serverId] = { ...this.policyRecord(serverId), fallback };
    await this._writePolicies(policies);
  }

  /** "Always allow" for one tool, from the approval card or the panel. */
  async setToolAutoApprove(serverId: string, toolName: string, autoApprove: boolean): Promise<void> {
    const policies = this._policies();
    const record = this.policyRecord(serverId);
    const names = new Set(record.autoApprove);
    if (autoApprove) names.add(toolName); else names.delete(toolName);
    policies[serverId] = { ...record, autoApprove: [...names] };
    await this._writePolicies(policies);
  }

  /**
   * Whether a call may skip its approval prompt, and why. Undefined means ask.
   *
   * Two ways in: the user pressed "Always allow" for this tool, or the server is set to run its
   * read-only tools unasked and this tool says it is read-only. A withheld tool is never
   * auto-approved — it never reaches a gate at all.
   */
  autoApproval(serverId: string, toolName: string): "always" | "read_only" | undefined {
    const record = this.policyRecord(serverId);
    if (record.autoApprove?.includes(toolName)) return "always";
    const entry = this.getEntry(serverId);
    if (entry?.autoApproveReadOnly && toolIsReadOnly(this.cachedTools(serverId).find((tool) => tool.name === toolName))) return "read_only";
    return undefined;
  }

  private async _writePolicies(policies: Record<string, McpServerToolPolicy>, removeId?: string): Promise<void> {
    if (removeId) delete policies[removeId];
    await this._context.globalState.update(POLICY_KEY, policies);
    this._onDidChange.fire();
  }

  // ── Tool inventory cache ────────────────────────────────────────────────────

  private _cache(): Record<string, McpToolCacheEntry> {
    return this._context.globalState.get<Record<string, McpToolCacheEntry>>(CACHE_KEY, {}) ?? {};
  }

  cacheEntry(serverId: string): McpToolCacheEntry | undefined {
    return this._cache()[serverId];
  }

  cachedTools(serverId: string): McpToolDescriptor[] {
    return this._cache()[serverId]?.tools ?? [];
  }

  async setCache(serverId: string, entry: McpToolCacheEntry): Promise<void> {
    const cache = this._cache();
    cache[serverId] = entry;
    await this._context.globalState.update(CACHE_KEY, cache);
    this._onDidChange.fire();
  }

  async clearCache(serverId: string): Promise<void> {
    const cache = this._cache();
    if (!(serverId in cache)) return;
    delete cache[serverId];
    await this._context.globalState.update(CACHE_KEY, cache);
    this._onDidChange.fire();
  }

  /** The panel's view: every discovered tool with this workspace's verdict attached. */
  toolViews(serverId: string): McpToolView[] {
    const record = this.policyRecord(serverId);
    const entry = this.getEntry(serverId);
    return this.cachedTools(serverId).map((tool) => {
      const explicit = Object.prototype.hasOwnProperty.call(record.tools, tool.name);
      return {
        ...tool,
        enabled: explicit ? record.tools[tool.name] === true : record.fallback === "allow",
        implicit: !explicit,
        autoApproved: !!record.autoApprove?.includes(tool.name) || (!!entry?.autoApproveReadOnly && toolIsReadOnly(tool)),
      };
    });
  }

  /** Names the agent is allowed to see, for the workspace-state block. Empty when nothing has
   *  been discovered yet — never a placeholder that hints at withheld tools. */
  enabledToolNames(serverId: string): string[] {
    return this.toolViews(serverId).filter((tool) => tool.enabled).map((tool) => tool.name);
  }

  /** Every tool the agent may call across enabled servers, for its typed tool catalog. */
  agentTools(): McpAgentTool[] {
    const out: McpAgentTool[] = [];
    for (const entry of this.enabledEntries()) {
      const policy = this.policyRecord(entry.id);
      for (const tool of this.cachedTools(entry.id)) {
        const explicit = Object.prototype.hasOwnProperty.call(policy.tools, tool.name);
        const enabled = explicit ? policy.tools[tool.name] === true : policy.fallback === "allow";
        if (enabled) out.push({ serverId: entry.id, serverName: entry.name, tool });
      }
    }
    return out;
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  /**
   * Connect, list the server's tools, and store the inventory.
   *
   * Used by the panel's Discover button and by background discovery. Before background discovery,
   * only the panel ever wrote the inventory, so a server added in settings or by a plugin showed no
   * tools to the agent (and no argument schemas to check calls against) until someone opened the
   * panel and pressed Discover.
   */
  async refreshInventory(serverId: string): Promise<McpDiscoveryOutcome> {
    const resolved = await this.resolveForPanel(serverId);
    if (!resolved.ok) {
      this._discoveryErrors.set(serverId, resolved.message);
      return { ok: false, message: resolved.message, authRequired: resolved.reason === "auth_required" };
    }
    this._discovering.add(serverId);
    try {
      const result = await discoverMcpTools(resolved.server);
      if (!result.ok) {
        const message = result.authRequired ? `${result.error} Sign in to continue.` : result.error;
        this._discoveryErrors.set(serverId, message);
        return { ok: false, message, authRequired: result.authRequired };
      }
      this._discoveryErrors.delete(serverId);
      await this.setCache(serverId, {
        fetchedAt: new Date().toISOString(),
        serverName: result.server.name,
        serverVersion: result.server.version,
        protocolVersion: result.server.protocolVersion,
        protocolSupported: result.server.protocolSupported,
        capabilities: result.server.capabilities,
        instructions: result.server.instructions?.slice(0, 4000),
        tools: result.tools,
      });
      return { ok: true, message: `${result.tools.length} tool${result.tools.length === 1 ? "" : "s"} discovered.` };
    } finally {
      this._discovering.delete(serverId);
      this._onDidChange.fire();
    }
  }

  /** The last background or manual discovery failure for a server, if it has not since succeeded. */
  discoveryError(serverId: string): string | undefined {
    return this._discoveryErrors.get(serverId);
  }

  isDiscovering(serverId: string): boolean {
    return this._discovering.has(serverId);
  }

  /**
   * Discover every enabled server that has no inventory yet, one at a time, in the background.
   * Each server is tried once per window (again only after its configuration changes), so a
   * server that is down or needs a sign-in does not relaunch on every change event.
   */
  ensureDiscovered(): void {
    if (!vscode.workspace.isTrusted) return;
    for (const entry of this.enabledEntries()) {
      if (this.cacheEntry(entry.id) || this._discoveryAttempted.has(entry.id)) continue;
      this._discoveryAttempted.add(entry.id);
      this._discoveryQueue = this._discoveryQueue
        .then(() => this.refreshInventory(entry.id))
        .then(() => undefined, () => undefined);
    }
  }

  /** Keep inventories current without anyone pressing Discover: new and edited servers are
   *  discovered in the background, and a server's tools/list_changed refreshes its inventory. */
  startAutoDiscovery(): void {
    if (this._autoDiscovery) return;
    this._autoDiscovery = true;
    this._subscriptions.push(this.onDidChange(() => this.ensureDiscovered()));
    this.ensureDiscovered();
  }

  /** A server said its tool list changed. Coalesced, because servers often announce several
   *  changes in a burst while starting up. */
  private _scheduleRefresh(serverId: string): void {
    const existing = this._refreshTimers.get(serverId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._refreshTimers.delete(serverId);
      void this.refreshInventory(serverId).catch(() => undefined);
    }, 1500);
    (timer as unknown as { unref?: () => void }).unref?.();
    this._refreshTimers.set(serverId, timer);
  }

  // ── Credentials ─────────────────────────────────────────────────────────────

  async setStaticSecret(serverId: string, value: string): Promise<void> {
    await this._context.secrets.store(secretKey("token", serverId), value);
    await this.clearCache(serverId);
    this._discoveryAttempted.delete(serverId);
    this._onDidChange.fire();
  }

  async getStaticSecret(serverId: string): Promise<string | undefined> {
    return this._context.secrets.get(secretKey("token", serverId));
  }

  async setEnvSecret(serverId: string, name: string, value: string): Promise<void> {
    await this._context.secrets.store(secretKey("env", serverId, name), value);
    await this.clearCache(serverId);
    this._discoveryAttempted.delete(serverId);
    this._onDidChange.fire();
  }

  async getEnvSecret(serverId: string, name: string): Promise<string | undefined> {
    return this._context.secrets.get(secretKey("env", serverId, name));
  }

  async deleteEnvSecret(serverId: string, name: string): Promise<void> {
    await this._context.secrets.delete(secretKey("env", serverId, name));
    await this.clearCache(serverId);
    this._onDidChange.fire();
  }

  /** Remove every credential for a server — sign-out, and part of deleting the entry. */
  async clearCredentials(serverId: string): Promise<void> {
    const entry = this.getEntry(serverId);
    await this._context.secrets.delete(secretKey("token", serverId));
    await this._context.secrets.delete(secretKey("oauth", serverId));
    await this._context.secrets.delete(secretKey("client", serverId));
    for (const variable of entry?.env ?? []) {
      if (variable.secret) await this._context.secrets.delete(secretKey("env", serverId, variable.name));
    }
    await this.clearCache(serverId);
    this._onDidChange.fire();
  }

  /** Whether a server has the credential its auth mode calls for — drives the panel's badge
   *  without ever reading the secret itself into the webview. */
  async credentialStatus(serverId: string): Promise<"none" | "configured" | "missing"> {
    const entry = this.getEntry(serverId);
    if (entry?.transport === "stdio") return "none";
    const mode = entry?.auth?.mode ?? "none";
    if (mode === "none") return "none";
    if (mode === "oauth") return (await this.readTokens(serverId)) ? "configured" : "missing";
    return (await this.getStaticSecret(serverId)) ? "configured" : "missing";
  }

  // ── OAuthStorage ────────────────────────────────────────────────────────────

  async readTokens(serverId: string): Promise<OAuthTokenSet | undefined> {
    return this._readJsonSecret<OAuthTokenSet>(secretKey("oauth", serverId));
  }

  async writeTokens(serverId: string, tokens: OAuthTokenSet): Promise<void> {
    await this._context.secrets.store(secretKey("oauth", serverId), JSON.stringify(tokens));
    await this.clearCache(serverId);
    this._discoveryAttempted.delete(serverId);
    this._onDidChange.fire();
  }

  async clearTokens(serverId: string): Promise<void> {
    await this._context.secrets.delete(secretKey("oauth", serverId));
    await this.clearCache(serverId);
    this._onDidChange.fire();
  }

  async readClient(serverId: string): Promise<OAuthClientRegistration | undefined> {
    return this._readJsonSecret<OAuthClientRegistration>(secretKey("client", serverId));
  }

  async writeClient(serverId: string, client: OAuthClientRegistration): Promise<void> {
    await this._context.secrets.store(secretKey("client", serverId), JSON.stringify(client));
  }

  private async _readJsonSecret<T>(key: string): Promise<T | undefined> {
    const raw = await this._context.secrets.get(key);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * Assemble the credential-bearing descriptor the runtime needs, for the agent.
   *
   * Everything the agent is not allowed to reach fails here rather than deeper: a disabled
   * server, an unparseable target, a cleartext remote URL, or a server whose credential the
   * user has not supplied yet. The returned descriptor always carries the tool policy, which
   * is what makes withheld tools unreachable even if a call arrives with a remembered name.
   */
  async resolveForAgent(serverId: string): Promise<McpResolution> {
    const base = await this._resolve(serverId, { requireEnabled: true, audience: "agent" });
    if (!base.ok) return base;
    return { ok: true, server: { ...base.server, toolPolicy: this.policyFor(serverId) } };
  }

  /** The panel's resolution: same credentials, no tool policy, and a disabled server still
   *  resolves so its inventory can be reviewed before it is switched on. */
  async resolveForPanel(serverId: string): Promise<McpResolution> {
    return this._resolve(serverId, { requireEnabled: false, audience: "panel" });
  }

  private _expansion(): { env: Record<string, string | undefined>; workspaceFolder?: string; userHome: string } {
    return { env: process.env, workspaceFolder: this._roots()[0], userHome: os.homedir() };
  }

  private async _resolve(serverId: string, options: ResolveOptions): Promise<McpResolution> {
    const entry = this.getEntry(serverId);
    if (!entry) {
      return { ok: false, reason: "unknown", message: `MCP server '${serverId || "(missing)"}' is not configured.` };
    }
    if (options.requireEnabled && !entry.enabled) {
      return { ok: false, reason: "disabled", message: `MCP server '${entry.name}' is disabled.` };
    }
    const vars = this._expansion();
    const target = expandVariables(targetOf(entry), vars).trim();
    if (!target) {
      return { ok: false, reason: "invalid", message: `MCP server '${entry.name}' has no ${entry.transport === "http" ? "URL" : "command"} configured.` };
    }

    const headers = entry.headers && Object.keys(entry.headers).length
      ? Object.fromEntries(Object.entries(entry.headers).map(([name, value]) => [name, expandVariables(value, vars)]))
      : undefined;
    const server: McpServer = {
      id: entry.id,
      label: entry.name,
      url: target,
      roots: this._roots(),
      client: {
        name: "blacksite-vscode",
        version: String(this._context.extension?.packageJSON?.version ?? "unknown"),
        title: "Blacksite",
      },
      onToolsChanged: () => { this._scheduleRefresh(entry.id); },
      headers,
    };

    if (entry.transport === "http") {
      const validated = validateHttpTarget(target);
      if (!validated.ok) return { ok: false, reason: "invalid", message: `MCP server '${entry.name}': ${validated.message}` };
      server.url = validated.url;
      server.transport = entry.transportHint ?? "auto";
    } else {
      server.transport = "stdio";
      // Relative arguments in local MCP commands (for example a filesystem server launched
      // with `.`) are expected to refer to the active workspace, not VS Code's install dir.
      // A plugin server names its own working directory (its plugin root by default).
      server.cwd = entry.cwd ? expandVariables(entry.cwd, vars) : server.roots?.[0];
      if (entry.args) server.args = entry.args.map((arg) => expandVariables(arg, vars));
      server.env = await this._resolveEnv(entry, vars);
    }

    const applied = entry.transport === "http"
      ? await this._applyAuth(entry, server, options.audience)
      : { ok: true as const, server };
    if (!applied.ok) return applied;
    return { ok: true, server };
  }

  private async _resolveEnv(entry: McpServerEntry, vars: ReturnType<McpRegistry["_expansion"]>): Promise<Record<string, string> | undefined> {
    if (!entry.env?.length) return undefined;
    const env: Record<string, string> = {};
    for (const variable of entry.env) {
      const value = variable.secret
        ? await this.getEnvSecret(entry.id, variable.name)
        : variable.value !== undefined ? expandVariables(variable.value, vars) : undefined;
      // A secret the user has not filled in yet is left unset rather than passed as "", which
      // servers routinely treat as a *present* but invalid credential and fail confusingly on.
      if (value !== undefined && value !== "") env[variable.name] = value;
    }
    return Object.keys(env).length ? env : undefined;
  }

  private async _applyAuth(entry: McpServerEntry, server: McpServer, audience: ResolveAudience): Promise<McpResolution> {
    const mode = entry.auth?.mode ?? "none";
    if (mode === "none") return { ok: true, server };

    if (mode === "bearer" || mode === "header") {
      const secret = await this.getStaticSecret(entry.id);
      if (!secret) {
        return {
          ok: false,
          reason: "auth_required",
          // The panel's reader is already standing in the place the agent's message would
          // send them, so each audience gets the instruction that is actionable for it.
          message: audience === "panel"
            ? "No token stored yet. Set one under Authentication, then try again."
            : `MCP server '${entry.name}' needs a credential. Open Blacksite: Manage MCP Servers and add its token.`,
        };
      }
      if (mode === "bearer") server.apiKey = secret;
      else server.headers = { ...(server.headers ?? {}), [entry.auth?.headerName || "Authorization"]: secret };
      return { ok: true, server };
    }

    // OAuth. Refresh happens inside getAccessToken; a missing or unrenewable token means the
    // user has to consent, which the host surfaces as a prompt rather than blocking here.
    const token = await this.oauth.getAccessToken(entry.id, server.url);
    if (!token) {
      return {
        ok: false,
        reason: "auth_required",
        message: audience === "panel"
          ? "Not authorized yet. Press Sign in to authorize this server in your browser."
          : `MCP server '${entry.name}' requires authorization. Ask the user to sign in from Blacksite: Manage MCP Servers, then try again.`,
      };
    }
    server.apiKey = token;
    return { ok: true, server };
  }

  /** The OAuth config for a server, in the shape the auth client expects. */
  oauthConfigFor(entry: McpServerEntry): McpOAuthConfig {
    return {
      scopes: entry.auth?.scopes,
      clientId: entry.auth?.clientId,
      redirectUri: entry.auth?.redirectUri,
    };
  }
}
