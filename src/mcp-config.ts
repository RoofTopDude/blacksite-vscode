/* The shape of one configured MCP server, and the rules for reading one from wherever it was
 * written: Blacksite's own settings, workspace state, or a config file another MCP client wrote.
 *
 * Pure on purpose (no vscode import), so the parsing every entry passes through is testable on
 * its own. The registry decides where entries live; this file only decides what they mean.
 *
 * The de facto format every MCP README, Claude Desktop, Claude Code, Cursor and VS Code use is
 * `command` + `args` + an `env` object (or `url` + `headers`). The first version of this parser
 * accepted only a single command line and an array of {name, value} env entries, and silently
 * dropped `args`, `cwd` and an `env` object, so a server copied from its README launched as a
 * bare `npx` with no arguments and no credentials. Both spellings are accepted now. */

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

/** Where an entry is stored, which is also who can see it. */
export type McpServerScope = "user" | "workspace" | "plugin";

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
  /** stdio only: an explicit argument vector (`command` is then the bare executable). */
  args?: string[];
  /** stdio only: the working directory. Defaults to the workspace root. */
  cwd?: string;
  /** Run this server's tools that declare `readOnlyHint` without asking first. */
  autoApproveReadOnly?: boolean;
  /** Set on a server an Agent Plugin provides. Such entries are read-only here: enabling,
   *  editing and removing them is the plugin registry's decision (see setPluginSource). */
  pluginKey?: string;
  /** Derived when listing, never stored: "user" entries are in user settings and appear in
   *  every project, "workspace" entries only in the project that added them. */
  scope?: McpServerScope;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return Object.keys(out).length ? out : undefined;
}

/** `env` as either `[{ name, value, secret }]` (Blacksite) or `{ NAME: "value" }` (everyone else). */
export function normalizeEnv(raw: unknown): McpEnvVar[] | undefined {
  if (Array.isArray(raw)) {
    const vars = raw
      .map((v) => (v && typeof v === "object" ? v as Record<string, unknown> : null))
      .filter((v): v is Record<string, unknown> => !!v && typeof v["name"] === "string" && !!v["name"])
      .map((v) => ({
        name: String(v["name"]),
        ...(typeof v["value"] === "string" ? { value: v["value"] } : {}),
        ...(v["secret"] === true ? { secret: true } : {}),
      }));
    return vars.length ? vars : undefined;
  }
  const record = stringRecord(raw);
  return record ? Object.entries(record).map(([name, value]) => ({ name, value })) : undefined;
}

/** The transport another client's `type` field means. */
function transportFromType(type: unknown): { transport?: "stdio" | "http"; hint?: "http" | "sse" } {
  const t = typeof type === "string" ? type.toLowerCase().replace(/[^a-z]/g, "") : "";
  if (t === "stdio" || t === "local") return { transport: "stdio" };
  if (t === "sse") return { transport: "http", hint: "sse" };
  if (t === "http" || t === "streamablehttp" || t === "remote") return { transport: "http" };
  return {};
}

export function normalizeEntry(raw: unknown, fallbackId?: string): McpServerEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e["id"] === "string" && e["id"] ? e["id"] : fallbackId ?? "";
  if (!id) return null;
  const command = typeof e["command"] === "string" ? e["command"] : undefined;
  const url = typeof e["url"] === "string" ? e["url"] : typeof e["serverUrl"] === "string" ? e["serverUrl"] : undefined;
  const fromType = transportFromType(e["type"]);
  const transport: "stdio" | "http" = e["transport"] === "stdio" || e["transport"] === "http"
    ? e["transport"]
    : fromType.transport ?? (command && !url ? "stdio" : "http");
  const auth = e["auth"] && typeof e["auth"] === "object" ? e["auth"] as McpAuthConfig : undefined;
  const args = Array.isArray(e["args"]) ? (e["args"] as unknown[]).filter((a) => typeof a === "string" || typeof a === "number").map(String) : undefined;
  const hint = e["transportHint"] === "http" || e["transportHint"] === "sse" ? e["transportHint"] : fromType.hint;
  return {
    id,
    name: typeof e["name"] === "string" && e["name"] ? e["name"] : id,
    transport,
    command,
    url,
    enabled: e["enabled"] !== false && e["disabled"] !== true,
    auth: auth ? { ...auth, mode: auth.mode ?? "none" } : undefined,
    env: normalizeEnv(e["env"]),
    headers: stringRecord(e["headers"]),
    transportHint: hint,
    ...(args?.length ? { args } : {}),
    ...(typeof e["cwd"] === "string" && e["cwd"] ? { cwd: e["cwd"] } : {}),
    ...(e["autoApproveReadOnly"] === true ? { autoApproveReadOnly: true } : {}),
  };
}

