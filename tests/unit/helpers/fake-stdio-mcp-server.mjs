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
 *   FAKE_MCP_EXTRAS=1   also offer resources and prompts, a `grow` tool that adds a tool and
 *                       announces notifications/tools/list_changed, and a `screenshot` tool
 *                       that answers with an image
 */

const banner = process.env.FAKE_MCP_BANNER === "1";
if (banner) process.stdout.write("fake-stdio-mcp-server listening\n");
process.stderr.write("[fake] started\n");

let initialized = false;
let callCount = 0;
let cancelledCount = 0;
const modern = process.env.FAKE_MCP_MODERN === "1";
const extras = process.env.FAKE_MCP_EXTRAS === "1";
/** A 1×1 PNG, base64. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tools = [
  { name: "whoami", description: "Report the configured identity", inputSchema: { type: "object", properties: {} } },
  { name: "danger", description: "Something the user may want withheld", inputSchema: { type: "object", properties: {} } },
];
if (extras) {
  tools.push(
    { name: "grow", description: "Add a tool and announce it", inputSchema: { type: "object", properties: {} } },
    { name: "screenshot", description: "Answer with an image", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  );
}

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
        capabilities: extras ? { tools: { listChanged: true }, resources: {}, prompts: {} } : { tools: {} },
        serverInfo: { name: "fake-stdio", version: "1.0.0" },
        ...(extras ? { instructions: "Use whoami before anything else." } : {}),
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

  if (extras && method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [
      { uri: "fake://readme", name: "readme", mimeType: "text/plain" },
      { uri: "fake://logo", name: "logo", mimeType: "image/png" },
    ] } };
  }
  if (extras && method === "resources/templates/list") {
    return { jsonrpc: "2.0", id, result: { resourceTemplates: [{ uriTemplate: "fake://issues/{number}", name: "issue" }] } };
  }
  if (extras && method === "resources/read") {
    if (params?.uri === "fake://logo") return { jsonrpc: "2.0", id, result: { contents: [{ uri: "fake://logo", mimeType: "image/png", blob: PIXEL }] } };
    return { jsonrpc: "2.0", id, result: { contents: [{ uri: params?.uri, mimeType: "text/plain", text: `contents of ${params?.uri}` }] } };
  }
  if (extras && method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [{ name: "review", description: "Review a file", arguments: [{ name: "path", required: true }] }] } };
  }
  if (extras && method === "prompts/get") {
    return { jsonrpc: "2.0", id, result: { description: "Review", messages: [
      { role: "user", content: { type: "text", text: `Review ${params?.arguments?.path}` } },
      { role: "user", content: { type: "resource", resource: { uri: "fake://readme", text: "embedded readme" } } },
    ] } };
  }

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
    if (extras && name === "grow") {
      tools.push({ name: `grown_${tools.length}`, description: "Appeared later", inputSchema: { type: "object", properties: {} } });
      send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "growing" } });
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "grew" }] } };
    }
    if (extras && name === "screenshot") {
      return { jsonrpc: "2.0", id, result: { content: [
        { type: "text", text: "here it is" },
        { type: "image", mimeType: "image/png", data: PIXEL },
      ] } };
    }
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
