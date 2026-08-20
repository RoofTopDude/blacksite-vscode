/* The client, driven against a real loopback MCP server rather than a mocked fetch.
 *
 * Every failure this covers is one the previous implementation shipped with: it sent
 * `tools/list` with no handshake, never carried the session id a Streamable HTTP server hands
 * out, read one page of a paginated listing, and had no notion of a tool the user had
 * withheld. Those are protocol-level behaviours, so they are worth testing against something
 * that actually speaks HTTP. */

import { afterEach, describe, expect, it } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  callMcpTool, closeMcpConnections, discoverMcpTools, listMcpTools, pingMcpServer,
} from "../../packages/local-runtime/src/mcp-client.js";
import type { McpToolDescriptor } from "../../packages/local-runtime/src/mcp-protocol.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

interface FakeServerOptions {
  /** Reject every request that arrives without the session id handed out at initialize. */
  requireSession?: boolean;
  /** One entry per tools/list page; a second page implies a nextCursor on the first. */
  pages?: McpToolDescriptor[][];
  /** Answer requests as an event stream instead of JSON. */
  sse?: boolean;
  /** Answer with 401 and an RFC 9728 challenge. */
  unauthorized?: boolean;
  /** Refuse POSTs the way a 2024-11-05 server does, and serve the legacy GET stream. */
  legacyOnly?: boolean;
  /** Result for tools/call. */
  callResult?: Record<string, unknown>;
}

interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const SESSION_ID = "session-abc123";

