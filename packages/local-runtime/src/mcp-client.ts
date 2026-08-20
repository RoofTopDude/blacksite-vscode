/* MCP client: session-oriented transports over the pure protocol layer in mcp-protocol.ts.
 *
 * The previous implementation sent a bare `tools/list` and hoped. That works against toy
 * servers and fails against most real ones, because MCP is a *stateful* protocol: a server
 * may reject every request that arrives before `initialize`, and a Streamable HTTP server
 * hands out an `Mcp-Session-Id` on that handshake which every later request has to carry.
 * Spawning a fresh stdio process per call had the same problem plus the startup cost.
 *
 * So connections are real objects here, cached per server and reused across calls:
 *
 *   stdio            one long-lived child process, newline-delimited JSON-RPC both ways
 *   streamable HTTP  POST per request; answers arrive as JSON or as an SSE stream (2025-03-26+)
 *   legacy HTTP+SSE  a held-open GET stream plus POSTs to the endpoint it names (2024-11-05)
 *
 * Transport selection probes rather than trusts configuration: a URL is tried as Streamable
 * HTTP first and falls back to the legacy pair when the server answers the way a legacy
 * server does. Users should not have to know which revision their server implements.
 *
 * Every path funnels through listMcpTools/callMcpTool, which is also where the tool policy is
 * enforced — see filterToolsByPolicy in mcp-protocol.ts for why that single choke point
 * matters. */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import type { McpServer } from "./types.js";
import { planSpawn } from "./security.js";
import {
  DEFAULT_CLIENT_IDENTITY, LATEST_PROTOCOL_VERSION, SseParser,
  buildInitializeParams, buildNotification, buildRequest, describeRpcError,
  filterToolsByPolicy, isResponseFor, isServerRequest, isToolAllowed,
  parseInitializeResult, parseToolsPage, resourceMetadataUrlFrom, unknownToolError,
  type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponseMessage,
  type McpInitializeResult, type McpToolDescriptor,
} from "./mcp-protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;
const MAX_MCP_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Connections idle this long are closed: an stdio server is a live child process, and
 *  holding one open for a server the user touched once an hour ago is pure cost. */
const IDLE_CONNECTION_MS = 5 * 60_000;
/** tools/list is cursor-paginated. Bounded so a server whose cursor never terminates
 *  cannot spin here forever. */
const MAX_TOOL_PAGES = 50;
/** Inline base64 payloads are replaced past this size — see redactLargeBlobs. */
const MAX_INLINE_BLOB_CHARS = 8 * 1024;

// ── Errors ────────────────────────────────────────────────────────────────────

/** A 401 from an MCP endpoint. Carries the RFC 9728 discovery pointer so the host can start
 *  the OAuth flow instead of reporting a dead end. */
export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly resourceMetadataUrl?: string,
    readonly wwwAuthenticate?: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

/** Raised when a Streamable HTTP server refuses the POST in the specific ways a legacy
 *  HTTP+SSE server does, so the caller knows to retry on the older transport. */
class TransportMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportMismatchError";
  }
}

// ── Shared plumbing ───────────────────────────────────────────────────────────

