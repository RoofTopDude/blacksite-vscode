/* The stdio transport, driven against a real child process.
 *
 * stdio is what most people actually configure — an npx-launched server taking its
 * credentials through the environment — and it is where the old client was weakest: it
 * spawned a fresh process for every single call, wrote one request, and closed stdin, so a
 * server that refuses traffic before `initialize` never worked at all and one that boots
 * slowly paid that cost on every tool call. */

import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  callMcpTool, closeMcpConnections, discoverMcpTools, listMcpTools,
} from "../../packages/local-runtime/src/mcp-client.js";

const serverPath = fileURLToPath(new URL("./helpers/fake-stdio-mcp-server.mjs", import.meta.url));
const command = `node "${serverPath}"`;

let counter = 0;
const uniqueId = (): string => `stdio-${++counter}`;

afterEach(() => {
  // Connections hold live child processes; leaving one running would outlast the test run.
  closeMcpConnections();
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content[0]?.text ?? "";
}

describe("stdio transport", () => {
  it("completes the handshake before issuing any other request", async () => {
    // The fake server refuses everything until notifications/initialized arrives, so a
    // successful listing is itself proof the full handshake ran.
    const result = await listMcpTools({ id: uniqueId(), url: command });
    if (!result.ok) throw new Error(result.error);
    expect(result.tools.map((tool) => tool.name)).toEqual(["whoami", "danger"]);
    expect(result.server.name).toBe("fake-stdio");
  });

  it("tolerates a server that prints a banner to stdout before speaking protocol", async () => {
    const result = await listMcpTools({
      id: uniqueId(), url: command, env: { FAKE_MCP_BANNER: "1" },
    });
    expect(result.ok).toBe(true);
  });

  it("passes environment through to the process, which is how local servers take credentials", async () => {
    const descriptor = { id: uniqueId(), url: command, env: { FAKE_MCP_TOKEN: "sk-local-123" } };
    const result = await callMcpTool(descriptor, "whoami", {});
    if (!result.ok) throw new Error("expected success");
    expect(JSON.parse(textOf(result)).token).toBe("sk-local-123");
  });

  it("keeps one process alive across calls instead of respawning per call", async () => {
    const descriptor = { id: uniqueId(), url: command };
    const first = JSON.parse(textOf(await callMcpTool(descriptor, "whoami", {})));
    const second = JSON.parse(textOf(await callMcpTool(descriptor, "whoami", {})));
    expect(second.pid).toBe(first.pid);
    // The server's own counter proves both calls reached the same process.
    expect(second.callCount).toBe(first.callCount + 1);
  });

  it("replaces the connection when the credentials change", async () => {
    // A pooled connection built with the old environment would otherwise keep serving after
    // the user updated the token.
    const id = uniqueId();
    const before = JSON.parse(textOf(await callMcpTool({ id, url: command, env: { FAKE_MCP_TOKEN: "old" } }, "whoami", {})));
    const after = JSON.parse(textOf(await callMcpTool({ id, url: command, env: { FAKE_MCP_TOKEN: "new" } }, "whoami", {})));
    expect(before.token).toBe("old");
    expect(after.token).toBe("new");
    expect(after.pid).not.toBe(before.pid);
  });

  it("enforces the tool policy on stdio exactly as on HTTP", async () => {
    const descriptor = { id: uniqueId(), url: command, toolPolicy: { deny: ["danger"] } };

    const agentView = await listMcpTools(descriptor);
    if (!agentView.ok) throw new Error(agentView.error);
    expect(agentView.tools.map((tool) => tool.name)).toEqual(["whoami"]);
    expect(JSON.stringify(agentView)).not.toContain("danger");

    const call = await callMcpTool(descriptor, "danger", {});
    expect(call).toEqual({ ok: false, error: "MCP error -32602: Unknown tool: danger" });

    const panelView = await discoverMcpTools(descriptor);
    if (!panelView.ok) throw new Error(panelView.error);
    expect(panelView.tools.map((tool) => tool.name)).toEqual(["whoami", "danger"]);
  });

  it("reports a command that cannot be launched instead of hanging", async () => {
    const result = await listMcpTools({ id: uniqueId(), url: "definitely-not-a-real-command-xyz" });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty command", async () => {
    const result = await listMcpTools({ id: uniqueId(), url: "   " });
    expect(result).toMatchObject({ ok: false, error: "Missing MCP URL or command." });
  });
});
