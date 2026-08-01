import * as http from "http";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { DEFAULT_BRIDGE_PORT, BRIDGE_HOST, makeBridgeId } from "@blacksite/browser-bridge-protocol";
import type { AnyBridgeMessage, BridgeEnvelope } from "@blacksite/browser-bridge-protocol";
import { isBridgeRequestAuthorized } from "./browser-bridge-auth.js";
export { isBridgeRequestAuthorized } from "./browser-bridge-auth.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type BridgeToolHandler = (toolName: string, toolInput: Record<string, unknown>) => Promise<unknown>;
const MAX_BRIDGE_BODY_BYTES = 1024 * 1024;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject:  (err: Error)   => void;
  timer:   ReturnType<typeof setTimeout>;
}

// ── BrowserBridge ─────────────────────────────────────────────────────────────

export class BrowserBridge {
  private _server: http.Server | null = null;
  private _pending = new Map<string, PendingRequest>();
  private _toolHandler: BridgeToolHandler | null = null;
  private readonly _port: number;
  private readonly _token: string;
  private _connected = false;

  constructor(port: number = DEFAULT_BRIDGE_PORT, token = randomBytes(32).toString("base64url")) {
    this._port = port;
    this._token = token;
  }

  /** Set the handler for tool calls routed from the Chrome companion. */
  setToolHandler(handler: BridgeToolHandler): void {
    this._toolHandler = handler;
  }

  get isConnected(): boolean { return this._connected; }
  get port(): number         { return this._port; }
  /** Shared out-of-band with the companion extension; never written to logs or workspace state. */
  get authenticationToken(): string { return this._token; }

  start(): void {
    if (this._server) return;

    this._server = http.createServer((req, res) => {
      void this._handleRequest(req, res);
    });

    this._server.listen(this._port, BRIDGE_HOST, () => {
      console.log(`[Blacksite] Browser bridge listening on ${BRIDGE_HOST}:${this._port}`);
    });

    this._server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        vscode.window.showWarningMessage(
          `Blacksite: Port ${this._port} is already in use. Browser companion bridge will not start.`,
        );
      }
    });
  }

  stop(): void {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge stopped."));
    }
    this._pending.clear();
    this._server?.close();
    this._server = null;
    this._connected = false;
  }

  /** Dispatch a browser action to the Chrome companion and await the result. */
  async dispatch(msg: Omit<AnyBridgeMessage, "id">): Promise<unknown> {
    if (!this._connected) {
      throw new Error("No Chrome companion connected. Install the Blacksite Chrome extension and enable browser_companion trust mode.");
    }
    // The bridge uses request/response over HTTP — Chrome extension polls /pull
    // and we push results into /push. Here we just enqueue and wait.
    const id = makeBridgeId();
    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, {
        resolve, reject,
        timer: setTimeout(() => {
          this._pending.delete(id);
          reject(new Error(`Browser tool timed out after 30s (id=${id})`));
        }, 30_000),
      });
      // Store outbound message — Chrome extension will pick it up on next poll
      this._outbound.push({ ...msg, id } as AnyBridgeMessage);
    });
  }

  // ── Outbound queue (Chrome extension polls /pull) ─────────────────────────

  private _outbound: AnyBridgeMessage[] = [];

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // No CORS headers: the legitimate caller is the Chrome companion's background
    // service worker, which isn't subject to page-CORS rules and needs none. Not
    // sending Access-Control-Allow-Origin keeps an arbitrary webpage's fetch() from
    // completing a cross-origin call against this localhost control-plane server.
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (!isBridgeRequestAuthorized(req.headers.authorization, this._token)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    const url = req.url ?? "/";

    // ── GET /health ──────────────────────────────────────────
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.1.0", port: this._port }));
      this._connected = true;
      return;
    }

    // ── GET /pull — Chrome polls for outbound messages ───────
    if (req.method === "GET" && url === "/pull") {
      this._connected = true;
      const msgs = this._outbound.splice(0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: msgs }));
      return;
    }

    // ── POST /push — Chrome posts results back ───────────────
    if (req.method === "POST" && url === "/push") {
      try {
        const body = await this._readBody(req);
        const msg = JSON.parse(body) as BridgeEnvelope;
        if (msg.type === "browser_result" || msg.type === "tool_result") {
          const pending = this._pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(msg.id);
            const payload = msg.payload as { ok?: boolean; data?: unknown; error?: string } | undefined;
            if (payload?.ok === false) {
              pending.reject(new Error(payload.error ?? "Browser action failed"));
            } else {
              pending.resolve(payload?.data ?? payload);
            }
          }
        } else if (msg.type === "tool_call" && this._toolHandler) {
          const payload = msg.payload as { toolName?: string; toolInput?: Record<string, unknown> } | undefined;
          const result = await this._toolHandler(
            payload?.toolName ?? "",
            payload?.toolInput ?? {},
          );
          this._outbound.push({
            id: makeBridgeId(), type: "tool_result",
            payload: { ok: true, data: result },
          });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error instanceof SyntaxError ? "Invalid JSON" : "Invalid request" }));
      }
      return;
    }

    res.writeHead(404); res.end();
  }

  private _readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      let bytes = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BRIDGE_BODY_BYTES) {
          reject(new Error("Bridge request body is too large."));
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
}