interface Pending {
  resolve: (value: JsonRpcResponseMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type OutgoingMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponseMessage;

interface McpConnection {
  readonly info: McpInitializeResult;
  readonly alive: boolean;
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  close(): void;
}

interface NormalizedServer {
  target: string;
  isHttp: boolean;
  apiKey: string;
  headers: Record<string, string>;
  env: Record<string, string>;
  cwd?: string;
  transport: "auto" | "http" | "sse" | "stdio";
  roots: string[];
  timeoutMs?: number;
}

function normalizeServer(server: McpServer): NormalizedServer {
  const target = typeof server.url === "string" ? server.url.trim() : "";
  return {
    target,
    isHttp: /^https?:\/\//i.test(target),
    apiKey: typeof server.apiKey === "string" ? server.apiKey.trim() : "",
    headers: server.headers && typeof server.headers === "object" ? server.headers : {},
    env: server.env && typeof server.env === "object" ? server.env : {},
    cwd: typeof server.cwd === "string" && server.cwd ? server.cwd : undefined,
    transport: server.transport ?? "auto",
    roots: Array.isArray(server.roots) ? server.roots.filter((r): r is string => typeof r === "string" && !!r) : [],
    timeoutMs: typeof server.timeoutMs === "number" && server.timeoutMs > 0 ? server.timeoutMs : undefined,
  };
}

/** Auth material is applied here and nowhere else, so there is exactly one place to audit for
 *  "could a credential reach a server it does not belong to". */
function buildHttpHeaders(server: NormalizedServer, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...server.headers };
  if (server.apiKey) headers["Authorization"] = `Bearer ${server.apiKey}`;
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json, text/event-stream";
  return { ...headers, ...extra };
}

function jsonParseOrNull(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** JSON-RPC allows a batch (array) frame; unwrap so callers only ever see single messages. */
function flattenFrames(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [parsed];
}

function resultOrThrow(response: JsonRpcResponseMessage, method: string): unknown {
  if (response.error) throw new Error(describeRpcError(response.error, `${method} failed`));
  return response.result;
}

/**
 * Answer a server→client request.
 *
 * Ignoring these is not neutral: a server that asks for roots and never hears back can block
 * its own tool call until our timeout fires. We implement `roots` and `ping` honestly and
 * decline everything else with the JSON-RPC "method not found" code, which servers treat as
 * "this client cannot do that" and route around.
 */
function answerServerRequest(request: JsonRpcRequest, roots: string[]): JsonRpcResponseMessage {
  if (request.method === "ping") {
    return { jsonrpc: "2.0", id: request.id, result: {} };
  }
  if (request.method === "roots/list") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        roots: roots.map((root) => ({
          uri: root.startsWith("file://") ? root : `file:///${root.replace(/\\/g, "/").replace(/^\/+/, "")}`,
          name: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
        })),
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: `Method not supported by this client: ${request.method}` },
  };
}

/** Tracks in-flight requests for the transports whose replies arrive out of band. */
class PendingRegistry {
  private readonly _pending = new Map<string, Pending>();

