/**
 * Agent Plugins 1.0 (https://agent-plugins.org): load and validate one plugin folder.
 *
 * A plugin is a folder with a `plugin.json` manifest, an optional `skills/` folder of Agent Skills
 * and an optional `mcp.json` declaring MCP servers. This module applies the specification's rules
 * and nothing else — which folders are scanned, whether a plugin is enabled, and whether its MCP
 * servers may run are the registry's business (plugin-registry.ts). Pure apart from reading the
 * folder, so every rule is testable against a temporary directory.
 *
 * Rules implemented, with the specification's consequences:
 *  - plugin.json is a closed schema: unknown top-level fields warn; any other violation, or a
 *    manifest that resolves outside the plugin root, rejects the whole plugin.
 *  - Components live at fixed locations. A missing one is fine; one of the wrong kind or escaping
 *    the root disables that component only.
 *  - mcp.json must carry the matching 1.0.0 schema id, or MCP is disabled. Each server is checked
 *    on its own and an invalid one is skipped, never failing the plugin.
 *  - `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand once, non-recursively, in args, env values and
 *    cwd — never in command, env keys, url or headers.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export const PLUGIN_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const KNOWN_MANIFEST_FIELDS = new Set([
  "$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions",
]);

/** 1–64 characters, lowercase alphanumerics with hyphens or periods, starting and ending
 *  alphanumeric, with no `--` or `..`. */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

export type PluginMcpServer =
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { name: string; type: "streamable-http" | "sse"; url: string; headers: Record<string, string> };

export interface LoadedPlugin {
  /** Filesystem-resolved plugin root. */
  root: string;
  manifest: PluginManifest;
  /** The skills folder, when present and valid. */
  skillsDir?: string;
  mcpServers: PluginMcpServer[];
  /** Hash of mcp.json as read — what a user's trust in its servers is pinned to. */
  mcpHash?: string;
  warnings: string[];
}

export type PluginLoadResult = { ok: true; plugin: LoadedPlugin } | { ok: false; error: string };

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrNull(target: string): string | null {
  try { return fs.realpathSync(target); } catch { return null; }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateManifest(raw: unknown, warnings: string[]): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "plugin.json must contain a JSON object." };
  const value = raw as Record<string, unknown>;
  if (value["$schema"] !== PLUGIN_SCHEMA_ID) {
    return { ok: false, error: `plugin.json must declare "$schema": "${PLUGIN_SCHEMA_ID}" (Agent Plugins 1.0).` };
  }
  const name = value["name"];
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.includes("--") || name.includes("..")) {
    return { ok: false, error: "plugin.json \"name\" must be 1–64 lowercase letters, digits, hyphens or periods, starting and ending with a letter or digit." };
  }
  const manifest: PluginManifest = { name };
  const optionalString = (field: "version" | "description" | "homepage" | "repository" | "license"): string | null => {
    if (value[field] === undefined) return null;
    if (typeof value[field] !== "string") throw new Error(`plugin.json "${field}" must be a string.`);
    return value[field] as string;
  };
  try {
    for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
      const text = optionalString(field);
      if (text !== null) manifest[field] = text;
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (value["author"] !== undefined) {
    const author = value["author"];
    if (!author || typeof author !== "object" || Array.isArray(author)
      || !Object.entries(author as Record<string, unknown>).every(([key, entry]) => ["name", "email", "url"].includes(key) && typeof entry === "string")) {
      return { ok: false, error: "plugin.json \"author\" must be an object with string name, email and url fields." };
    }
    manifest.author = author as PluginManifest["author"];
  }
  if (value["keywords"] !== undefined) {
    if (!Array.isArray(value["keywords"]) || !value["keywords"].every((keyword) => typeof keyword === "string")) {
      return { ok: false, error: "plugin.json \"keywords\" must be an array of strings." };
    }
    manifest.keywords = value["keywords"] as string[];
  }
  if (value["extensions"] !== undefined && (typeof value["extensions"] !== "object" || value["extensions"] === null || Array.isArray(value["extensions"]))) {
    warnings.push("plugin.json \"extensions\" is not an object and was ignored.");
  }
  for (const field of Object.keys(value)) {
    if (!KNOWN_MANIFEST_FIELDS.has(field)) warnings.push(`plugin.json field "${field}" is not part of Agent Plugins 1.0 and was ignored.`);
  }
  return { ok: true, manifest };
}

