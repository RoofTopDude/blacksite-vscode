/* Import MCP servers another client already has configured, instead of retyping them.
 *
 * Pure apart from reading files through the `readFile` the caller passes, so the parsers and
 * the location list are testable without a filesystem. Nothing here is loaded automatically:
 * a repository's .vscode/mcp.json or .mcp.json can name any command, so every server found is
 * shown to the user, with its command line, and added only when they pick it. That choice is the
 * trust decision a plugin's trust prompt makes for plugin servers.
 *
 * Credentials found in another client's file are not copied into Blacksite's settings: an env
 * variable or header that looks like a secret is moved into SecretStorage, and a VS Code
 * `${input:…}` prompt becomes a secret to fill in. */

import * as path from "path";
import { normalizeEntry, parseJsonc, type McpAuthConfig, type McpEnvVar, type McpServerEntry } from "./mcp-config.js";

export type ImportFormat = "vscode" | "mcpServers" | "claude-code-user";

export interface ImportSource {
  /** Where it came from, as the picker shows it: "Claude Desktop", "VS Code (this project)". */
  label: string;
  file: string;
  format: ImportFormat;
}

/** A server found in another client's config, ready to add. */
export interface ImportCandidate {
  name: string;
  source: string;
  entry: Omit<McpServerEntry, "id">;
  /** Values to store in SecretStorage after the entry is added: env names, or "token". */
  secrets: Array<{ kind: "env"; name: string; value: string } | { kind: "token"; value: string }>;
  /** Secrets that need a value the other client would have prompted for. */
  missingSecrets: string[];
}

/** Names that hold a credential. Matched against env-var and header names. */
const SECRET_NAME = /(token|secret|password|passwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth|pat\b|_pat|cookie|session)/i;

export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

interface LocationContext {
  platform: NodeJS.Platform;
  home: string;
  /** %APPDATA% on Windows. */
  appData?: string;
  /** VS Code's user folder (the one holding settings.json). */
  vscodeUserDir?: string;
  workspaceRoots: string[];
}

