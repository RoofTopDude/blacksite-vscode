/* Pure MCP wire-protocol helpers — no sockets, no processes, no fetch.
 *
 * The transports in mcp-client.ts differ in how bytes move (a child process' stdio, a POST
 * that answers with JSON, a POST that answers with an event stream) but agree on everything
 * above that line: JSON-RPC framing, the initialize handshake, version negotiation, cursor
 * pagination, and which tools this client is allowed to see. Keeping that layer here means it
 * is testable without a server, and means a bug fixed for one transport is fixed for all. */

// ── Protocol versions ─────────────────────────────────────────────────────────

/** The newest stateless revision this client can speak. Modern revisions are selected with
 *  `server/discover`; they must never be offered through the legacy initialize handshake. */
export const LATEST_PROTOCOL_VERSION = "2026-07-28";

/** The newest revision that still uses `initialize` / `notifications/initialized`. */
export const LATEST_HANDSHAKE_PROTOCOL_VERSION = "2025-11-25";

/** Revisions we know how to speak, newest first. A server that answers with one of these is
 *  fully supported; see {@link negotiateProtocolVersion} for anything else. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05",
] as const;

/**
 * Resolve the version to use for the rest of the session.
 *
 * The spec says a client SHOULD disconnect when the server names a revision it does not
 * support. We deliberately do not: MCP servers in the wild echo draft revisions, vendor
 * forks, and (frequently) whatever string the client sent regardless of what they implement.
 * Refusing those would fail servers that work fine in practice, so an unknown revision is
 * carried forward as-is and reported through `known: false` for the UI to surface.
 */