  add(id: number | string, timeoutMs: number, onTimeout: () => void): Promise<JsonRpcResponseMessage> {
    return new Promise<JsonRpcResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(String(id));
        onTimeout();
        reject(new Error(`MCP request timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this._pending.set(String(id), { resolve, reject, timer });
    });
  }

  settle(message: JsonRpcResponseMessage): boolean {
    const entry = this._pending.get(String(message.id));
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._pending.delete(String(message.id));
    entry.resolve(message);
    return true;
  }

  rejectAll(error: Error): void {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }
}

// ── stdio transport ───────────────────────────────────────────────────────────

function parseCommandLine(cmdString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < cmdString.length; i++) {
    const char = cmdString[i]!;
    if (inQuotes) {
      if (char === quoteChar) inQuotes = false;
      else current += char;
    } else {
      if (char === '"' || char === "'") { inQuotes = true; quoteChar = char; }
      else if (/\s/.test(char)) { if (current) { args.push(current); current = ""; } }
      else current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * One child process per configured server, held open across calls.
 *
 * Beyond the handshake requirement, this is what makes stdio servers usable at all: the
 * npx-launched servers most people configure take seconds to boot, which the old
 * spawn-per-call design paid on every single tool call.
 */
class StdioConnection implements McpConnection {
  private readonly _pending = new PendingRegistry();
  private _child: ChildProcessWithoutNullStreams | undefined;
  private _stdout = "";
  private _stderr = "";
  private _bytes = 0;
  private _alive = false;
  info!: McpInitializeResult;

  constructor(private readonly _server: NormalizedServer) {}

  get alive(): boolean { return this._alive; }

  async connect(): Promise<void> {
    const tokens = parseCommandLine(this._server.target);
    const command = tokens[0];
    if (!command) throw new Error("Missing MCP command.");
    const plan = planSpawn(command, tokens.slice(1));

    const child = spawn(plan.command, plan.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: plan.shell,
      cwd: this._server.cwd,
      // Inherit the ambient environment so servers find node/python and the user's PATH,
      // then layer the per-server variables (API keys, workspace ids) on top.
      env: { ...process.env, ...this._server.env },
    });
    this._child = child;
    this._alive = true;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Kept only as failure context — MCP stdio servers log freely to stderr while healthy.
      if (this._stderr.length < 4096) this._stderr += chunk.slice(0, 4096 - this._stderr.length);
    });
    child.on("error", (error) => this._die(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code) => this._die(new Error(
      `MCP server process exited (${code}).${this._stderr.trim() ? ` Stderr: ${this._stderr.trim().slice(0, 400)}` : ""}`,
    )));

    const raw = await this._request("initialize", buildInitializeParams(DEFAULT_CLIENT_IDENTITY), this._server.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.info = parseInitializeResult(raw);
    // Notification, not a request: nothing answers it, and skipping it leaves spec-strict
    // servers refusing every subsequent call as "not initialized".
    this._write(buildNotification("notifications/initialized"));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this._request(method, params, timeoutMs);
  }

  close(): void {
    this._alive = false;
    this._pending.rejectAll(new Error("MCP connection closed."));
    const child = this._child;
    this._child = undefined;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already gone */ }
    try { child.kill(); } catch { /* already gone */ }
  }

  private async _request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this._alive) throw new Error("MCP server process is not running.");
    const id = nextRequestId();
    const waiter = this._pending.add(id, timeoutMs, () => this.close());
    this._write(buildRequest(id, method, params));
    return resultOrThrow(await waiter, method);
  }

  private _write(message: OutgoingMessage): void {
    if (!this._child) return;
    try { this._child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* exit handler reports it */ }
  }

  private _onStdout(chunk: string): void {
    this._bytes += Buffer.byteLength(chunk, "utf8");
    if (this._bytes > MAX_MCP_RESPONSE_BYTES) {
      this._die(new Error("MCP process output exceeded the 10 MiB limit."));
      return;
    }
    this._stdout += chunk;
    let index: number;
    while ((index = this._stdout.indexOf("\n")) !== -1) {
      const line = this._stdout.slice(0, index).trim();
      this._stdout = this._stdout.slice(index + 1);
      if (!line) continue;
      const parsed = jsonParseOrNull(line);
      // Servers that print banners or logs to stdout are technically out of spec and common
      // in practice; a non-JSON line is skipped rather than treated as a protocol failure.
      if (parsed === null) continue;
      for (const frame of flattenFrames(parsed)) this._onMessage(frame);
    }
  }

  private _onMessage(message: unknown): void {
    if (isServerRequest(message)) {
      this._write(answerServerRequest(message, this._server.roots));
      return;
    }
    if (message && typeof message === "object" && ("result" in message || "error" in message)) {
      this._pending.settle(message as JsonRpcResponseMessage);
    }
  }

  private _die(error: Error): void {
    if (!this._alive && !this._child) return;
    this._alive = false;
    this._child = undefined;
    this._pending.rejectAll(error);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function readBodyBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("MCP response exceeded the 10 MiB limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response exceeded the 10 MiB limit.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
}

/** Turn a non-2xx into the most actionable error we can: a 401 becomes an McpAuthError
 *  carrying the discovery pointer, everything else keeps the server's own message. */
async function httpFailure(response: Response, context: string): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    const header = response.headers.get("www-authenticate");
    const detail = response.status === 401 ? "requires authorization" : "refused the credentials supplied";
    await response.body?.cancel().catch(() => undefined);
    return new McpAuthError(`The MCP server ${detail} (HTTP ${response.status}).`, resourceMetadataUrlFrom(header), header ?? undefined, response.status);
  }
  const text = await readBodyBounded(response).catch(() => "");
  const parsed = jsonParseOrNull(text) as { error?: { message?: string } } | null;
  const message = parsed?.error?.message ?? text.slice(0, 300);
  return new Error(`${context} failed with HTTP ${response.status}${message ? `: ${message}` : ""}`);
}

// ── Streamable HTTP transport (2025-03-26 and later) ──────────────────────────

class StreamableHttpConnection implements McpConnection {
  private _sessionId: string | undefined;
  private _protocolVersion = LATEST_PROTOCOL_VERSION;
  private _alive = false;
  private readonly _endpoint: string;
  info!: McpInitializeResult;

  constructor(private readonly _server: NormalizedServer) {
    this._endpoint = _server.target.replace(/\/+$/, "");
  }

  get alive(): boolean { return this._alive; }
  get sessionId(): string | undefined { return this._sessionId; }

  async connect(): Promise<void> {
    const raw = await this._exchange("initialize", buildInitializeParams(DEFAULT_CLIENT_IDENTITY), this._server.timeoutMs ?? DEFAULT_TIMEOUT_MS, true);
    this.info = parseInitializeResult(raw);
    this._protocolVersion = this.info.protocolVersion;
    this._alive = true;
    // Best effort: a server that rejects the notification still works for requests, and
    // failing the connection over it would be worse than the mild spec deviation.
    await this._post(buildNotification("notifications/initialized"), DEFAULT_TIMEOUT_MS)
      .then((response) => response.body?.cancel().catch(() => undefined))
      .catch(() => undefined);
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this._exchange(method, params, timeoutMs, false, signal);
  }

  close(): void {
    if (!this._alive) return;
    this._alive = false;
    const sessionId = this._sessionId;
    this._sessionId = undefined;
    // Explicit teardown so the server can release the session; failure is unremarkable
    // (the spec makes DELETE optional and many servers answer 405).
    if (!sessionId) return;
    void fetch(this._endpoint, {
      method: "DELETE",
      headers: buildHttpHeaders(this._server, { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": this._protocolVersion }),
    }).then((response) => response.body?.cancel().catch(() => undefined)).catch(() => undefined);
  }

  private async _exchange(
    method: string,
    params: unknown,
    timeoutMs: number,
    isInitialize: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = nextRequestId();
    const response = await this._post(buildRequest(id, method, params), timeoutMs, signal);

    if (isInitialize) {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this._sessionId = sessionId;
    }

    if (response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      // Streamable HTTP allows 202 only for a POST that carried no request. Getting one for
      // a request means the server is acknowledging it and intends to answer somewhere else
      // — which is precisely how the legacy transport behaves, so treat it as a mismatch
      // rather than a dead end.
      if (isInitialize) throw new TransportMismatchError(`Server acknowledged ${method} without answering it.`);
      throw new Error(`${method} was accepted but produced no response.`);
    }
    if (!response.ok) {
      // A session the server has forgotten (restart, expiry) reads as 404 here. The pool
      // recreates the connection on the next call rather than surfacing a confusing error.
      if (response.status === 404 && this._sessionId) this._alive = false;
      if (isInitialize && (response.status === 404 || response.status === 405 || response.status === 501)) {
        await response.body?.cancel().catch(() => undefined);
        throw new TransportMismatchError(`Server does not accept Streamable HTTP POSTs (HTTP ${response.status}).`);
      }
      throw await httpFailure(response, method);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      return this._readFromStream(response, id, method);
    }

    const text = await readBodyBounded(response);
    const parsed = jsonParseOrNull(text);
    if (parsed === null) {
      if (isInitialize) throw new TransportMismatchError(`Server answered ${method} with a non-JSON body.`);
      throw new Error(`${method} returned a non-JSON response: ${text.slice(0, 200)}`);
    }
    for (const frame of flattenFrames(parsed)) {
      if (isResponseFor(frame, id)) return resultOrThrow(frame, method);
    }
    throw new Error(`${method} returned no matching response frame.`);
  }

  /** Read the POST's event stream until our response arrives, answering any server request
   *  that shows up on the way (those travel on the same stream). */
  private async _readFromStream(response: Response, id: number, method: string): Promise<unknown> {
    if (!response.body) throw new Error(`${method} returned an empty event stream.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const events = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
        if (!done) {
          received += value.byteLength;
          if (received > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response exceeded the 10 MiB limit.");
        }
        for (const event of events) {
          if (!event.data || event.data === "[DONE]") continue;
          const parsed = jsonParseOrNull(event.data);
          if (parsed === null) continue;
          for (const frame of flattenFrames(parsed)) {
            if (isResponseFor(frame, id)) return resultOrThrow(frame, method);
            if (isServerRequest(frame)) void this._answer(frame);
          }
        }
        if (done) break;
      }
      throw new Error(`${method} stream closed before a response arrived.`);
    } finally {
      try { await reader.cancel(); } catch { /* best effort */ }
    }
  }

  private async _answer(request: JsonRpcRequest): Promise<void> {
    await this._post(answerServerRequest(request, this._server.roots), DEFAULT_TIMEOUT_MS)
      .then((response) => response.body?.cancel().catch(() => undefined))
      .catch(() => undefined);
  }

  private async _post(message: OutgoingMessage, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const extra: Record<string, string> = {};
    if (this._sessionId) extra["Mcp-Session-Id"] = this._sessionId;
    // Required from 2025-06-18 on, and harmless to older servers, which ignore it.
    if (this._protocolVersion) extra["MCP-Protocol-Version"] = this._protocolVersion;
    try {
      return await fetch(this._endpoint, {
        method: "POST",
        headers: buildHttpHeaders(this._server, extra),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

// ── Legacy HTTP+SSE transport (2024-11-05) ────────────────────────────────────

/**
 * The original two-channel transport: a GET stream that stays open for every response, and
 * POSTs to whatever endpoint its first `endpoint` event names.
 *
 * Still worth carrying — a large share of deployed servers, including several hosted ones,
 * never moved off it, and to a user "my server does not work" is the same complaint either
 * way.
 */
class LegacySseConnection implements McpConnection {
  private readonly _pending = new PendingRegistry();
  private _postUrl: string | undefined;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private _controller: AbortController | undefined;
  private _alive = false;
  info!: McpInitializeResult;

  constructor(private readonly _server: NormalizedServer) {}

  get alive(): boolean { return this._alive; }

  async connect(): Promise<void> {
    const base = new URL(this._server.target);
    this._controller = new AbortController();
    const response = await fetch(this._server.target, {
      method: "GET",
      headers: { ...buildHttpHeaders(this._server), Accept: "text/event-stream" },
      signal: this._controller.signal,
    });
    if (!response.ok) throw await httpFailure(response, "SSE handshake");
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/event-stream") || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Server did not open an event stream.");
    }

    this._reader = response.body.getReader();
    const endpointReady = this._pump(base);
    // The race below is what reports a stream failure; this keeps the loser of that race
    // from surfacing as an unhandled rejection.
    endpointReady.catch(() => undefined);
    this._alive = true;

    // The POST endpoint has to arrive before anything can be sent, and a server that never
    // sends it is broken in a way worth reporting quickly rather than hanging on.
    let endpointTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      endpointTimer = setTimeout(() => reject(new Error("Server never announced its message endpoint.")), DEFAULT_TIMEOUT_MS);
    });
    timeout.catch(() => undefined);
    try {
      await Promise.race([endpointReady, timeout]);
    } finally {
      if (endpointTimer) clearTimeout(endpointTimer);
    }

    const raw = await this._request("initialize", buildInitializeParams(DEFAULT_CLIENT_IDENTITY), this._server.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.info = parseInitializeResult(raw);
    await this._send(buildNotification("notifications/initialized")).catch(() => undefined);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this._request(method, params, timeoutMs);
  }

  close(): void {
    this._alive = false;
    this._pending.rejectAll(new Error("MCP connection closed."));
    try { this._controller?.abort(); } catch { /* best effort */ }
    void this._reader?.cancel().catch(() => undefined);
    this._reader = undefined;
    this._controller = undefined;
  }

  private async _request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this._alive) throw new Error("MCP connection is closed.");
    const id = nextRequestId();
    const waiter = this._pending.add(id, timeoutMs, () => this.close());
    await this._send(buildRequest(id, method, params));
    return resultOrThrow(await waiter, method);
  }

  private async _send(message: OutgoingMessage): Promise<void> {
    if (!this._postUrl) throw new Error("MCP message endpoint is not available.");
    const response = await fetch(this._postUrl, {
      method: "POST",
      headers: buildHttpHeaders(this._server),
      body: JSON.stringify(message),
      signal: this._controller?.signal,
    });
    // 202 is the expected answer; the real reply comes back on the GET stream.
    if (!response.ok) throw await httpFailure(response, "MCP POST");
    await response.body?.cancel().catch(() => undefined);
  }

  /** Consume the event stream for the connection's lifetime. Resolves as soon as the POST
   *  endpoint is known; keeps running afterwards to route responses. */
  private _pump(base: URL): Promise<void> {
    return new Promise<void>((resolveEndpoint, rejectEndpoint) => {
      const parser = new SseParser();
      const decoder = new TextDecoder();
      let received = 0;
      const loop = async (): Promise<void> => {
        const reader = this._reader;
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          const events = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
          if (!done) {
            received += value.byteLength;
            if (received > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response exceeded the 10 MiB limit.");
          }
          for (const event of events) {
            if (event.event === "endpoint") {
              const endpoint = new URL(event.data.trim(), base);
              // A redirected message endpoint would send this connection's credentials to
              // another host; the same-origin check is what stops that.
              if (endpoint.origin !== base.origin) {
                rejectEndpoint(new Error(`MCP endpoint origin mismatch: ${endpoint.origin}`));
                return;
              }
              this._postUrl = endpoint.href;
              resolveEndpoint();
              continue;
            }
            if (!event.data || event.data === "[DONE]") continue;
            const parsed = jsonParseOrNull(event.data);
            if (parsed === null) continue;
            for (const frame of flattenFrames(parsed)) {
              if (isServerRequest(frame)) {
                void this._send(answerServerRequest(frame, this._server.roots)).catch(() => undefined);
              } else if (frame && typeof frame === "object" && ("result" in frame || "error" in frame)) {
                this._pending.settle(frame as JsonRpcResponseMessage);
              }
            }
          }
          if (done) break;
        }
        this._alive = false;
        this._pending.rejectAll(new Error("MCP event stream closed."));
      };
      loop().catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this._alive = false;
        this._pending.rejectAll(wrapped);
        rejectEndpoint(wrapped);
      });
    });
  }
}