/** Every file another client keeps MCP servers in, in the order the picker lists them. */
export function importSources(context: LocationContext): ImportSource[] {
  const sources: ImportSource[] = [];
  const multiRoot = context.workspaceRoots.length > 1;
  for (const root of context.workspaceRoots) {
    const where = multiRoot ? ` (${path.basename(root)})` : " (this project)";
    sources.push({ label: `VS Code${where}`, file: path.join(root, ".vscode", "mcp.json"), format: "vscode" });
    sources.push({ label: `Claude Code${where}`, file: path.join(root, ".mcp.json"), format: "mcpServers" });
    sources.push({ label: `Cursor${where}`, file: path.join(root, ".cursor", "mcp.json"), format: "mcpServers" });
  }
  if (context.vscodeUserDir) sources.push({ label: "VS Code (user)", file: path.join(context.vscodeUserDir, "mcp.json"), format: "vscode" });
  sources.push({ label: "Claude Code (user)", file: path.join(context.home, ".claude.json"), format: "claude-code-user" });
  const desktop = context.platform === "win32"
    ? path.join(context.appData ?? path.join(context.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : context.platform === "darwin"
      ? path.join(context.home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(context.home, ".config", "Claude", "claude_desktop_config.json");
  sources.push({ label: "Claude Desktop", file: desktop, format: "mcpServers" });
  sources.push({ label: "Cursor (user)", file: path.join(context.home, ".cursor", "mcp.json"), format: "mcpServers" });
  sources.push({ label: "Windsurf", file: path.join(context.home, ".codeium", "windsurf", "mcp_config.json"), format: "mcpServers" });
  return sources;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The `{ name: config }` maps a file holds, with a source label for each. */
function serverMaps(parsed: unknown, source: ImportSource): Array<{ label: string; servers: Record<string, unknown> }> {
  const root = record(parsed);
  if (!root) return [];
  if (source.format === "vscode") {
    // mcp.json uses `servers`; older VS Code settings nested it under `mcp`.
    const servers = record(root["servers"]) ?? record(record(root["mcp"])?.["servers"]);
    return servers ? [{ label: source.label, servers }] : [];
  }
  const maps: Array<{ label: string; servers: Record<string, unknown> }> = [];
  const top = record(root["mcpServers"]);
  if (top) maps.push({ label: source.label, servers: top });
  if (source.format === "claude-code-user") {
    // ~/.claude.json keeps "local"-scope servers per project path.
    for (const [projectPath, project] of Object.entries(record(root["projects"]) ?? {})) {
      const servers = record(record(project)?.["mcpServers"]);
      if (servers && Object.keys(servers).length) maps.push({ label: `Claude Code (${path.basename(projectPath) || projectPath})`, servers });
    }
  }
  return maps;
}

/** Turn one server's config into an entry, moving anything that looks like a credential out
 *  of it. Returns undefined for a config that names neither a command nor a URL. */
export function candidateFrom(name: string, raw: unknown, source: string): ImportCandidate | undefined {
  const normalized = normalizeEntry(raw, name);
  if (!normalized) return undefined;
  const { id: _id, ...entry } = normalized;
  entry.name = name;
  if (!(entry.transport === "http" ? entry.url : entry.command)) return undefined;
  const secrets: ImportCandidate["secrets"] = [];
  const missingSecrets: string[] = [];

  if (entry.env?.length) {
    entry.env = entry.env.map((variable): McpEnvVar => {
      const value = variable.value ?? "";
      if (/\$\{input:[^}]+\}/.test(value)) {
        missingSecrets.push(variable.name);
        return { name: variable.name, secret: true };
      }
      // A reference to the user's own environment is not a secret value; keep it as written.
      if (looksSecret(variable.name) && value && !/^\$\{[^}]+\}$/.test(value)) {
        secrets.push({ kind: "env", name: variable.name, value });
        return { name: variable.name, secret: true };
      }
      return variable;
    });
  }

  if (entry.transport === "http" && entry.headers) {
    const headers = { ...entry.headers };
    let auth: McpAuthConfig | undefined;
    for (const [header, value] of Object.entries(headers)) {
      const isAuthorization = header.toLowerCase() === "authorization";
      if (!isAuthorization && !looksSecret(header)) continue;
      if (/^\$\{env:[^}]+\}$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) continue;
      if (auth) continue; // one credential header becomes the auth mode; others stay as written
      delete headers[header];
      if (/\$\{input:[^}]+\}/.test(value)) {
        missingSecrets.push(header);
        auth = isAuthorization ? { mode: "bearer" } : { mode: "header", headerName: header };
        continue;
      }
      if (isAuthorization && /^bearer\s+/i.test(value)) {
        auth = { mode: "bearer" };
        secrets.push({ kind: "token", value: value.replace(/^bearer\s+/i, "").trim() });
      } else {
        auth = { mode: "header", headerName: header };
        secrets.push({ kind: "token", value });
      }
    }
    entry.headers = Object.keys(headers).length ? headers : undefined;
    if (auth) entry.auth = auth;
  }

  return { name, source, entry, secrets, missingSecrets };
}

/** Every server in one file. A missing or unreadable file yields nothing; a malformed one is
 *  reported so the picker can say why a file it knows about contributed no servers. */
export function readImportSource(source: ImportSource, readFile: (file: string) => string | undefined): { candidates: ImportCandidate[]; error?: string } {
  const text = readFile(source.file);
  if (text === undefined) return { candidates: [] };
  let parsed: unknown;
  try { parsed = parseJsonc(text); } catch (error) {
    return { candidates: [], error: `${source.label}: ${path.basename(source.file)} is not valid JSON (${error instanceof Error ? error.message : String(error)}).` };
  }
  const candidates: ImportCandidate[] = [];
  for (const map of serverMaps(parsed, source)) {
    for (const [name, raw] of Object.entries(map.servers)) {
      const candidate = candidateFrom(name, raw, map.label);
      if (candidate) candidates.push(candidate);
    }
  }
  return { candidates };
}
