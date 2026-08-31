/* A minimal newline-delimited JSON-RPC MCP server for exercising the stdio transport.
 *
 * Deliberately impolite in two ways that real npx-launched servers routinely are: it prints a
 * banner to stdout before any protocol traffic, and it logs to stderr while perfectly healthy.
 * A client that treats either as a protocol failure breaks against a large share of the
 * ecosystem, so this is the shape worth testing against.
 *
 * Env:
 *   FAKE_MCP_BANNER=1   emit a non-JSON stdout line at startup
 *   FAKE_MCP_TOKEN      echoed back by the `whoami` tool, to prove env reaches the process
 */

const banner = process.env.FAKE_MCP_BANNER === "1";
if (banner) process.stdout.write("fake-stdio-mcp-server listening\n");
process.stderr.write("[fake] started\n");

let initialized = false;
let callCount = 0;
let cancelledCount = 0;
const modern = process.env.FAKE_MCP_MODERN === "1";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tools = [
  { name: "whoami", description: "Report the configured identity", inputSchema: { type: "object", properties: {} } },
  { name: "danger", description: "Something the user may want withheld", inputSchema: { type: "object", properties: {} } },
];

function handle(message) {
  const { id, method, params } = message;

  if (method === "notifications/initialized") {
    initialized = true;
    return null;
  }
  if (method === "notifications/cancelled") {
    cancelledCount += 1;
    return null;
  }
  if (id === undefined) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-stdio", version: "1.0.0" },
      },
    };
  }

  if (method === "server/discover" && modern) {
    return {
      jsonrpc: "2.0", id,
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        ttlMs: 60_000,
        cacheScope: "private",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-stdio-modern", version: "2.0.0" } },
      },
    };
  }

  // Every other method is refused before the handshake completes, the way a spec-strict
  // server does — this is what the old spawn-per-call client fell over on.
  if (!initialized && !modern) {
    return { jsonrpc: "2.0", id, error: { code: -32002, message: "Received request before initialization was complete" } };
  }

  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };

  if (method === "tools/call") {
    callCount += 1;
    const name = params?.name;
    if (name === "whoami") {
      return {
        jsonrpc: "2.0", id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              token: process.env.FAKE_MCP_TOKEN ?? null,
              pid: process.pid,
              callCount,
              cancelledCount,
              padding: "x".repeat(Number(process.env.FAKE_MCP_PADDING ?? 0)),
            }),
          }],
        },
      };
    }
    if (name === "hang") return null;
    if (name === "danger") {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "danger ran" }] } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const response = handle(message);
    if (response) send(response);
  }
});