// ── Connection pool ───────────────────────────────────────────────────────────

let requestCounter = 0;
function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

interface PoolEntry {
  connection: McpConnection;
  fingerprint: string;
  timer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, PoolEntry>();
/** Connections under construction, so two concurrent tool calls to a cold server share one
 *  handshake instead of racing to spawn two processes. */
const connecting = new Map<string, Promise<McpConnection>>();

/** Credentials and launch parameters are part of a connection's identity: when the user
 *  re-authorizes or edits an env var, the cached connection is stale and must be replaced
 *  rather than silently reused with the old token. */
function connectionFingerprint(server: NormalizedServer): string {
  return JSON.stringify([server.target, server.apiKey, server.headers, server.env, server.cwd, server.transport]);
}

function poolKey(server: McpServer, normalized: NormalizedServer): string {
  return server.id ? `id:${server.id}` : `target:${normalized.target}`;
}

function touch(key: string, entry: PoolEntry): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pool.delete(key);
    entry.connection.close();
  }, IDLE_CONNECTION_MS);
  // An idle sweep should never hold the host process alive on its own.
  (entry.timer as unknown as { unref?: () => void }).unref?.();
}

async function openConnection(server: NormalizedServer): Promise<McpConnection> {
  if (!server.isHttp) {
    const connection = new StdioConnection(server);
    // A handshake that fails after the spawn leaves a live child process behind unless the
    // failure path tears it down explicitly.
    try { await connection.connect(); } catch (error) { connection.close(); throw error; }
    return connection;
  }
  if (server.transport === "sse") {
    const legacy = new LegacySseConnection(server);
    try { await legacy.connect(); } catch (error) { legacy.close(); throw error; }
    return legacy;
  }

  const streamable = new StreamableHttpConnection(server);
  try {
    await streamable.connect();
    return streamable;
  } catch (error) {
    streamable.close();
    // An explicit transport choice is honoured, and an auth challenge means the transport was
    // right and the credentials were not — retrying on the legacy pair would only produce a
    // second, more confusing 401.
    if (server.transport === "http" || error instanceof McpAuthError) throw error;
    const retryable = error instanceof TransportMismatchError
      || (error instanceof Error && /HTTP (404|405|501)/.test(error.message));
    if (!retryable) throw error;
    const legacy = new LegacySseConnection(server);
    try {
      await legacy.connect();
      return legacy;
    } catch (legacyError) {
      legacy.close();
      // Report the Streamable HTTP failure: it is the transport the user's server almost
      // certainly meant to speak, so its error is the one worth acting on.
      throw legacyError instanceof McpAuthError ? legacyError : error;
    }
  }
}