function validateServer(name: string, raw: unknown, root: string): { server?: PluginMcpServer; problem?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "is not an object" };
  const value = raw as Record<string, unknown>;
  const type = value["type"];
  if (type === "stdio") {
    const command = value["command"];
    if (typeof command !== "string" || !command.trim() || /\s/.test(command.trim())) {
      return { problem: "stdio \"command\" must be one token (no spaces or shell syntax)" };
    }
    const trimmed = command.trim();
    const relative = trimmed.startsWith("./");
    if (!relative && /[\\/]/.test(trimmed)) return { problem: "stdio \"command\" must be a bare name or a ./-relative path" };
    if (relative) {
      const resolved = path.resolve(root, trimmed);
      const real = realpathOrNull(resolved);
      if (!within(root, resolved) || (real && !within(root, real))) return { problem: "stdio \"command\" resolves outside the plugin" };
    }
    if (value["args"] !== undefined && (!Array.isArray(value["args"]) || !value["args"].every((arg) => typeof arg === "string"))) {
      return { problem: "\"args\" must be an array of strings" };
    }
    if (value["env"] !== undefined && !isStringRecord(value["env"])) return { problem: "\"env\" must map names to strings" };
    const env = (value["env"] ?? {}) as Record<string, string>;
    if (Object.keys(env).some((key) => ["plugin_root", "plugin_data"].includes(key.toLowerCase()))) {
      return { problem: "\"env\" may not set PLUGIN_ROOT or PLUGIN_DATA (the client supplies them)" };
    }
    const cwd = value["cwd"];
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || !(cwd.startsWith("./") || cwd.startsWith("${PLUGIN_ROOT}") || cwd.startsWith("${PLUGIN_DATA}"))) {
        return { problem: "\"cwd\" must be ./-relative or start with ${PLUGIN_ROOT} or ${PLUGIN_DATA}" };
      }
      if (cwd.startsWith("./") && !within(root, path.resolve(root, cwd))) return { problem: "\"cwd\" resolves outside the plugin" };
    }
    return {
      server: {
        name, type: "stdio", command: trimmed,
        args: (value["args"] as string[] | undefined) ?? [], env, ...(typeof cwd === "string" ? { cwd } : {}),
      },
    };
  }
  if (type === "streamable-http" || type === "sse") {
    const url = value["url"];
    if (typeof url !== "string" || url.includes("${")) return { problem: "\"url\" must be an absolute URL without placeholders" };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { problem: "\"url\" is not a valid absolute URL" }; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { problem: "\"url\" must be http(s)" };
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) return { problem: "\"url\" must use HTTPS unless it is a loopback address" };
    if (parsed.hash || parsed.username || parsed.password) return { problem: "\"url\" may not contain a fragment or credentials" };
    if (value["headers"] !== undefined && !isStringRecord(value["headers"])) return { problem: "\"headers\" must map names to strings" };
    const headers = (value["headers"] ?? {}) as Record<string, string>;
    const lowered = Object.keys(headers).map((key) => key.toLowerCase());
    if (new Set(lowered).size !== lowered.length) return { problem: "\"headers\" repeats a header name" };
    if (Object.values(headers).some((header) => header.includes("${"))) return { problem: "\"headers\" may not contain placeholders" };
    return { server: { name, type, url, headers } };
  }
  return { problem: `has unsupported type "${String(type)}" (expected stdio, streamable-http or sse)` };
}

function loadMcp(root: string, warnings: string[]): { servers: PluginMcpServer[]; hash?: string } {
  const file = path.join(root, "mcp.json");
  if (!fs.existsSync(file)) return { servers: [] };
  const real = realpathOrNull(file);
  if (!real || !within(root, real) || !fs.statSync(real).isFile()) {
    warnings.push("mcp.json is not a file inside the plugin; MCP servers are disabled.");
    return { servers: [] };
  }
  let text: string;
  let raw: unknown;
  try {
    text = fs.readFileSync(real, "utf8");
    raw = JSON.parse(text);
  } catch {
    warnings.push("mcp.json is not valid JSON; MCP servers are disabled.");
    return { servers: [] };
  }
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || value["$schema"] !== MCP_SCHEMA_ID) {
    warnings.push(`mcp.json must declare "$schema": "${MCP_SCHEMA_ID}"; MCP servers are disabled.`);
    return { servers: [] };
  }
  const servers = value["mcpServers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    warnings.push("mcp.json has no \"mcpServers\" object; MCP servers are disabled.");
    return { servers: [] };
  }
  const out: PluginMcpServer[] = [];
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    const checked = validateServer(name, entry, root);
    if (checked.server) out.push(checked.server);
    else warnings.push(`MCP server "${name}" was skipped: it ${checked.problem}.`);
  }
  return { servers: out, hash: createHash("sha256").update(text).digest("hex") };
}

export function loadPlugin(dir: string): PluginLoadResult {
  const root = realpathOrNull(dir);
  if (!root) return { ok: false, error: "The plugin folder does not exist." };
  const manifestPath = path.join(root, "plugin.json");
  const manifestReal = realpathOrNull(manifestPath);
  if (!manifestReal) return { ok: false, error: "No plugin.json in the folder." };
  if (!within(root, manifestReal)) return { ok: false, error: "plugin.json resolves outside the plugin folder." };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(manifestReal, "utf8")); } catch { return { ok: false, error: "plugin.json is not valid JSON." }; }
  const warnings: string[] = [];
  const validated = validateManifest(raw, warnings);
  if (!validated.ok) return validated;

  let skillsDir: string | undefined;
  const skillsPath = path.join(root, "skills");
  if (fs.existsSync(skillsPath)) {
    const real = realpathOrNull(skillsPath);
    if (!real || !within(root, real)) warnings.push("skills/ resolves outside the plugin; its skills are disabled.");
    else if (!fs.statSync(real).isDirectory()) warnings.push("skills is not a folder; its skills are disabled.");
    else skillsDir = real;
  }
  const mcp = loadMcp(root, warnings);
  return {
    ok: true,
    plugin: { root, manifest: validated.manifest, ...(skillsDir ? { skillsDir } : {}), mcpServers: mcp.servers, ...(mcp.hash ? { mcpHash: mcp.hash } : {}), warnings },
  };
}

/** Single, non-recursive replacement of the two client placeholders. */
export function expandPluginPlaceholders(value: string, pluginRoot: string, pluginData: string): string {
  return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_match, name: string) => name === "PLUGIN_ROOT" ? pluginRoot : pluginData);
}