/** The stored form: derived and plugin-only fields removed, empty fields left out. `env` keeps
 *  the compact object form people write by hand unless a variable is a secret. */
export function serializeEntry(entry: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: entry.id, name: entry.name, transport: entry.transport };
  if (entry.transport === "stdio") {
    if (entry.command) out["command"] = entry.command;
    if (entry.args?.length) out["args"] = [...entry.args];
    if (entry.cwd) out["cwd"] = entry.cwd;
    if (entry.env?.length) {
      out["env"] = entry.env.some((v) => v.secret || v.value === undefined)
        ? entry.env.map((v) => ({ name: v.name, ...(v.value !== undefined ? { value: v.value } : {}), ...(v.secret ? { secret: true } : {}) }))
        : Object.fromEntries(entry.env.map((v) => [v.name, v.value ?? ""]));
    }
  } else {
    if (entry.url) out["url"] = entry.url;
    if (entry.transportHint && entry.transportHint !== "auto") out["transportHint"] = entry.transportHint;
    if (entry.auth && entry.auth.mode !== "none") out["auth"] = { ...entry.auth };
  }
  if (entry.headers && Object.keys(entry.headers).length) out["headers"] = { ...entry.headers };
  out["enabled"] = entry.enabled;
  if (entry.autoApproveReadOnly) out["autoApproveReadOnly"] = true;
  return out;
}

/** The launch target: the URL, or the command with its arguments, for display and dedupe. */
export function entryTarget(entry: Pick<McpServerEntry, "transport" | "url" | "command" | "args">): string {
  if (entry.transport === "http") return (entry.url ?? "").trim();
  const command = (entry.command ?? "").trim();
  if (!entry.args?.length) return command;
  return [command, ...entry.args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

export interface ExpansionContext {
  env: Record<string, string | undefined>;
  workspaceFolder?: string;
  userHome?: string;
}

/**
 * Expand the variables other clients' config files use: `${env:NAME}` (VS Code), `${NAME}` and
 * `${NAME:-default}` (Claude Code), `${workspaceFolder}` and `${userHome}`. An unset variable
 * becomes empty (or its default). `${input:…}` is left alone: it names a prompt another client
 * would have shown, and the import turns those into secrets to fill in.
 */
export function expandVariables(value: string, context: ExpansionContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, body: string) => {
    if (body === "workspaceFolder") return context.workspaceFolder ?? match;
    if (body === "userHome") return context.userHome ?? match;
    if (body.startsWith("input:")) return match;
    const name = body.startsWith("env:") ? body.slice(4) : body;
    const [variable, fallback] = name.split(":-", 2) as [string, string | undefined];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) return match;
    const resolved = context.env[variable];
    return resolved !== undefined && resolved !== "" ? resolved : fallback ?? "";
  });
}

/** Parse JSON that may carry comments and trailing commas, as VS Code's mcp.json does. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") { out += next ?? ""; i++; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; out += char; continue; }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  // Second pass, also string-aware: drop a comma whose next non-space character closes a bracket.
  let clean = "";
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const char = out[i]!;
    if (inString) {
      clean += char;
      if (char === "\\") { clean += out[i + 1] ?? ""; i++; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    if (char === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j]!)) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    clean += char;
  }
  return JSON.parse(clean.replace(/^\uFEFF/, ""));
}