async function acquire(server: McpServer): Promise<{ connection: McpConnection; normalized: NormalizedServer }> {
  const normalized = normalizeServer(server);
  if (!normalized.target) throw new Error("Missing MCP URL or command.");
  const key = poolKey(server, normalized);
  const fingerprint = connectionFingerprint(normalized);

  const existing = pool.get(key);
  if (existing) {
    if (existing.connection.alive && existing.fingerprint === fingerprint) {
      touch(key, existing);
      return { connection: existing.connection, normalized };
    }
    clearTimeout(existing.timer);
    pool.delete(key);
    existing.connection.close();
  }

  const inFlight = connecting.get(key);
  if (inFlight) {
    const shared = await inFlight;
    if (shared.alive) return { connection: shared, normalized };
  }

  const attempt = openConnection(normalized);
  connecting.set(key, attempt);
  try {
    const connection = await attempt;
    const entry: PoolEntry = { connection, fingerprint, timer: setTimeout(() => undefined, 0) };
    pool.set(key, entry);
    touch(key, entry);
    return { connection, normalized };
  } finally {
    connecting.delete(key);
  }
}

/** Drop a connection after a failure so the next call reconnects instead of reusing a
 *  half-dead session. */
function evict(server: McpServer): void {
  const normalized = normalizeServer(server);
  const key = poolKey(server, normalized);
  const entry = pool.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pool.delete(key);
  entry.connection.close();
}