async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const pages = options.pages ?? [[{ name: "read_file", description: "Read a file" }, { name: "delete_file", description: "Delete a file" }]];
  let legacyStream: http.ServerResponse | undefined;

  const respond = (res: http.ServerResponse, payload: unknown, extraHeaders: Record<string, string> = {}): void => {
    if (options.sse) {
      res.writeHead(200, { "Content-Type": "text/event-stream", ...extraHeaders });
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(payload));
  };

  const handle = (body: Record<string, unknown>): unknown => {
    const id = body["id"];
    switch (body["method"]) {
      case "initialize":
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fake-server", version: "9.9.9" },
          },
        };
      case "tools/list": {
        const params = (body["params"] ?? {}) as Record<string, unknown>;
        const index = params["cursor"] === "page-1" ? 1 : 0;
        const tools = pages[index] ?? [];
        const hasNext = index === 0 && pages.length > 1;
        return { jsonrpc: "2.0", id, result: { tools, ...(hasNext ? { nextCursor: "page-1" } : {}) } };
      }
      case "tools/call":
        return {
          jsonrpc: "2.0", id,
          result: options.callResult ?? { content: [{ type: "text", text: "done" }] },
        };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${String(body["method"])}` } };
    }
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += String(chunk); });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { body = null; }
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });

      if (options.unauthorized) {
        res.writeHead(401, {
          "WWW-Authenticate": 'Bearer realm="mcp", resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource/mcp"',
        });
        res.end();
        return;
      }

      if (options.legacyOnly) {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          legacyStream = res;
          res.write("event: endpoint\ndata: /messages\n\n");
          return;
        }
        // Legacy servers acknowledge the POST and answer on the held-open stream.
        res.writeHead(202); res.end();
        if (body && body["id"] !== undefined) {
          legacyStream?.write(`event: message\ndata: ${JSON.stringify(handle(body))}\n\n`);
        }
        return;
      }

      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      if (!body) { res.writeHead(400); res.end(); return; }

      // A notification carries no id and gets no response body.
      if (body["id"] === undefined) { res.writeHead(202); res.end(); return; }

      const isInitialize = body["method"] === "initialize";
      if (options.requireSession && !isInitialize && req.headers["mcp-session-id"] !== SESSION_ID) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Session not found" } }));
        return;
      }
      respond(res, handle(body), isInitialize ? { "Mcp-Session-Id": SESSION_ID } : {});
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve) => {
      legacyStream?.end();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const open: FakeServer[] = [];
async function serve(options: FakeServerOptions = {}): Promise<FakeServer> {
  const server = await startFakeServer(options);
  open.push(server);
  return server;
}

afterEach(async () => {
  // Connections are pooled and long-lived by design; a test must not leave one holding the
  // next test's port.
  closeMcpConnections();
  while (open.length) await open.pop()!.close();
});

let counter = 0;
const uniqueId = (): string => `test-server-${++counter}`;

describe("handshake", () => {
  it("initializes before anything else and confirms with notifications/initialized", async () => {
    const server = await serve();
    const result = await listMcpTools({ id: uniqueId(), url: server.url });
    expect(result.ok).toBe(true);

    const methods = server.requests.map((request) => request.body?.["method"]);
    expect(methods[0]).toBe("initialize");
    expect(methods).toContain("notifications/initialized");
    // A spec-strict server refuses every request that arrives before the handshake, which is
    // exactly what the previous bare tools/list ran into.
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("tools/list"));
  });

  it("reports the server identity and negotiated revision", async () => {
    const server = await serve();
    const result = await pingMcpServer({ id: uniqueId(), url: server.url });
    if (!result.ok) throw new Error(result.error);
    expect(result.server.name).toBe("fake-server");
    expect(result.server.version).toBe("9.9.9");
    expect(result.server.protocolVersion).toBe("2025-06-18");
    expect(result.server.protocolSupported).toBe(true);
    expect(result.server.capabilities).toContain("tools");
  });

  it("carries the session id and protocol version on every request after initialize", async () => {
    const server = await serve({ requireSession: true });
    const result = await listMcpTools({ id: uniqueId(), url: server.url });
    expect(result.ok).toBe(true);

    const listing = server.requests.find((request) => request.body?.["method"] === "tools/list");
    expect(listing?.headers["mcp-session-id"]).toBe(SESSION_ID);
    expect(listing?.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("reuses one connection across calls instead of re-handshaking", async () => {
    // The pool is what makes stdio servers usable at all; for HTTP it is what keeps the
    // session alive.
    const server = await serve();
    const descriptor = { id: uniqueId(), url: server.url };
    await listMcpTools(descriptor);
    await callMcpTool(descriptor, "read_file", { path: "a.txt" });
    expect(server.requests.filter((request) => request.body?.["method"] === "initialize")).toHaveLength(1);
  });
});

describe("transports", () => {
  it("reads a response delivered as an event stream", async () => {
    const server = await serve({ sse: true });
    const result = await listMcpTools({ id: uniqueId(), url: server.url });
    if (!result.ok) throw new Error(result.error);
    expect(result.tools.map((tool) => tool.name)).toEqual(["read_file", "delete_file"]);
  });

  it("falls back to the legacy HTTP+SSE pair when a server refuses the POST", async () => {
    // A large share of deployed servers never moved off 2024-11-05, and to a user "my server
    // does not work" is the same complaint either way.
    const server = await serve({ legacyOnly: true });
    const result = await listMcpTools({ id: uniqueId(), url: server.url });
    if (!result.ok) throw new Error(result.error);
    expect(result.tools.map((tool) => tool.name)).toEqual(["read_file", "delete_file"]);
    expect(server.requests.some((request) => request.method === "GET")).toBe(true);
    expect(server.requests.some((request) => request.url === "/messages")).toBe(true);
  });

  it("follows the pagination cursor to the end of the catalog", async () => {
    const server = await serve({
      pages: [[{ name: "tool_a" }, { name: "tool_b" }], [{ name: "tool_c" }]],
    });
    const result = await discoverMcpTools({ id: uniqueId(), url: server.url });
    if (!result.ok) throw new Error(result.error);
    expect(result.tools.map((tool) => tool.name)).toEqual(["tool_a", "tool_b", "tool_c"]);
  });
});

describe("authentication", () => {
  it("sends a bearer token when one is supplied", async () => {
    const server = await serve();
    await listMcpTools({ id: uniqueId(), url: server.url, apiKey: "tok-123" });
    expect(server.requests[0]?.headers["authorization"]).toBe("Bearer tok-123");
  });

  it("sends a custom credential header when the server takes one", async () => {
    const server = await serve();
    await listMcpTools({ id: uniqueId(), url: server.url, headers: { "X-API-Key": "key-1" } });
    expect(server.requests[0]?.headers["x-api-key"]).toBe("key-1");
  });

  it("turns a 401 into an actionable auth challenge instead of an opaque failure", async () => {
    const server = await serve({ unauthorized: true });
    const result = await listMcpTools({ id: uniqueId(), url: server.url });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.authRequired).toBe(true);
    // This pointer is where the whole OAuth flow starts; losing it means the user is told
    // only that something went wrong.
    expect(result.authChallenge?.resourceMetadataUrl)
      .toBe("https://auth.example.com/.well-known/oauth-protected-resource/mcp");
  });

  it("does not retry an authorization failure on the legacy transport", async () => {
    // The transport was right and the credentials were not; a second attempt would only
    // produce a more confusing 401.
    const server = await serve({ unauthorized: true });
    await listMcpTools({ id: uniqueId(), url: server.url });
    expect(server.requests.filter((request) => request.method === "GET")).toHaveLength(0);
  });
});

describe("tool visibility", () => {
  it("removes a withheld tool from the agent's listing while the panel still sees it", async () => {
    const server = await serve();
    const descriptor = { id: uniqueId(), url: server.url, toolPolicy: { deny: ["delete_file"] } };

    const agentView = await listMcpTools(descriptor);
    if (!agentView.ok) throw new Error(agentView.error);
    expect(agentView.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    // Not a count, not a placeholder — the name must not appear anywhere in what the model reads.
    expect(JSON.stringify(agentView)).not.toContain("delete_file");

    const panelView = await discoverMcpTools(descriptor);
    if (!panelView.ok) throw new Error(panelView.error);
    expect(panelView.tools.map((tool) => tool.name)).toEqual(["read_file", "delete_file"]);
  });

  it("answers a withheld tool call exactly as an unknown name, without contacting the server", async () => {
    const server = await serve();
    const result = await callMcpTool(
      { id: uniqueId(), url: server.url, toolPolicy: { deny: ["delete_file"] } },
      "delete_file",
      { path: "a.txt" },
    );
    expect(result).toEqual({ ok: false, error: "MCP error -32602: Unknown tool: delete_file" });
    // Not even a connection: a timing difference would be enough to distinguish "withheld"
    // from "never existed".
    expect(server.requests).toHaveLength(0);
  });

  it("still runs a tool the policy admits", async () => {
    const server = await serve();
    const result = await callMcpTool(
      { id: uniqueId(), url: server.url, toolPolicy: { deny: ["delete_file"] } },
      "read_file",
      { path: "a.txt" },
    );
    expect(result.ok).toBe(true);
    expect(server.requests.some((request) => request.body?.["method"] === "tools/call")).toBe(true);
  });

  it("withholds an unreviewed tool under a deny fallback", async () => {
    const server = await serve();
    const result = await listMcpTools({
      id: uniqueId(), url: server.url,
      toolPolicy: { allow: ["read_file"], fallback: "deny" },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.tools.map((tool) => tool.name)).toEqual(["read_file"]);
  });
});

describe("tool results", () => {
  it("surfaces a tool-reported error as a failure carrying the server's text", async () => {
    const server = await serve({
      callResult: { isError: true, content: [{ type: "text", text: "File not found" }] },
    });
    const result = await callMcpTool({ id: uniqueId(), url: server.url }, "read_file", {});
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe("File not found");
  });

  it("replaces an oversized inline blob with a description of it", async () => {
    // A 3 MB data URL would otherwise land verbatim in the conversation, costing an enormous
    // number of tokens to convey nothing the model can read.
    const server = await serve({
      callResult: { content: [{ type: "image", mimeType: "image/png", data: "A".repeat(200_000) }] },
    });
    const result = await callMcpTool({ id: uniqueId(), url: server.url }, "screenshot", {});
    if (!result.ok) throw new Error("expected success");
    const block = (result.content as Array<Record<string, unknown>>)[0];
    expect(String(block?.["data"])).toMatch(/^\[image\/png payload omitted — \d+ KB\]$/);
    // The structure survives, so the model still learns an image came back.
    expect(block?.["type"]).toBe("image");
  });

  it("passes structured content through", async () => {
    const server = await serve({
      callResult: { content: [{ type: "text", text: "ok" }], structuredContent: { rows: 3 } },
    });
    const result = await callMcpTool({ id: uniqueId(), url: server.url }, "query", {});
    if (!result.ok) throw new Error("expected success");
    expect(result.structuredContent).toEqual({ rows: 3 });
  });
});

describe("failure handling", () => {
  it("reports a refused connection rather than throwing", async () => {
    const result = await listMcpTools({ id: uniqueId(), url: "http://127.0.0.1:9/mcp" });
    expect(result.ok).toBe(false);
  });

  it("rejects a descriptor with no target", async () => {
    const result = await listMcpTools({ id: uniqueId(), url: "  " });
    expect(result).toMatchObject({ ok: false, error: "Missing MCP URL or command." });
  });
});
