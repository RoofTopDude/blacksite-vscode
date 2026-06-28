import * as http from "http";
import * as vscode from "vscode";
import { DEFAULT_BRIDGE_PORT, BRIDGE_HOST, makeBridgeId } from "@blacksite/browser-bridge-protocol";
import type { AnyBridgeMessage, BridgeEnvelope } from "@blacksite/browser-bridge-protocol";

// ── Types ─────────────────────────────────────────────────────────────────────

type BridgeToolHandler = (toolName: string, toolInput: Record<string, unknown>) => Promise<unknown>;

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
  private _connected = false;

  constructor(port: number = DEFAULT_BRIDGE_PORT) {
    this._port = port;
  }

  /** Set the handler for tool calls routed from the Chrome companion. */
  setToolHandler(handler: BridgeToolHandler): void {
    this._toolHandler = handler;
  }

  get isConnected(): boolean { return this._connected; }
  get port(): number         { return this._port; }

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

  private _cors(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Blacksite-Version");
  }

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this._cors(res);

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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
      const body = await this._readBody(req);
      try {
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
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
      return;
    }

    res.writeHead(404); res.end();
  }

  private _readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => resolve(body));
    });
  }
}