/** Close every pooled connection — extension deactivation, and after settings changes that
 *  invalidate the whole set. */
export function closeMcpConnections(): void {
  for (const [, entry] of pool) {
    clearTimeout(entry.timer);
    entry.connection.close();
  }
  pool.clear();
}

// ── Result shaping ────────────────────────────────────────────────────────────

export interface McpFailure {
  ok: false;
  error: string;
  /** Set when the failure was a 401/403: the host uses it to start (or re-run) the OAuth
   *  flow rather than reporting an unrecoverable error. */
  authRequired?: boolean;
  authChallenge?: { resourceMetadataUrl?: string; wwwAuthenticate?: string; status: number };
}

function failure(error: unknown): McpFailure {
  if (error instanceof McpAuthError) {
    return {
      ok: false,
      error: error.message,
      authRequired: true,
      authChallenge: {
        resourceMetadataUrl: error.resourceMetadataUrl,
        wwwAuthenticate: error.wwwAuthenticate,
        status: error.status,
      },
    };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Replace oversized inline base64 with a description of what was there.
 *
 * A screenshot tool answering with a 3 MB data URL would otherwise land verbatim in the
 * conversation, costing an enormous number of tokens to convey nothing the model can read.
 * The surrounding structure is preserved so the model still learns an image came back.
 */
function redactLargeBlobs(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactLargeBlobs(entry, depth + 1));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if ((key === "data" || key === "blob") && typeof entry === "string" && entry.length > MAX_INLINE_BLOB_CHARS) {
      const kind = typeof source["mimeType"] === "string" ? source["mimeType"] : "binary";
      out[key] = `[${kind} payload omitted — ${Math.round(entry.length / 1024)} KB]`;
      continue;
    }
    out[key] = redactLargeBlobs(entry, depth + 1);
  }
  return out;
}

