/* The MCP control surface: what is connected, what it can do, and what the agent is allowed
 * to know about.
 *
 * The tool inventory is the point of this panel. Before it, "add an MCP server" was an act of
 * faith — the user pasted a URL and the agent either gained capabilities or did not, with no
 * way to see which, and no way to withhold one tool from a server whose other nine were
 * wanted. Here every discovered tool is listed with its description and a switch, and a tool
 * switched off is not merely blocked at call time: it is filtered out of the listing the agent
 * receives, so the capability leaves no trace in the conversation for the model to reason
 * about or ask for. See filterToolsByPolicy in the runtime's mcp-protocol.ts.
 *
 * Secrets are never typed into or rendered by this webview. The panel asks the host to prompt,
 * the host stores the value in SecretStorage, and the webview only ever learns whether a
 * credential exists. */

import * as vscode from "vscode";
import { discoverMcpTools, pingMcpServer, closeMcpConnections } from "@blacksite/local-runtime";
import { createWebviewNonce } from "./webview-html.js";
import { McpOAuthError } from "./mcp-auth.js";
import type { McpAuthMode, McpEnvVar, McpRegistry, McpServerEntry } from "./mcp-registry.js";

export type { McpServerEntry } from "./mcp-registry.js";

/** Transient per-server connection state. Lives here rather than in the registry because it
 *  describes this panel session, not the configuration. */
interface ConnectionStatus {
  state: "idle" | "working" | "ok" | "error";
  message?: string;
}

interface ServerView {
  id: string;
  name: string;
  transport: "stdio" | "http";
  target: string;
  enabled: boolean;
  transportHint: "auto" | "http" | "sse";
  authMode: McpAuthMode;
  headerName?: string;
  scopes: string;
  clientId?: string;
  redirectUri?: string;
  credential: "none" | "configured" | "missing";
  env: Array<{ name: string; secret: boolean; value?: string; hasValue: boolean }>;
  headers: Array<{ name: string; value: string }>;
  fallback: "allow" | "deny";
  tools: Array<{ name: string; title?: string; description?: string; enabled: boolean; implicit: boolean }>;
  enabledCount: number;
  inventory?: {
    fetchedAt: string;
    serverName?: string;
    serverVersion?: string;
    protocolVersion?: string;
    protocolSupported?: boolean;
    capabilities?: string[];
  };
  status: ConnectionStatus;
}

export class McpPanel {
  private static _instance: McpPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _status = new Map<string, ConnectionStatus>();
  private readonly _subscriptions: vscode.Disposable[] = [];

  static show(registry: McpRegistry): McpPanel {
    if (McpPanel._instance) {
      McpPanel._instance._panel.reveal(vscode.ViewColumn.One);
      return McpPanel._instance;
    }
    const panel = new McpPanel(registry);
    McpPanel._instance = panel;
    return panel;
  }

