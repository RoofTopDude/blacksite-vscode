import * as vscode from "vscode";

export interface McpServerEntry {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
}

const STATE_KEY = "blacksite.mcpServers";

/**
 * Read configured MCP servers from both the panel store (workspaceState) and the
 * `blacksite.mcpServers` setting, deduped by id. This is the single source the agent
 * uses to learn which servers it may target via mcp_list_tools / mcp_call_tool.
 */
export function getMcpServers(context: vscode.ExtensionContext): McpServerEntry[] {
  const fromState = context.workspaceState.get<McpServerEntry[]>(STATE_KEY, []);
  const fromConfig = vscode.workspace.getConfiguration("blacksite").get<McpServerEntry[]>("mcpServers", []);
  const byId = new Map<string, McpServerEntry>();
  for (const s of [...fromConfig, ...fromState]) {
    if (s && typeof s.id === "string") byId.set(s.id, s);
  }
  return [...byId.values()];
}

export class McpPanel {
  private static _instance: McpPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext): McpPanel {
    if (McpPanel._instance) {
      McpPanel._instance._panel.reveal(vscode.ViewColumn.One);
      return McpPanel._instance;
    }
    const p = new McpPanel(context);
    McpPanel._instance = p;
    return p;
  }

  private constructor(private readonly _ctx: vscode.ExtensionContext) {
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
      this._ctx.subscriptions,
    );
    this._panel.onDidDispose(() => { McpPanel._instance = undefined; });
    setTimeout(() => this._syncServers(), 80);
  }

  getServers(): McpServerEntry[] {
    return this._ctx.workspaceState.get<McpServerEntry[]>(STATE_KEY, []);
  }

  private _saveServers(servers: McpServerEntry[]): Thenable<void> {
    return this._ctx.workspaceState.update(STATE_KEY, servers);
  }

  private _syncServers(): void {
    void this._panel.webview.postMessage({ type: "servers", servers: this.getServers() });
  }

  private async _onMessage(msg: { type: string; payload?: unknown }): Promise<void> {
    const p = msg.payload as Record<string, unknown> | undefined;
    switch (msg.type) {
      case "ready":
        this._syncServers();
        break;
      case "add_server": {
        const servers = this.getServers();
        servers.push({
          id: `mcp_${Date.now()}`,
          name: String(p?.name ?? "New Server"),
          transport: (p?.transport as "stdio" | "http") ?? "http",
          command: p?.command ? String(p.command) : undefined,
          url: p?.url ? String(p.url) : undefined,
          enabled: true,
        });
        await this._saveServers(servers);
        this._syncServers();
        break;
      }
      case "remove_server": {
        const id = String(p?.id ?? "");
        await this._saveServers(this.getServers().filter((s) => s.id !== id));
        this._syncServers();
        break;
      }
      case "toggle_server": {
        const id = String(p?.id ?? "");
        await this._saveServers(this.getServers().map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s));
        this._syncServers();
        break;
      }
    }
  }

  private _buildHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
<link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap" rel="stylesheet">
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
  --accent-dim:   rgba(139,92,246,0.10);
  --accent-glow:  rgba(139,92,246,0.22);
  --accent-bd:    rgba(139,92,246,0.32);
  --ok-bg:   rgba(141,180,168,0.12); --ok:   #8db4a8; --ok-bd:   rgba(141,180,168,0.25);
  --grad: linear-gradient(135deg,#c08de0 0%,#8b5cf6 50%,#60a5fa 100%);
  --r: 12px; --r-sm: 6px; --r-pill: 999px;
  --ease: cubic-bezier(0.4,0,0.2,1); --t: 0.18s var(--ease);
  --font: 'Lexend','Inter',var(--vscode-font-family,system-ui),sans-serif;
  --mono: 'SF Mono','Fira Code','Cascadia Code',var(--vscode-editor-font-family,monospace);
  --fs: var(--vscode-font-size,13px);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{font-family:var(--font);font-size:var(--fs);color:var(--fg);background:var(--bg);padding:28px 24px;max-width:640px;-webkit-font-smoothing:antialiased;}
::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:transparent;} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.10);border-radius:2px;}

.page-header { margin-bottom: 24px; }
.page-title {
  font-size: 1.2em; font-weight: 700; letter-spacing: -0.02em;
  background: var(--grad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  display: inline-block; margin-bottom: 4px;
}
.page-sub { color: var(--muted); font-size: 12px; line-height: 1.6; }

.list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 28px; }