/** Flatten `content` blocks into the text an agent can actually reason over. */
function summarizeContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
    else if (b["type"] === "resource_link" && typeof b["uri"] === "string") parts.push(`[resource] ${b["uri"]}`);
    else if (typeof b["type"] === "string") parts.push(`[${b["type"]}]`);
  }
  return parts.join("\n").trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface McpServerSummary {
  name: string;
  version?: string;
  protocolVersion: string;
  /** False when the server named a protocol revision this client does not implement. It
   *  still works; the panel surfaces it so an odd failure has an explanation. */
  protocolSupported: boolean;
  capabilities: string[];
  instructions?: string;
}

export interface McpToolListResult {
  ok: true;
  server: McpServerSummary;
  tools: McpToolDescriptor[];
}

function summarize(info: McpInitializeResult): McpServerSummary {
  return {
    name: info.serverInfo.title || info.serverInfo.name || "MCP server",
    version: info.serverInfo.version,
    protocolVersion: info.protocolVersion,
    protocolSupported: info.protocolVersionKnown,
    capabilities: Object.keys(info.capabilities ?? {}),
    instructions: info.instructions,
  };
}

async function fetchAllTools(connection: McpConnection, timeoutMs: number): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const raw = await connection.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
    const parsed = parseToolsPage(raw);
    for (const tool of parsed.tools) {
      // A server that returns the same cursor twice would otherwise duplicate its catalog.
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
    if (!parsed.nextCursor || parsed.nextCursor === cursor) break;
    cursor = parsed.nextCursor;
  }
  return tools;
}