  private constructor(private readonly _registry: McpRegistry) {
    this._panel = vscode.window.createWebviewPanel(
      "blacksite.mcp",
      "Blacksite — MCP Servers",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel.webview.html = this._buildHtml();
    this._panel.webview.onDidReceiveMessage(
      (msg: { type: string; payload?: unknown }) => void this._onMessage(msg),
      undefined,
      this._subscriptions,
    );
    // Config edited in settings.json, or credentials changed from another surface, should be
    // visible here without the user reopening the panel.
    this._subscriptions.push(this._registry.onDidChange(() => void this._sync()));
    this._panel.onDidDispose(() => {
      for (const subscription of this._subscriptions) subscription.dispose();
      this._subscriptions.length = 0;
      McpPanel._instance = undefined;
    });
    setTimeout(() => void this._sync(), 80);
  }

  // ── State ───────────────────────────────────────────────────────────────────

  private async _buildViews(): Promise<ServerView[]> {
    const views: ServerView[] = [];
    for (const entry of this._registry.listEntries()) {
      const tools = this._registry.toolViews(entry.id);
      const cache = this._registry.cacheEntry(entry.id);
      views.push({
        id: entry.id,
        name: entry.name,
        transport: entry.transport,
        target: (entry.transport === "http" ? entry.url : entry.command) ?? "",
        enabled: entry.enabled,
        transportHint: entry.transportHint ?? "auto",
        authMode: entry.auth?.mode ?? "none",
        headerName: entry.auth?.headerName,
        scopes: (entry.auth?.scopes ?? []).join(" "),
        clientId: entry.auth?.clientId,
        redirectUri: entry.auth?.redirectUri,
        credential: await this._registry.credentialStatus(entry.id),
        // Secret env values stay on the host: the webview learns only that one is set.
        env: await this._envView(entry),
        headers: Object.entries(entry.headers ?? {}).map(([name, value]) => ({ name, value })),
        fallback: this._registry.policyRecord(entry.id).fallback,
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          enabled: tool.enabled,
          implicit: tool.implicit,
        })),
        enabledCount: tools.filter((tool) => tool.enabled).length,
        inventory: cache
          ? {
              fetchedAt: cache.fetchedAt,
              serverName: cache.serverName,
              serverVersion: cache.serverVersion,
              protocolVersion: cache.protocolVersion,
              protocolSupported: cache.protocolSupported,
              capabilities: cache.capabilities,
            }
          : undefined,
        status: this._status.get(entry.id) ?? { state: "idle" },
      });
    }
    return views;
  }

  private async _envView(entry: McpServerEntry): Promise<ServerView["env"]> {
    const out: ServerView["env"] = [];
    for (const variable of entry.env ?? []) {
      const hasValue = variable.secret
        ? !!(await this._registry.getEnvSecret(entry.id, variable.name))
        : !!variable.value;
      out.push({
        name: variable.name,
        secret: !!variable.secret,
        value: variable.secret ? undefined : variable.value,
        hasValue,
      });
    }
    return out;
  }

  /** retainContextWhenHidden keeps the webview alive, so a push while the panel is hidden is
   *  still worth sending; it just must not throw when the panel is mid-dispose. */
  private async _sync(): Promise<void> {
    try {
      await this._panel.webview.postMessage({ type: "state", servers: await this._buildViews() });
    } catch { /* panel disposed between the build and the post */ }
  }

  private _setStatus(serverId: string, status: ConnectionStatus): void {
    this._status.set(serverId, status);
    void this._sync();
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  private async _onMessage(msg: { type: string; payload?: unknown }): Promise<void> {
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const id = String(p["id"] ?? "");
    switch (msg.type) {
      case "ready":
        await this._sync();
        break;

      case "add_server":
        await this._addServer(p);
        break;

      case "update_server":
        await this._registry.updateEntry(id, this._entryPatch(p));
        break;

      case "remove_server": {
        const entry = this._registry.getEntry(id);
        const confirmed = await vscode.window.showWarningMessage(
          `Remove the MCP server "${entry?.name ?? id}"?`,
          { modal: true, detail: "Its stored credentials and tool settings are deleted too." },
          "Remove",
        );
        if (confirmed !== "Remove") return;
        await this._registry.removeEntry(id);
        this._status.delete(id);
        // The pool may still hold a live process or session for the entry just deleted.
        closeMcpConnections();
        break;
      }

      case "toggle_server": {
        const entry = this._registry.getEntry(id);
        if (entry) await this._registry.updateEntry(id, { enabled: !entry.enabled });
        break;
      }

      case "test_connection":
        await this._testConnection(id);
        break;

      case "refresh_tools":
        await this._refreshTools(id);
        break;

      case "set_tool":
        await this._registry.setToolEnabled(id, String(p["tool"] ?? ""), p["enabled"] === true);
        break;

      case "set_all_tools":
        await this._registry.setAllTools(id, p["enabled"] === true);
        break;

      case "set_fallback":
        await this._registry.setToolFallback(id, p["fallback"] === "deny" ? "deny" : "allow");
        break;

      case "set_secret":
        await this._promptForSecret(id);
        break;

      case "clear_secret":
        await this._registry.clearCredentials(id);
        void vscode.window.showInformationMessage("Blacksite: stored MCP credentials cleared.");
        break;

      case "sign_in":
        await this._signIn(id);
        break;

      case "add_env":
        await this._addEnvVar(id, p);
        break;

      case "remove_env": {
        const entry = this._registry.getEntry(id);
        if (!entry) return;
        const name = String(p["name"] ?? "");
        await this._registry.updateEntry(id, { env: (entry.env ?? []).filter((v) => v.name !== name) });
        break;
      }

      case "set_env_secret": {
        const name = String(p["name"] ?? "");
        const value = await vscode.window.showInputBox({
          title: `Blacksite — ${name}`,
          prompt: `Value for ${name}. Stored in VS Code SecretStorage; it is never written to settings.`,
          password: true,
          ignoreFocusOut: true,
        });
        if (value === undefined) return;
        await this._registry.setEnvSecret(id, name, value);
        break;
      }

      case "add_header": {
        const entry = this._registry.getEntry(id);
        if (!entry) return;
        const name = String(p["name"] ?? "").trim();
        if (!name) return;
        await this._registry.updateEntry(id, {
          headers: { ...(entry.headers ?? {}), [name]: String(p["value"] ?? "") },
        });
        break;
      }

      case "remove_header": {
        const entry = this._registry.getEntry(id);
        if (!entry) return;
        const headers = { ...(entry.headers ?? {}) };
        delete headers[String(p["name"] ?? "")];
        await this._registry.updateEntry(id, { headers });
        break;
      }
    }
  }

  private _entryPatch(p: Record<string, unknown>): Partial<McpServerEntry> {
    const patch: Partial<McpServerEntry> = {};
    if (typeof p["name"] === "string" && p["name"].trim()) patch.name = p["name"].trim();
    if (typeof p["target"] === "string") {
      const target = p["target"].trim();
      if (p["transport"] === "stdio") patch.command = target;
      else patch.url = target;
    }
    if (p["transportHint"] === "auto" || p["transportHint"] === "http" || p["transportHint"] === "sse") {
      patch.transportHint = p["transportHint"];
    }
    if (typeof p["authMode"] === "string") {
      patch.auth = {
        mode: p["authMode"] as McpAuthMode,
        headerName: typeof p["headerName"] === "string" && p["headerName"].trim() ? p["headerName"].trim() : undefined,
        scopes: typeof p["scopes"] === "string" && p["scopes"].trim() ? p["scopes"].trim().split(/[\s,]+/) : undefined,
        clientId: typeof p["clientId"] === "string" && p["clientId"].trim() ? p["clientId"].trim() : undefined,
        redirectUri: typeof p["redirectUri"] === "string" && p["redirectUri"].trim() ? p["redirectUri"].trim() : undefined,
      };
    }
    return patch;
  }

  private async _addServer(p: Record<string, unknown>): Promise<void> {
    const transport = p["transport"] === "stdio" ? "stdio" : "http";
    const target = String(p["target"] ?? "").trim();
    const name = String(p["name"] ?? "").trim();
    if (!name || !target) return;
    const entry = await this._registry.addEntry({
      name,
      transport,
      command: transport === "stdio" ? target : undefined,
      url: transport === "http" ? target : undefined,
      enabled: true,
      auth: { mode: (p["authMode"] as McpAuthMode) ?? "none" },
    });
    // A new server with no inventory tells the user nothing, so discover immediately — this
    // is also the fastest way to learn the connection details are wrong.
    await this._refreshTools(entry.id);
  }

  private async _addEnvVar(serverId: string, p: Record<string, unknown>): Promise<void> {
    const entry = this._registry.getEntry(serverId);
    if (!entry) return;
    const name = String(p["name"] ?? "").trim();
    if (!name) return;
    const secret = p["secret"] === true;
    const variable: McpEnvVar = secret ? { name, secret: true } : { name, value: String(p["value"] ?? "") };
    const env = [...(entry.env ?? []).filter((v) => v.name !== name), variable];
    await this._registry.updateEntry(serverId, { env });
    if (secret) {
      const value = await vscode.window.showInputBox({
        title: `Blacksite — ${name}`,
        prompt: `Value for ${name}. Stored in VS Code SecretStorage; it is never written to settings.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (value !== undefined) await this._registry.setEnvSecret(serverId, name, value);
    }
  }

  private async _promptForSecret(serverId: string): Promise<void> {
    const entry = this._registry.getEntry(serverId);
    if (!entry) return;
    const mode = entry.auth?.mode ?? "none";
    const label = mode === "header" ? (entry.auth?.headerName || "Authorization") : "Bearer token";
    const value = await vscode.window.showInputBox({
      title: `Blacksite — ${entry.name}`,
      prompt: `${label} for ${entry.name}. Stored in VS Code SecretStorage; it is never written to settings or sent anywhere but this server.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!value?.trim()) return;
    await this._registry.setStaticSecret(serverId, value.trim());
    await this._refreshTools(serverId);
  }

  /**
   * Run the OAuth flow, then immediately re-discover.
   *
   * Re-discovery is not a nicety: authorization is the step that usually *changes* what a
   * server offers, and a token obtained against an empty inventory would leave the user
   * looking at a panel that still says the server has no tools.
   */
  private async _signIn(serverId: string): Promise<void> {
    const entry = this._registry.getEntry(serverId);
    if (!entry) return;
    if (entry.transport !== "http" || !entry.url) {
      void vscode.window.showWarningMessage("OAuth applies to HTTP MCP servers. A local stdio server takes its credentials through environment variables.");
      return;
    }

    this._setStatus(serverId, { state: "working", message: "Waiting for authorization in your browser…" });
    try {
      // The 401 challenge is the authoritative pointer to this server's metadata, so ask for
      // it first; discovery falls back to well-known probing when there is none.
      const probe = await pingMcpServer({ id: serverId, url: entry.url, transport: entry.transportHint ?? "auto" });
      const resourceMetadataUrl = !probe.ok ? probe.authChallenge?.resourceMetadataUrl : undefined;

      await this._registry.oauth.authorize({
        serverId,
        serverName: entry.name,
        endpoint: entry.url,
        config: this._registry.oauthConfigFor(entry),
        resourceMetadataUrl,
      });
      this._setStatus(serverId, { state: "ok", message: "Authorized." });
      void vscode.window.showInformationMessage(`Blacksite: authorized ${entry.name}.`);
      await this._refreshTools(serverId);
    } catch (error) {
      const message = error instanceof McpOAuthError || error instanceof Error ? error.message : String(error);
      this._setStatus(serverId, { state: "error", message });
      void vscode.window.showErrorMessage(`Blacksite: authorization failed — ${message}`);
    }
  }

  private async _testConnection(serverId: string): Promise<void> {
    const resolved = await this._registry.resolveForPanel(serverId);
    if (!resolved.ok) {
      this._setStatus(serverId, { state: "error", message: resolved.message });
      return;
    }
    this._setStatus(serverId, { state: "working", message: "Connecting…" });
    const result = await pingMcpServer(resolved.server);
    if (!result.ok) {
      this._setStatus(serverId, {
        state: "error",
        message: result.authRequired ? `${result.error} Sign in to continue.` : result.error,
      });
      return;
    }
    this._setStatus(serverId, {
      state: "ok",
      message: `${result.server.name}${result.server.version ? ` ${result.server.version}` : ""} · MCP ${result.server.protocolVersion}`,
    });
  }

  /** Discover the *unfiltered* inventory and cache it. This is the only path that sees tools
   *  the user has withheld — the agent's listing goes through listMcpTools instead. */
  private async _refreshTools(serverId: string): Promise<void> {
    const resolved = await this._registry.resolveForPanel(serverId);
    if (!resolved.ok) {
      this._setStatus(serverId, { state: "error", message: resolved.message });
      return;
    }
    this._setStatus(serverId, { state: "working", message: "Discovering tools…" });
    const result = await discoverMcpTools(resolved.server);
    if (!result.ok) {
      this._setStatus(serverId, {
        state: "error",
        message: result.authRequired ? `${result.error} Sign in to continue.` : result.error,
      });
      return;
    }
    await this._registry.setCache(serverId, {
      fetchedAt: new Date().toISOString(),
      serverName: result.server.name,
      serverVersion: result.server.version,
      protocolVersion: result.server.protocolVersion,
      protocolSupported: result.server.protocolSupported,
      capabilities: result.server.capabilities,
      tools: result.tools,
    });
    this._setStatus(serverId, {
      state: "ok",
      message: `${result.tools.length} tool${result.tools.length === 1 ? "" : "s"} discovered.`,
    });
  }

  // ── View ────────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    const nonce = createWebviewNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>MCP Servers</title>
<style>
:root {
  --bg:      var(--vscode-editor-background, #09090b);
  --fg:      var(--vscode-foreground, #f4f4f5);
  --muted:   var(--vscode-descriptionForeground, #71717a);
  --border:  rgba(255,255,255,0.08);
  --input-bg: rgba(255,255,255,0.06);
  --input-bd: rgba(255,255,255,0.12);
  --accent:       #8b5cf6;
  --accent-hover: #7c3aed;
  --accent-glow:  rgba(139,92,246,0.22);
  --accent-bd:    rgba(139,92,246,0.32);
  --ok-bg:   rgba(141,180,168,0.12); --ok:   #8db4a8; --ok-bd:   rgba(141,180,168,0.25);
  --warn-bg: rgba(230,180,120,0.12); --warn: #e6b478; --warn-bd: rgba(230,180,120,0.28);
  --err-bg:  rgba(226,120,120,0.12); --err:  #e27878; --err-bd:  rgba(226,120,120,0.28);
  --grad: linear-gradient(135deg,#c08de0 0%,#8b5cf6 50%,#60a5fa 100%);
  --r: 12px; --r-sm: 6px; --r-pill: 999px;
  --ease: cubic-bezier(0.4,0,0.2,1); --t: 0.18s var(--ease);
  --font: var(--vscode-font-family,system-ui),sans-serif;
  --mono: 'SF Mono','Fira Code','Cascadia Code',var(--vscode-editor-font-family,monospace);
  --fs: var(--vscode-font-size,13px);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{font-family:var(--font);font-size:var(--fs);color:var(--fg);background:var(--bg);padding:28px 24px;max-width:860px;-webkit-font-smoothing:antialiased;}
::-webkit-scrollbar{width:4px;height:4px;} ::-webkit-scrollbar-track{background:transparent;} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.10);border-radius:2px;}

.page-header { margin-bottom: 22px; }
.page-title {
  font-size: 1.2em; font-weight: 700; letter-spacing: -0.02em;
  background: var(--grad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  display: inline-block; margin-bottom: 4px;
}
.page-sub { color: var(--muted); font-size: 12px; line-height: 1.6; max-width: 62ch; }

.list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 26px; }

.card { border: 1px solid var(--border); border-radius: var(--r); background: rgba(255,255,255,0.03); transition: border-color var(--t); }
.card:hover { border-color: rgba(255,255,255,0.12); }
.card.off .card-head { opacity: 0.5; }
.card-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; }
.card-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
.card.on .card-dot { background: var(--ok); box-shadow: 0 0 6px rgba(141,180,168,0.5); }
.card.err .card-dot { background: var(--err); box-shadow: 0 0 6px rgba(226,120,120,0.5); }
.card-info { flex: 1; min-width: 0; }
.card-name { font-weight: 600; font-size: 13px; margin-bottom: 2px; display: flex; align-items: center; gap: 8px; }
.card-meta { font-size: 11px; color: var(--muted); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
.chev { color: var(--muted); font-size: 10px; transition: transform var(--t); }
.card.open .chev { transform: rotate(90deg); }

.badge { font-size: 10px; padding: 2px 8px; border-radius: var(--r-pill); font-weight: 600; letter-spacing: 0.02em; border: 1px solid transparent; }
.badge.ok   { background: var(--ok-bg);   color: var(--ok);   border-color: var(--ok-bd); }
.badge.warn { background: var(--warn-bg); color: var(--warn); border-color: var(--warn-bd); }
.badge.err  { background: var(--err-bg);  color: var(--err);  border-color: var(--err-bd); }
.badge.dim  { background: rgba(255,255,255,0.06); color: var(--muted); border-color: rgba(255,255,255,0.09); }

.body { display: none; border-top: 1px solid var(--border); padding: 16px; }
.card.open .body { display: block; }

.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.status { font-size: 11px; color: var(--muted); flex: 1; min-width: 12rem; line-height: 1.5; }
.status.ok { color: var(--ok); } .status.err { color: var(--err); } .status.working { color: var(--warn); }

.sec { margin-top: 16px; }
.sec-title { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600; margin-bottom: 8px; display:flex; align-items:center; gap:8px; }
.sec-title .spacer { flex: 1; }

.grid { display: grid; grid-template-columns: minmax(7rem, 10rem) 1fr; gap: 8px 10px; align-items: center; }
label.k { font-size: 11px; color: var(--muted); }
input, select {
  background: var(--input-bg); color: var(--fg); width: 100%;
  border: 1px solid var(--input-bd); border-radius: var(--r-sm);
  padding: 6px 9px; font-size: 12px; font-family: var(--font); outline: none;
  transition: border-color var(--t), box-shadow var(--t);
}
input.mono { font-family: var(--mono); }
input:focus, select:focus { border-color: var(--accent-bd); box-shadow: 0 0 0 3px var(--accent-glow); }
input::placeholder { color: var(--muted); }

.btn { display: inline-flex; align-items: center; gap: 5px; border: none; padding: 6px 12px; border-radius: var(--r-sm);
  cursor: pointer; font-family: var(--font); font-size: 11.5px; font-weight: 600; transition: background var(--t), color var(--t), transform var(--t); }
.btn.primary { background: var(--accent); color: #fff; padding: 8px 16px; font-size: 12px; }
.btn.primary:hover { background: var(--accent-hover); }
.btn.primary:active { transform: scale(0.98); }
.btn.ghost { background: rgba(255,255,255,0.06); color: var(--muted); border: 1px solid rgba(255,255,255,0.09); }
.btn.ghost:hover { background: rgba(255,255,255,0.10); color: var(--fg); }
.btn.danger:hover { background: var(--err-bg); color: var(--err); border-color: var(--err-bd); }

.tools { display: flex; flex-direction: column; gap: 2px; max-height: 22rem; overflow-y: auto; margin: 0 -6px; padding: 0 6px; }
.tool { display: flex; gap: 10px; padding: 8px; border-radius: var(--r-sm); align-items: flex-start; transition: background var(--t); }
.tool:hover { background: rgba(255,255,255,0.035); }
.tool.off .tool-name, .tool.off .tool-desc { opacity: 0.4; }
.tool-body { flex: 1; min-width: 0; }
.tool-name { font-family: var(--mono); font-size: 11.5px; font-weight: 600; }
.tool-desc { font-size: 11px; color: var(--muted); line-height: 1.5; margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* A switch rather than a checkbox: this is a policy decision about a capability, and it
   should read as one at a glance across a list of thirty. */
.sw { position: relative; width: 30px; height: 17px; flex-shrink: 0; border-radius: var(--r-pill); border: none;
  background: rgba(255,255,255,0.14); cursor: pointer; transition: background var(--t); margin-top: 1px; }
.sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;
  background: #fff; transition: transform var(--t); }
.sw.on { background: var(--accent); }
.sw.on::after { transform: translateX(13px); }

.empty { color: var(--muted); font-size: 12px; text-align: center; padding: 22px;
  border: 1px dashed rgba(255,255,255,0.10); border-radius: var(--r); line-height: 1.6; }
.hint { font-size: 10.5px; color: var(--muted); line-height: 1.5; margin-top: 6px; }

.kvline { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.kvline .kv-name { font-family: var(--mono); font-size: 11.5px; flex: 0 0 auto; min-width: 8rem; }
.kvline .kv-val { font-size: 11px; color: var(--muted); font-family: var(--mono); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.section { border: 1px solid var(--border); border-radius: var(--r); padding: 18px; background: rgba(255,255,255,0.02); }
.section-title { font-size: 13px; font-weight: 600; margin-bottom: 14px; }
.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.field label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
.tf { display: none; } .tf.on { display: block; }
</style>
</head>
<body>
<div class="page-header">
  <div class="page-title">MCP Servers</div>
  <div class="page-sub">Connect Model Context Protocol servers, then choose exactly which of their tools the agent may use. A tool switched off is removed from the catalog the agent sees — it is not told the tool exists.</div>
</div>

<div class="list" id="list"></div>

<div class="section">
  <div class="section-title">Add server</div>
  <div class="field"><label>Name</label><input id="f-name" placeholder="My MCP Server"></div>
  <div class="field"><label>Transport</label>
    <select id="f-transport"><option value="http">HTTP (remote)</option><option value="stdio">stdio (local process)</option></select>
  </div>
  <div class="tf on" id="tf-http"><div class="field"><label>URL</label><input class="mono" id="f-url" placeholder="https://example.com/mcp"></div></div>
  <div class="tf" id="tf-stdio"><div class="field"><label>Command</label><input class="mono" id="f-cmd" placeholder="npx -y @modelcontextprotocol/server-filesystem ."></div></div>
  <div class="field"><label>Authentication</label>
    <select id="f-auth">
      <option value="none">None</option>
      <option value="oauth">OAuth (sign in with browser)</option>
      <option value="bearer">Bearer token</option>
      <option value="header">Custom header</option>
    </select>
  </div>
  <button class="btn primary" id="add-server" type="button">Add server</button>
  <div class="hint">Remote servers must use HTTPS unless they are on localhost. Tokens are kept in VS Code SecretStorage, never in settings.</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let servers = [];
const open = new Set();
const filters = new Map();

const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const post = (type, payload) => vscode.postMessage({ type, payload });

function authBadge(s) {
  if (s.authMode === 'none') return '';
  if (s.credential === 'configured') return '<span class="badge ok">' + (s.authMode === 'oauth' ? 'signed in' : 'token set') + '</span>';
  return '<span class="badge warn">' + (s.authMode === 'oauth' ? 'sign-in needed' : 'token needed') + '</span>';
}

function toolBadge(s) {
  if (!s.inventory) return '<span class="badge dim">not discovered</span>';
  const total = s.tools.length;
  if (total === 0) return '<span class="badge dim">no tools</span>';
  const cls = s.enabledCount === 0 ? 'err' : (s.enabledCount < total ? 'warn' : 'ok');
  return '<span class="badge ' + cls + '">' + s.enabledCount + '/' + total + ' tools</span>';
}

function renderTools(s) {
  const filter = (filters.get(s.id) || '').toLowerCase();
  if (!s.inventory) {
    return '<div class="empty">No inventory yet. Discover tools to see what this server offers.</div>';
  }
  const shown = s.tools.filter((t) => !filter
    || t.name.toLowerCase().includes(filter)
    || (t.description || '').toLowerCase().includes(filter));
  if (!shown.length) return '<div class="empty">' + (s.tools.length ? 'No tools match that filter.' : 'This server exposes no tools.') + '</div>';
  return '<div class="tools">' + shown.map((t) =>
    '<div class="tool ' + (t.enabled ? '' : 'off') + '">' +
      '<button class="sw ' + (t.enabled ? 'on' : '') + '" type="button" data-action="tool" data-id="' + esc(s.id) + '" data-tool="' + esc(t.name) + '" data-enabled="' + (t.enabled ? '1' : '0') + '" title="' + (t.enabled ? 'Withhold this tool from the agent' : 'Allow the agent to use this tool') + '"></button>' +
      '<div class="tool-body">' +
        '<div class="tool-name">' + esc(t.name) + (t.title ? ' <span style="color:var(--muted);font-weight:400">· ' + esc(t.title) + '</span>' : '') + '</div>' +
        (t.description ? '<div class="tool-desc">' + esc(t.description) + '</div>' : '') +
      '</div>' +
    '</div>').join('') + '</div>';
}

function renderAuth(s) {
  if (s.authMode === 'none') return '';
  const rows = [];
  if (s.authMode === 'header') {
    rows.push('<label class="k">Header name</label><input data-field="headerName" data-id="' + esc(s.id) + '" class="mono" value="' + esc(s.headerName || '') + '" placeholder="X-API-Key">');
  }
  if (s.authMode === 'oauth') {
    rows.push('<label class="k">Scopes</label><input data-field="scopes" data-id="' + esc(s.id) + '" class="mono" value="' + esc(s.scopes) + '" placeholder="(server default)">');
    rows.push('<label class="k">Client ID</label><input data-field="clientId" data-id="' + esc(s.id) + '" class="mono" value="' + esc(s.clientId || '') + '" placeholder="(registered automatically)">');
    rows.push('<label class="k">Redirect URI</label><input data-field="redirectUri" data-id="' + esc(s.id) + '" class="mono" value="' + esc(s.redirectUri || '') + '" placeholder="http://127.0.0.1:33418/callback">');
  }
  const buttons = s.authMode === 'oauth'
    ? '<button class="btn ghost" type="button" data-action="sign_in" data-id="' + esc(s.id) + '">' + (s.credential === 'configured' ? 'Re-authorize' : 'Sign in') + '</button>'
    : '<button class="btn ghost" type="button" data-action="set_secret" data-id="' + esc(s.id) + '">' + (s.credential === 'configured' ? 'Replace token' : 'Set token') + '</button>';
  const clear = s.credential === 'configured'
    ? '<button class="btn ghost danger" type="button" data-action="clear_secret" data-id="' + esc(s.id) + '">Sign out</button>' : '';
  return '<div class="sec"><div class="sec-title">Authentication<span class="spacer"></span>' + buttons + clear + '</div>' +
    (rows.length ? '<div class="grid">' + rows.join('') + '</div>' : '') + '</div>';
}

function renderEnv(s) {
  if (s.transport !== 'stdio') return '';
  const rows = s.env.map((v) =>
    '<div class="kvline">' +
      '<span class="kv-name">' + esc(v.name) + '</span>' +
      '<span class="kv-val">' + (v.secret ? (v.hasValue ? '•••••••• stored' : 'not set') : esc(v.value || '')) + '</span>' +
      (v.secret ? '<button class="btn ghost" type="button" data-action="set_env" data-id="' + esc(s.id) + '" data-name="' + esc(v.name) + '">Set</button>' : '') +
      '<button class="btn ghost danger" type="button" data-action="remove_env" data-id="' + esc(s.id) + '" data-name="' + esc(v.name) + '">Remove</button>' +
    '</div>').join('');
  return '<div class="sec"><div class="sec-title">Environment</div>' + rows +
    '<div class="kvline">' +
      '<input class="mono" placeholder="NAME" data-env-name="' + esc(s.id) + '" style="max-width:11rem">' +
      '<input class="mono" placeholder="value (leave blank for a secret)" data-env-value="' + esc(s.id) + '">' +
      '<button class="btn ghost" type="button" data-action="add_env" data-id="' + esc(s.id) + '">Add</button>' +
    '</div>' +
    '<div class="hint">Leave the value blank to store it as a secret — you will be prompted, and it is kept in SecretStorage.</div></div>';
}

function renderHeaders(s) {
  if (s.transport !== 'http') return '';
  const rows = s.headers.map((h) =>
    '<div class="kvline">' +
      '<span class="kv-name">' + esc(h.name) + '</span><span class="kv-val">' + esc(h.value) + '</span>' +
      '<button class="btn ghost danger" type="button" data-action="remove_header" data-id="' + esc(s.id) + '" data-name="' + esc(h.name) + '">Remove</button>' +
    '</div>').join('');
  return '<div class="sec"><div class="sec-title">Static headers</div>' + rows +
    '<div class="kvline">' +
      '<input class="mono" placeholder="Header" data-hdr-name="' + esc(s.id) + '" style="max-width:11rem">' +
      '<input class="mono" placeholder="value" data-hdr-value="' + esc(s.id) + '">' +
      '<button class="btn ghost" type="button" data-action="add_header" data-id="' + esc(s.id) + '">Add</button>' +
    '</div><div class="hint">For non-secret values only — put credentials in Authentication above.</div></div>';
}

function renderInventoryLine(s) {
  if (!s.inventory) return '';
  const i = s.inventory;
  const bits = [];
  if (i.serverName) bits.push(esc(i.serverName) + (i.serverVersion ? ' ' + esc(i.serverVersion) : ''));
  if (i.protocolVersion) bits.push('MCP ' + esc(i.protocolVersion) + (i.protocolSupported === false ? ' (unrecognized revision)' : ''));
  if (i.capabilities && i.capabilities.length) bits.push(i.capabilities.map(esc).join(', '));
  bits.push('checked ' + new Date(i.fetchedAt).toLocaleString());
  return '<div class="hint">' + bits.join(' · ') + '</div>';
}

function render() {
  const el = document.getElementById('list');
  if (!servers.length) {
    el.innerHTML = '<div class="empty">No MCP servers configured yet.<br>Add one below to extend what the agent can do.</div>';
    return;
  }
  el.innerHTML = servers.map((s) => {
    const isOpen = open.has(s.id);
    const cls = ['card'];
    if (isOpen) cls.push('open');
    if (!s.enabled) cls.push('off');
    else if (s.status.state === 'error') cls.push('err');
    else if (s.status.state === 'ok' || s.enabledCount > 0) cls.push('on');
    const statusCls = s.status.state === 'ok' ? 'ok' : s.status.state === 'error' ? 'err' : s.status.state === 'working' ? 'working' : '';
    return '<div class="' + cls.join(' ') + '">' +
      '<div class="card-head" data-action="expand" data-id="' + esc(s.id) + '">' +
        '<span class="card-dot"></span>' +
        '<div class="card-info">' +
          '<div class="card-name">' + esc(s.name) + toolBadge(s) + authBadge(s) + (s.enabled ? '' : '<span class="badge dim">disabled</span>') + '</div>' +
          '<div class="card-meta">' + esc(s.transport) + ' · ' + esc(s.target) + '</div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn ghost" type="button" data-action="toggle" data-id="' + esc(s.id) + '">' + (s.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<span class="chev">▶</span>' +
        '</div>' +
      '</div>' +
      '<div class="body">' +
        '<div class="row">' +
          '<span class="status ' + statusCls + '">' + esc(s.status.message || 'Not checked yet.') + '</span>' +
          '<button class="btn ghost" type="button" data-action="test" data-id="' + esc(s.id) + '">Test connection</button>' +
          '<button class="btn ghost" type="button" data-action="refresh" data-id="' + esc(s.id) + '">Discover tools</button>' +
          '<button class="btn ghost danger" type="button" data-action="remove" data-id="' + esc(s.id) + '">Remove</button>' +
        '</div>' +
        renderInventoryLine(s) +
        '<div class="sec"><div class="sec-title">Connection</div><div class="grid">' +
          '<label class="k">Name</label><input data-field="name" data-id="' + esc(s.id) + '" value="' + esc(s.name) + '">' +
          '<label class="k">' + (s.transport === 'http' ? 'URL' : 'Command') + '</label><input class="mono" data-field="target" data-id="' + esc(s.id) + '" value="' + esc(s.target) + '">' +
          '<label class="k">Auth mode</label><select data-field="authMode" data-id="' + esc(s.id) + '">' +
            ['none','oauth','bearer','header'].map((m) => '<option value="' + m + '"' + (s.authMode === m ? ' selected' : '') + '>' + m + '</option>').join('') +
          '</select>' +
          (s.transport === 'http'
            ? '<label class="k">Protocol</label><select data-field="transportHint" data-id="' + esc(s.id) + '">' +
                [['auto','Auto-detect'],['http','Streamable HTTP'],['sse','Legacy HTTP+SSE']].map(([v,l]) =>
                  '<option value="' + v + '"' + (s.transportHint === v ? ' selected' : '') + '>' + l + '</option>').join('') +
              '</select>'
            : '') +
        '</div></div>' +
        renderAuth(s) +
        renderEnv(s) +
        renderHeaders(s) +
        '<div class="sec">' +
          '<div class="sec-title">Tools the agent may use<span class="spacer"></span>' +
            '<button class="btn ghost" type="button" data-action="all_on" data-id="' + esc(s.id) + '">Enable all</button>' +
            '<button class="btn ghost" type="button" data-action="all_off" data-id="' + esc(s.id) + '">Disable all</button>' +
          '</div>' +
          '<div class="row">' +
            '<input placeholder="Filter tools…" data-filter="' + esc(s.id) + '" value="' + esc(filters.get(s.id) || '') + '" style="flex:1;min-width:10rem">' +
            '<label class="k" style="display:flex;align-items:center;gap:6px;white-space:nowrap">New tools' +
              '<select data-field="fallback" data-id="' + esc(s.id) + '" style="width:auto">' +
                '<option value="allow"' + (s.fallback === 'allow' ? ' selected' : '') + '>allowed</option>' +
                '<option value="deny"' + (s.fallback === 'deny' ? ' selected' : '') + '>withheld</option>' +
              '</select></label>' +
          '</div>' +
          renderTools(s) +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function commitField(input) {
  const id = input.dataset.id;
  const s = servers.find((x) => x.id === id);
  if (!s) return;
  const field = input.dataset.field;
  if (field === 'fallback') { post('set_fallback', { id, fallback: input.value }); return; }
  post('update_server', {
    id,
    transport: s.transport,
    name: field === 'name' ? input.value : s.name,
    target: field === 'target' ? input.value : s.target,
    transportHint: field === 'transportHint' ? input.value : s.transportHint,
    authMode: field === 'authMode' ? input.value : s.authMode,
    headerName: field === 'headerName' ? input.value : s.headerName,
    scopes: field === 'scopes' ? input.value : s.scopes,
    clientId: field === 'clientId' ? input.value : s.clientId,
    redirectUri: field === 'redirectUri' ? input.value : s.redirectUri,
  });
}

document.getElementById('list').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id || '';
  switch (el.dataset.action) {
    case 'expand':
      if (e.target.closest('button')) return;
      if (open.has(id)) open.delete(id); else open.add(id);
      render();
      break;
    case 'toggle':  post('toggle_server', { id }); break;
    case 'remove':  post('remove_server', { id }); break;
    case 'test':    post('test_connection', { id }); break;
    case 'refresh': post('refresh_tools', { id }); break;
    case 'tool':    post('set_tool', { id, tool: el.dataset.tool, enabled: el.dataset.enabled !== '1' }); break;
    case 'all_on':  post('set_all_tools', { id, enabled: true }); break;
    case 'all_off': post('set_all_tools', { id, enabled: false }); break;
    case 'sign_in': post('sign_in', { id }); break;
    case 'set_secret':   post('set_secret', { id }); break;
    case 'clear_secret': post('clear_secret', { id }); break;
    case 'set_env':      post('set_env_secret', { id, name: el.dataset.name }); break;
    case 'remove_env':   post('remove_env', { id, name: el.dataset.name }); break;
    case 'remove_header': post('remove_header', { id, name: el.dataset.name }); break;
    case 'add_env': {
      const name = document.querySelector('[data-env-name="' + CSS.escape(id) + '"]');
      const value = document.querySelector('[data-env-value="' + CSS.escape(id) + '"]');
      if (!name || !name.value.trim()) return;
      post('add_env', { id, name: name.value.trim(), value: value.value, secret: !value.value.trim() });
      name.value = ''; value.value = '';
      break;
    }
    case 'add_header': {
      const name = document.querySelector('[data-hdr-name="' + CSS.escape(id) + '"]');
      const value = document.querySelector('[data-hdr-value="' + CSS.escape(id) + '"]');
      if (!name || !name.value.trim()) return;
      post('add_header', { id, name: name.value.trim(), value: value.value });
      name.value = ''; value.value = '';
      break;
    }
  }
});

/* Committed on change/blur rather than on every keystroke: each commit round-trips through
   the host and re-renders the list, which would otherwise steal focus mid-word. */
document.getElementById('list').addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.field) commitField(e.target);
});
document.getElementById('list').addEventListener('input', (e) => {
  const id = e.target.dataset && e.target.dataset.filter;
  if (!id) return;
  filters.set(id, e.target.value);
  const list = e.target.closest('.sec');
  const s = servers.find((x) => x.id === id);
  if (list && s) {
    const holder = list.querySelector('.tools') || list.querySelector('.empty');
    if (holder) holder.outerHTML = renderTools(s);
  }
});

document.getElementById('f-transport').addEventListener('change', () => {
  const t = document.getElementById('f-transport').value;
  document.getElementById('tf-http').classList.toggle('on', t === 'http');
  document.getElementById('tf-stdio').classList.toggle('on', t === 'stdio');
});

document.getElementById('add-server').addEventListener('click', () => {
  const name = document.getElementById('f-name').value.trim();
  const transport = document.getElementById('f-transport').value;
  const target = (transport === 'http' ? document.getElementById('f-url').value : document.getElementById('f-cmd').value).trim();
  if (!name || !target) return;
  post('add_server', { name, transport, target, authMode: document.getElementById('f-auth').value });
  document.getElementById('f-name').value = '';
  document.getElementById('f-url').value = '';
  document.getElementById('f-cmd').value = '';
});

window.addEventListener('message', (e) => {
  if (e.data.type !== 'state') return;
  servers = e.data.servers || [];
  // Keep a newly added server open so its tool list is the next thing the user sees.
  if (servers.length === 1 && !open.size) open.add(servers[0].id);
  render();
});

post('ready', {});
</script>
</body>
</html>`;
  }
}
