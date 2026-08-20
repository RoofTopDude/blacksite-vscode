/* The single source of truth for MCP configuration: which servers exist, which of their tools
 * the agent is allowed to know about, and where the credentials for each one live.
 *
 * Three stores, chosen for different reasons:
 *
 *   server entries   workspaceState + *application-scoped* settings. A repository-controlled
 *                    .vscode/settings.json must never be able to register a process for us to
 *                    launch, so only globalValue is read from configuration.
 *   policy + cache   globalState. A tool the user withheld from a server should stay withheld
 *                    everywhere that server is used, and the tool inventory describes the
 *                    server rather than the workspace.
 *   credentials      SecretStorage, always. Nothing here ever writes a token into settings,
 *                    workspace state, or a log line.
 *
 * resolveForAgent() is the narrow gate between all of that and the runtime: it is the only
 * function that assembles a credential-bearing McpServer, and it stamps the tool policy onto
 * every one it produces. */

import * as vscode from "vscode";
import type { McpServer, McpToolDescriptor, McpToolPolicy } from "@blacksite/local-runtime";
import {
  McpOAuthClient,
  type McpOAuthConfig,
  type OAuthClientRegistration,
  type OAuthStorage,
  type OAuthTokenSet,
} from "./mcp-auth.js";

const SERVERS_KEY = "blacksite.mcpServers";
const POLICY_KEY = "blacksite.mcpToolPolicy";
const CACHE_KEY = "blacksite.mcpToolCache";
const SECRET_PREFIX = "blacksite.mcp";

// ── Configuration shapes ──────────────────────────────────────────────────────

export type McpAuthMode = "none" | "bearer" | "header" | "oauth";

export interface McpEnvVar {
  name: string;
  /** Present for plain values. Secret values live in SecretStorage and leave this undefined. */
  value?: string;
  secret?: boolean;
}

export interface McpAuthConfig {
  mode: McpAuthMode;
  /** For "header": which header carries the secret (e.g. `X-API-Key`). */
  headerName?: string;
  /** For "oauth": scopes to request; empty means "whatever the server advertises". */
  scopes?: string[];
  /** For "oauth": a pre-registered client, when the server has no dynamic registration. */
  clientId?: string;
  /** For "oauth": the redirect URI that pre-registered client was created with. */
  redirectUri?: string;
}

export interface McpServerEntry {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
  auth?: McpAuthConfig;
  /** stdio only. The usual way a local MCP server receives its credentials. */
  env?: McpEnvVar[];
  /** Static, non-secret headers for HTTP servers. */
  headers?: Record<string, string>;
  /** Explicit transport override for a server that mis-advertises which revision it speaks. */
  transportHint?: "auto" | "http" | "sse";
}

export interface McpServerToolPolicy {
  /** Explicit per-tool verdicts, keyed by tool name. */
  tools: Record<string, boolean>;
  /** Verdict for a tool with no explicit entry — i.e. one that appeared after the user last
   *  reviewed this server. */
  fallback: "allow" | "deny";
}

export interface McpToolCacheEntry {
  fetchedAt: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  protocolSupported?: boolean;
  capabilities?: string[];
  tools: McpToolDescriptor[];
}

/** A tool as the panel shows it: everything the server offers, plus this workspace's verdict
 *  on it. The agent-facing path never sees a shape that can express "exists but withheld". */