export function negotiateProtocolVersion(serverVersion: unknown): { version: string; known: boolean } {
  const raw = typeof serverVersion === "string" ? serverVersion.trim() : "";
  if (!raw) return { version: LATEST_PROTOCOL_VERSION, known: false };
  return { version: raw, known: (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(raw) };
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseMessage {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function buildRequest(id: number | string, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export function buildNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

/** True for a response/error frame carrying the given id. Ids are compared loosely because
 *  a handful of servers round-trip numeric ids as strings. */
export function isResponseFor(message: unknown, id: number | string): message is JsonRpcResponseMessage {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  if (!("result" in m) && !("error" in m)) return false;
  return String(m["id"]) === String(id);
}

/** Server→client *request* (has both `method` and `id`) — these need an answer or the server
 *  can block waiting for one. See mcp-client's answerServerRequest. */
export function isServerRequest(message: unknown): message is JsonRpcRequest {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return typeof m["method"] === "string" && m["id"] !== undefined && m["id"] !== null;
}

export function describeRpcError(error: { code?: number; message?: string } | undefined, fallback: string): string {
  if (!error) return fallback;
  const code = typeof error.code === "number" ? error.code : -32000;
  return `MCP error ${code}: ${error.message ?? fallback}`;
}

// ── Initialize handshake ──────────────────────────────────────────────────────

export interface McpClientIdentity {
  name: string;
  version: string;
  title?: string;
}

export interface McpServerIdentity {
  name?: string;
  version?: string;
  title?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  protocolVersionKnown: boolean;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerIdentity;
  instructions?: string;
}

export const DEFAULT_CLIENT_IDENTITY: McpClientIdentity = {
  name: "blacksite-vscode",
  version: "1.0.0",
  title: "Blacksite",
};

/**
 * `initialize` params.
 *
 * Only `roots` is advertised, and only because mcp-client genuinely answers `roots/list`
 * with the workspace directories. Claiming `sampling` or `elicitation` would be worse than
 * claiming nothing: a server that sees them will hand a tool call off to a capability we
 * would then have to decline mid-flight, whereas an unadvertised capability is simply routed
 * around before the call starts.
 */
export function buildInitializeParams(
  client: McpClientIdentity = DEFAULT_CLIENT_IDENTITY,
  protocolVersion: string = LATEST_HANDSHAKE_PROTOCOL_VERSION,
): Record<string, unknown> {
  return {
    protocolVersion,
    capabilities: {
      roots: { listChanged: false },
    },
    clientInfo: client,
  };
}

/** Per-request metadata required by the stateless 2026 protocol era. Blacksite deliberately
 *  advertises no optional client capabilities here: roots, sampling, and elicitation would
 *  allow a server to pause a tool call for an interaction this client does not implement. */
export function withModernRequestMeta(
  params: unknown,
  client: McpClientIdentity = DEFAULT_CLIENT_IDENTITY,
  protocolVersion: string = LATEST_PROTOCOL_VERSION,
): Record<string, unknown> {
  const base = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  const existingMeta = base["_meta"] && typeof base["_meta"] === "object"
    ? base["_meta"] as Record<string, unknown>
    : {};
  return {
    ...base,
    _meta: {
      ...existingMeta,
      "io.modelcontextprotocol/protocolVersion": protocolVersion,
      "io.modelcontextprotocol/clientInfo": client,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

/** Normalize `server/discover` into the same summary shape used by handshake-era connections. */
export function parseDiscoverResult(result: unknown): McpInitializeResult {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const versions = Array.isArray(r["supportedVersions"])
    ? (r["supportedVersions"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const version = versions.find((candidate) => candidate === LATEST_PROTOCOL_VERSION);
  if (!version) throw new Error("Server discovery did not advertise a supported modern MCP revision.");
  const meta = r["_meta"] && typeof r["_meta"] === "object" ? r["_meta"] as Record<string, unknown> : {};
  const rawInfo = meta["io.modelcontextprotocol/serverInfo"];
  const info = rawInfo && typeof rawInfo === "object" ? rawInfo as Record<string, unknown> : {};
  return {
    protocolVersion: version,
    protocolVersionKnown: true,
    capabilities: r["capabilities"] && typeof r["capabilities"] === "object"
      ? r["capabilities"] as Record<string, unknown>
      : {},
    serverInfo: {
      name: typeof info["name"] === "string" ? info["name"] : undefined,
      version: typeof info["version"] === "string" ? info["version"] : undefined,
      title: typeof info["title"] === "string" ? info["title"] : undefined,
    },
    instructions: typeof r["instructions"] === "string" ? r["instructions"] : undefined,
  };
}

export function parseInitializeResult(result: unknown): McpInitializeResult {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const negotiated = typeof r["protocolVersion"] === "string" && r["protocolVersion"].trim()
    ? negotiateProtocolVersion(r["protocolVersion"])
    : { version: LATEST_HANDSHAKE_PROTOCOL_VERSION, known: false };
  const info = (r["serverInfo"] && typeof r["serverInfo"] === "object" ? r["serverInfo"] : {}) as Record<string, unknown>;
  return {
    protocolVersion: negotiated.version,
    protocolVersionKnown: negotiated.known,
    capabilities: (r["capabilities"] && typeof r["capabilities"] === "object" ? r["capabilities"] : {}) as Record<string, unknown>,
    serverInfo: {
      name: typeof info["name"] === "string" ? info["name"] : undefined,
      version: typeof info["version"] === "string" ? info["version"] : undefined,
      title: typeof info["title"] === "string" ? info["title"] : undefined,
    },
    instructions: typeof r["instructions"] === "string" ? r["instructions"] : undefined,
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Normalize one `tools/list` entry. `inputSchema` is the spec spelling; `input_schema`
 *  appears in servers ported from OpenAI-style function definitions and costs nothing to
 *  accept. Entries without a usable name are dropped — they cannot be called anyway. */
export function normalizeToolDescriptor(raw: unknown): McpToolDescriptor | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const name = typeof t["name"] === "string" ? t["name"].trim() : "";
  if (!name) return null;
  const schema = (t["inputSchema"] ?? t["input_schema"]) as Record<string, unknown> | undefined;
  const outputSchema = (t["outputSchema"] ?? t["output_schema"]) as Record<string, unknown> | undefined;
  return {
    name,
    title: typeof t["title"] === "string" ? t["title"] : undefined,
    description: typeof t["description"] === "string" ? t["description"] : undefined,
    inputSchema: schema && typeof schema === "object" ? schema : undefined,
    outputSchema: outputSchema && typeof outputSchema === "object" ? outputSchema : undefined,
    annotations: t["annotations"] && typeof t["annotations"] === "object" ? t["annotations"] as Record<string, unknown> : undefined,
  };
}

export function parseToolsPage(result: unknown): { tools: McpToolDescriptor[]; nextCursor?: string } {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const list = Array.isArray(r["tools"]) ? r["tools"] : [];
  const tools: McpToolDescriptor[] = [];
  for (const entry of list) {
    const tool = normalizeToolDescriptor(entry);
    if (tool) tools.push(tool);
  }
  const cursor = r["nextCursor"];
  return { tools, nextCursor: typeof cursor === "string" && cursor ? cursor : undefined };
}

// ── Tool visibility policy ────────────────────────────────────────────────────

/**
 * Which of a server's tools this workspace has admitted.
 *
 * The policy is resolved on the host from user settings and travels with the server
 * descriptor, which the model can neither read nor set (the `mcp_*` tool schemas expose only
 * `serverId`). Enforcement lives at the single choke point in mcp-client so listing and
 * calling can never disagree about what exists.
 */
export interface McpToolPolicy {
  /** Explicitly admitted tool names. */
  allow?: string[];
  /** Explicitly withheld tool names. Wins over `allow`. */
  deny?: string[];
  /** Verdict for a tool in neither list — i.e. one the server grew after the user last
   *  looked. Defaults to "allow" so a server upgrade does not silently break a working
   *  setup; the panel can flip it to "deny" for servers held to an explicit allowlist. */
  fallback?: "allow" | "deny";
}

export function isToolAllowed(name: string, policy: McpToolPolicy | undefined): boolean {
  if (!policy) return true;
  if (policy.deny?.includes(name)) return false;
  if (policy.allow?.includes(name)) return true;
  return (policy.fallback ?? "allow") === "allow";
}

/**
 * Drop withheld tools from a listing.
 *
 * Filtering — not annotating. A withheld tool leaves no name, no count, and no gap in the
 * result the model receives, because a tool the model can see is a tool it will argue for.
 * The user-facing inventory in the MCP panel reads the *unfiltered* listing through
 * discoverMcpTools() instead, so the person configuring the server still sees everything.
 */
export function filterToolsByPolicy(tools: McpToolDescriptor[], policy: McpToolPolicy | undefined): McpToolDescriptor[] {
  if (!policy) return tools;
  return tools.filter((tool) => isToolAllowed(tool.name, policy));
}

/**
 * The error a withheld tool answers with.
 *
 * Byte-identical to what the reference MCP server implementations return for a name they do
 * not have, so "disabled here" and "never existed" are indistinguishable from inside the
 * conversation. A message like "this tool is disabled" would instead tell the model the
 * capability is one permission prompt away and invite it to lobby the user for it.
 */
export function unknownToolError(name: string): { ok: false; error: string } {
  return { ok: false, error: `MCP error -32602: Unknown tool: ${name}` };
}

// ── Server-sent events ────────────────────────────────────────────────────────

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental SSE frame parser.
 *
 * Streaming, not whole-body: the Streamable HTTP transport keeps a response open while the
 * server works, and the legacy HTTP+SSE transport never closes its stream at all, so a parser
 * that needed the full body would hang on both. Chunk boundaries fall anywhere, including
 * mid-line and between a CR and its LF, which is why the line split runs against the retained
 * buffer rather than against each chunk.
 */
export class SseParser {
  private _buffer = "";
  private _event = "";
  private _data: string[] = [];
  private _id: string | undefined;

  /** Characters retained for an incomplete frame. This—not lifetime traffic—is the amount
   *  a long-lived event stream must bound to prevent an unframed response exhausting memory. */
  get bufferedLength(): number {
    return this._buffer.length + this._event.length + this._data.reduce((sum, line) => sum + line.length, 0);
  }

  push(chunk: string): SseEvent[] {
    this._buffer += chunk;
    const events: SseEvent[] = [];
    let index: number;
    while ((index = this._buffer.indexOf("\n")) !== -1) {
      const raw = this._buffer.slice(0, index);
      this._buffer = this._buffer.slice(index + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const completed = this._consumeLine(line);
      if (completed) events.push(completed);
    }
    return events;
  }

  /** Flush a trailing frame that a closing stream left without its blank-line terminator.
   *  Servers that end the response immediately after the final `data:` line are common
   *  enough that discarding it would lose real results. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this._buffer) {
      const line = this._buffer.endsWith("\r") ? this._buffer.slice(0, -1) : this._buffer;
      this._buffer = "";
      const completed = this._consumeLine(line);
      if (completed) events.push(completed);
    }
    const trailing = this._emit();
    if (trailing) events.push(trailing);
    return events;
  }

  private _consumeLine(line: string): SseEvent | null {
    if (line === "") return this._emit();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this._event = value;
    else if (field === "data") this._data.push(value);
    else if (field === "id") this._id = value;
    return null;
  }

  private _emit(): SseEvent | null {
    if (this._data.length === 0 && !this._event) return null;
    const event: SseEvent = { event: this._event || "message", data: this._data.join("\n"), id: this._id };
    this._event = "";
    this._data = [];
    return event;
  }
}

// ── Authentication challenges ─────────────────────────────────────────────────

export interface WwwAuthenticateChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parse a `WWW-Authenticate` header into its challenges.
 *
 * MCP's OAuth profile (RFC 9728) puts the discovery entry point in this header's
 * `resource_metadata` parameter, so a 401 is not a dead end — it is where the whole
 * authorization flow starts. Handles quoted values containing commas and spaces, which
 * `resource_metadata` URLs regularly do.
 */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthenticateChallenge[] {
  if (!header) return [];
  const challenges: WwwAuthenticateChallenge[] = [];
  let current: WwwAuthenticateChallenge | null = null;
  // Either `key="quoted, value"`, `key=token`, or a bare scheme name starting a challenge.
  const token = /([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))|([A-Za-z][A-Za-z0-9_.-]*)/g;
  for (const match of header.matchAll(token)) {
    const [, key, quoted, bare, scheme] = match;
    if (scheme) {
      current = { scheme: scheme.toLowerCase(), params: {} };
      challenges.push(current);
      continue;
    }
    if (!key) continue;
    if (!current) {
      current = { scheme: "bearer", params: {} };
      challenges.push(current);
    }
    current.params[key.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (bare ?? "");
  }
  return challenges;
}

/** The Bearer challenge's `resource_metadata`, when the server published one. */
export function resourceMetadataUrlFrom(header: string | null | undefined): string | undefined {
  for (const challenge of parseWwwAuthenticate(header)) {
    if (challenge.scheme !== "bearer") continue;
    const url = challenge.params["resource_metadata"];
    if (url) return url;
  }
  return undefined;
}