.card {
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: rgba(255,255,255,0.03);
  transition: border-color var(--t), background var(--t);
}
.card:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.12); }
.card.off { opacity: 0.45; }
.card-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex-shrink: 0; box-shadow: 0 0 6px rgba(141,180,168,0.5); }
.card.off .card-dot { background: var(--muted); box-shadow: none; }
.card-info { flex: 1; }
.card-name { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.card-meta { font-size: 11px; color: var(--muted); font-family: var(--mono); }
.card-actions { display: flex; gap: 6px; flex-shrink: 0; }

.empty {
  color: var(--muted); font-size: 12px; text-align: center; padding: 24px;
  border: 1px dashed rgba(255,255,255,0.10); border-radius: var(--r);
  line-height: 1.6;
}

.section {
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 20px;
  background: rgba(255,255,255,0.02);
}
.section-title { font-size: 13px; font-weight: 600; margin-bottom: 16px; color: var(--fg); }

.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.field label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
.field input, .field select {
  background: var(--input-bg); color: var(--fg);
  border: 1px solid var(--input-bd); border-radius: var(--r-sm);
  padding: 8px 10px; font-size: 13px; font-family: var(--font); outline: none;
  transition: border-color var(--t), box-shadow var(--t);
}
.field input:focus, .field select:focus {
  border-color: var(--accent-bd);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.field input::placeholder { color: var(--muted); }

.btn {
  display: inline-flex; align-items: center; gap: 5px;
  border: none; padding: 8px 16px; border-radius: var(--r-sm);
  cursor: pointer; font-family: var(--font); font-size: 12px; font-weight: 600;
  letter-spacing: 0.01em; transition: background var(--t), transform var(--t), box-shadow var(--t);
}
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(139,92,246,0.4); }
.btn.primary:active { transform: scale(0.97); box-shadow: none; }
.btn.ghost { background: rgba(255,255,255,0.06); color: var(--muted); border: 1px solid rgba(255,255,255,0.09); padding: 4px 10px; font-size: 11px; border-radius: var(--r-sm); }
.btn.ghost:hover { background: rgba(255,255,255,0.10); color: var(--fg); }

.tf { display: none; }
.tf.on { display: block; }
</style>
</head>
<body>
<div class="page-header">
  <div class="page-title">MCP Servers</div>
  <div class="page-sub">Connect Model Context Protocol servers for extended tooling.</div>
</div>
<div class="list" id="list"></div>
<div class="section">
  <div class="section-title">Add Server</div>
  <div class="field"><label>Name</label><input id="f-name" placeholder="My MCP Server"></div>
  <div class="field"><label>Transport</label>
    <select id="f-transport" onchange="onT()">
      <option value="http">HTTP / SSE</option>
      <option value="stdio">stdio</option>
    </select>
  </div>
  <div class="tf on" id="tf-http">
    <div class="field"><label>URL</label><input id="f-url" placeholder="http://localhost:3000/sse"></div>
  </div>
  <div class="tf" id="tf-stdio">
    <div class="field"><label>Command</label><input id="f-cmd" placeholder="npx @my/mcp-server"></div>
  </div>
  <button class="btn primary" onclick="add()">Add Server</button>
</div>
<script>
const vscode = acquireVsCodeApi();
let servers = [];
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function onT(){const t=document.getElementById('f-transport').value;document.getElementById('tf-http').classList.toggle('on',t==='http');document.getElementById('tf-stdio').classList.toggle('on',t==='stdio');}
function render(){
  const el=document.getElementById('list');
  if(!servers.length){el.innerHTML='<div class="empty">No MCP servers configured yet.<br>Add one below to get started.</div>';return;}
  el.innerHTML=servers.map(s=>{
    const meta=s.transport==='http'?s.url:s.command;
    return \`<div class="card\${s.enabled?'':' off'}">
      <div class="card-dot"></div>
      <div class="card-info">
        <div class="card-name">\${esc(s.name)}</div>
        <div class="card-meta">\${esc(s.transport)} · \${esc(meta||'')}</div>
      </div>
      <div class="card-actions">
        <button class="btn ghost" onclick="toggle('\${esc(s.id)}')">\${s.enabled?'Disable':'Enable'}</button>
        <button class="btn ghost" onclick="del('\${esc(s.id)}')">Remove</button>
      </div>
    </div>\`;
  }).join('');
}
function add(){
  const name=document.getElementById('f-name').value.trim();
  const transport=document.getElementById('f-transport').value;
  const url=document.getElementById('f-url').value.trim();
  const cmd=document.getElementById('f-cmd').value.trim();
  if(!name)return alert('Name is required');
  if(transport==='http'&&!url)return alert('URL is required');
  if(transport==='stdio'&&!cmd)return alert('Command is required');
  vscode.postMessage({type:'add_server',payload:{name,transport,url:url||undefined,command:cmd||undefined}});
  document.getElementById('f-name').value='';
  document.getElementById('f-url').value='';
  document.getElementById('f-cmd').value='';
}
function toggle(id){vscode.postMessage({type:'toggle_server',payload:{id}});}
function del(id){if(confirm('Remove this server?'))vscode.postMessage({type:'remove_server',payload:{id}});}
window.addEventListener('message',e=>{if(e.data.type==='servers'){servers=e.data.servers||[];render();}});
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
  }
}