/**
 * The full, unfiltered inventory — for the MCP panel's tool list only.
 *
 * The person configuring a server has to see every tool it offers to decide which ones the
 * agent may have. This is deliberately a separate entry point from listMcpTools so that the
 * agent-facing path cannot reach an unfiltered listing by passing a flag.
 */
export async function discoverMcpTools(server: McpServer): Promise<McpToolListResult | McpFailure> {
  try {
    const { connection, normalized } = await acquire(server);
    const tools = await fetchAllTools(connection, normalized.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { ok: true, server: summarize(connection.info), tools };
  } catch (error) {
    evict(server);
    return failure(error);
  }
}

/** Handshake only — the panel's "test connection" affordance. */
export async function pingMcpServer(server: McpServer): Promise<{ ok: true; server: McpServerSummary } | McpFailure> {
  try {
    const { connection } = await acquire(server);
    return { ok: true, server: summarize(connection.info) };
  } catch (error) {
    evict(server);
    return failure(error);
  }
}

/** Agent-facing listing: withheld tools are absent, not marked. */
export async function listMcpTools(server: McpServer): Promise<McpToolListResult | McpFailure> {
  const discovered = await discoverMcpTools(server);
  if (!discovered.ok) return discovered;
  return { ...discovered, tools: filterToolsByPolicy(discovered.tools, server.toolPolicy) };
}

export interface McpToolCallResult {
  ok: boolean;
  error?: string;
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolCallResult | McpFailure> {
  // Checked before the connection is opened: a withheld tool must not produce so much as a
  // timing difference that distinguishes it from a name the server never had.
  if (!isToolAllowed(toolName, server.toolPolicy)) return unknownToolError(toolName);

  try {
    const { connection, normalized } = await acquire(server);
    const raw = await connection.request(
      "tools/call",
      { name: toolName, arguments: args },
      normalized.timeoutMs ?? TOOL_CALL_TIMEOUT_MS,
      signal,
    );
    const result = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const content = redactLargeBlobs(result["content"]);
    const isError = result["isError"] === true;
    const text = summarizeContent(content);
    if (isError) {
      return { ok: false, isError: true, error: text || "The MCP tool reported an error.", content };
    }
    return {
      ok: true,
      content,
      structuredContent: result["structuredContent"] !== undefined ? redactLargeBlobs(result["structuredContent"]) : undefined,
    };
  } catch (error) {
    evict(server);
    return failure(error);
  }
}