export interface McpToolView extends McpToolDescriptor {
  enabled: boolean;
  /** True when the verdict comes from the fallback rather than an explicit choice. */
  implicit: boolean;
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

function normalizeEntry(raw: unknown): McpServerEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e["id"] === "string" ? e["id"] : "";
  if (!id) return null;
  const transport = e["transport"] === "stdio" ? "stdio" : "http";
  const auth = e["auth"] && typeof e["auth"] === "object" ? e["auth"] as McpAuthConfig : undefined;
  return {
    id,
    name: typeof e["name"] === "string" && e["name"] ? e["name"] : id,
    transport,
    command: typeof e["command"] === "string" ? e["command"] : undefined,
    url: typeof e["url"] === "string" ? e["url"] : undefined,
    enabled: e["enabled"] !== false,
    auth: auth ? { ...auth, mode: auth.mode ?? "none" } : undefined,
    env: Array.isArray(e["env"])
      ? (e["env"] as unknown[])
          .map((v) => (v && typeof v === "object" ? v as McpEnvVar : null))
          .filter((v): v is McpEnvVar => !!v && typeof v.name === "string" && !!v.name)
      : undefined,
    headers: e["headers"] && typeof e["headers"] === "object" ? e["headers"] as Record<string, string> : undefined,
    transportHint: e["transportHint"] === "http" || e["transportHint"] === "sse" ? e["transportHint"] : undefined,
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class McpRegistry implements OAuthStorage {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  readonly oauth: McpOAuthClient;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _roots: () => string[] = () => [],
  ) {
    this.oauth = new McpOAuthClient(this);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  // ── Entries ─────────────────────────────────────────────────────────────────

  /**
   * Every configured server, from workspace state and application-level settings, deduped by
   * id with workspace state winning. Only `globalValue` is read from configuration — see the
   * file header for why a repository must not be able to contribute one.
   */
  listEntries(): McpServerEntry[] {
    const fromState = this._context.workspaceState.get<unknown[]>(SERVERS_KEY, []) ?? [];
    const inspected = vscode.workspace.getConfiguration("blacksite").inspect<unknown[]>("mcpServers");
    const fromConfig = inspected?.globalValue ?? [];
    const byId = new Map<string, McpServerEntry>();
    for (const raw of [...fromConfig, ...fromState]) {
      const entry = normalizeEntry(raw);
      if (entry) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  getEntry(serverId: string): McpServerEntry | undefined {
    return this.listEntries().find((entry) => entry.id === serverId);
  }

  enabledEntries(): McpServerEntry[] {
    return this.listEntries().filter((entry) => entry.enabled && targetOf(entry));
  }

  async addEntry(input: Omit<McpServerEntry, "id"> & { id?: string }): Promise<McpServerEntry> {
    const entry: McpServerEntry = {
      ...input,
      id: input.id || `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      enabled: input.enabled !== false,
    };
    const stored = this._storedEntries();
    stored.push(entry);
    await this._writeEntries(stored);
    return entry;
  }

  async updateEntry(serverId: string, patch: Partial<McpServerEntry>): Promise<void> {
    const stored = this._storedEntries();
    const index = stored.findIndex((entry) => entry.id === serverId);
    if (index === -1) {
      // Settings-declared servers are read-only, but the user still edits them through the
      // same panel: copy the entry into workspace state and apply the change to the copy.
      const source = this.getEntry(serverId);
      if (!source) return;
      stored.push({ ...source, ...patch, id: serverId });
    } else {
      stored[index] = { ...stored[index]!, ...patch, id: serverId };
    }
    await this._writeEntries(stored);
  }

  async removeEntry(serverId: string): Promise<void> {
    await this._writeEntries(this._storedEntries().filter((entry) => entry.id !== serverId));
    await this.clearCredentials(serverId);
    await this._writePolicies(this._policies(), serverId);
    await this.clearCache(serverId);
  }

  private _storedEntries(): McpServerEntry[] {
    const raw = this._context.workspaceState.get<unknown[]>(SERVERS_KEY, []) ?? [];
    return raw.map(normalizeEntry).filter((entry): entry is McpServerEntry => !!entry);
  }

  private async _writeEntries(entries: McpServerEntry[]): Promise<void> {
    await this._context.workspaceState.update(SERVERS_KEY, entries);
    this._onDidChange.fire();
  }

  // ── Tool policy ─────────────────────────────────────────────────────────────

  private _policies(): Record<string, McpServerToolPolicy> {
    return this._context.globalState.get<Record<string, McpServerToolPolicy>>(POLICY_KEY, {}) ?? {};
  }

  policyRecord(serverId: string): McpServerToolPolicy {
    const stored = this._policies()[serverId];
    return { tools: stored?.tools ?? {}, fallback: stored?.fallback === "deny" ? "deny" : "allow" };
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
    policies[serverId] = { tools, fallback: enabled ? "allow" : "deny" };
    await this._writePolicies(policies);
  }

  async setToolFallback(serverId: string, fallback: "allow" | "deny"): Promise<void> {
    const policies = this._policies();
    policies[serverId] = { ...this.policyRecord(serverId), fallback };
    await this._writePolicies(policies);
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
    delete cache[serverId];
    await this._context.globalState.update(CACHE_KEY, cache);
    this._onDidChange.fire();
  }

  /** The panel's view: every discovered tool with this workspace's verdict attached. */
  toolViews(serverId: string): McpToolView[] {
    const record = this.policyRecord(serverId);
    return this.cachedTools(serverId).map((tool) => {
      const explicit = Object.prototype.hasOwnProperty.call(record.tools, tool.name);
      return {
        ...tool,
        enabled: explicit ? record.tools[tool.name] === true : record.fallback === "allow",
        implicit: !explicit,
      };
    });
  }

  /** Names the agent is allowed to see, for the workspace-state block. Empty when nothing has
   *  been discovered yet — never a placeholder that hints at withheld tools. */
  enabledToolNames(serverId: string): string[] {
    return this.toolViews(serverId).filter((tool) => tool.enabled).map((tool) => tool.name);
  }

  // ── Credentials ─────────────────────────────────────────────────────────────

  async setStaticSecret(serverId: string, value: string): Promise<void> {
    await this._context.secrets.store(secretKey("token", serverId), value);
    this._onDidChange.fire();
  }

  async getStaticSecret(serverId: string): Promise<string | undefined> {
    return this._context.secrets.get(secretKey("token", serverId));
  }

  async setEnvSecret(serverId: string, name: string, value: string): Promise<void> {
    await this._context.secrets.store(secretKey("env", serverId, name), value);
    this._onDidChange.fire();
  }

  async getEnvSecret(serverId: string, name: string): Promise<string | undefined> {
    return this._context.secrets.get(secretKey("env", serverId, name));
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
    this._onDidChange.fire();
  }

  /** Whether a server has the credential its auth mode calls for — drives the panel's badge
   *  without ever reading the secret itself into the webview. */
  async credentialStatus(serverId: string): Promise<"none" | "configured" | "missing"> {
    const entry = this.getEntry(serverId);
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
    this._onDidChange.fire();
  }

  async clearTokens(serverId: string): Promise<void> {
    await this._context.secrets.delete(secretKey("oauth", serverId));
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

  private async _resolve(serverId: string, options: ResolveOptions): Promise<McpResolution> {
    const entry = this.getEntry(serverId);
    if (!entry) {
      return { ok: false, reason: "unknown", message: `MCP server '${serverId || "(missing)"}' is not configured.` };
    }
    if (options.requireEnabled && !entry.enabled) {
      return { ok: false, reason: "disabled", message: `MCP server '${entry.name}' is disabled.` };
    }
    const target = targetOf(entry);
    if (!target) {
      return { ok: false, reason: "invalid", message: `MCP server '${entry.name}' has no ${entry.transport === "http" ? "URL" : "command"} configured.` };
    }

    const server: McpServer = {
      id: entry.id,
      url: target,
      roots: this._roots(),
      headers: entry.headers && Object.keys(entry.headers).length ? { ...entry.headers } : undefined,
    };

    if (entry.transport === "http") {
      const validated = validateHttpTarget(target);
      if (!validated.ok) return { ok: false, reason: "invalid", message: `MCP server '${entry.name}': ${validated.message}` };
      server.url = validated.url;
      server.transport = entry.transportHint ?? "auto";
    } else {
      server.transport = "stdio";
      server.env = await this._resolveEnv(entry);
    }

    const applied = await this._applyAuth(entry, server, options.audience);
    if (!applied.ok) return applied;
    return { ok: true, server };
  }

  private async _resolveEnv(entry: McpServerEntry): Promise<Record<string, string> | undefined> {
    if (!entry.env?.length) return undefined;
    const env: Record<string, string> = {};
    for (const variable of entry.env) {
      const value = variable.secret ? await this.getEnvSecret(entry.id, variable.name) : variable.value;
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
