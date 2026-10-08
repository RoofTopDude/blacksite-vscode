import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { buildMcpToolCatalog } from "../../src/mcp-tool-catalog.js";
import { approvalGrantKey, commandApprovalScope } from "../../src/approval-scope.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

/* Typed MCP tools (mcp__<server>__<tool>) take the same road as mcp_call_tool: the host resolves
   the server, checks arguments, and gates the call. These specs pin the parts that are new: the
   rewrite into mcp.call_tool, "Always allow", the destructive tier, images reaching the model, and
   approval grants that no longer cover unrelated network work. */

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const catalog = buildMcpToolCatalog([
  { serverId: "docs", serverName: "Docs", tool: { name: "retrieve_doc", inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } } },
  { serverId: "docs", serverName: "Docs", tool: { name: "drop_index", annotations: { destructiveHint: true } } },
]);

interface RunOptions {
  call: ToolUseBlock;
  autoApproval?: (tool: string) => "always" | "read_only" | undefined;
  destructive?: (tool: string) => boolean;
  runtimeResult?: Record<string, unknown>;
  vision?: boolean;
  disabledTools?: string[];
}

async function run({ call, autoApproval, destructive, runtimeResult, vision, disabledTools }: RunOptions) {
  const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
    ? { toolCalls: [call], stopReason: "tool_use", usage }
    : { text: "done", stopReason: "end_turn", usage });
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }) => (message.payload["confirmed"] === true
      ? { result: runtimeResult ?? { ok: true, content: [{ type: "text", text: "ok" }] } }
      : { result: { ok: true, requiresConfirmation: true, tier: "network", description: "Connect to the configured MCP server at https://docs.example and call the tool" } })),
  };
  const approvalProvider = vi.fn(async () => "allow" as const);
  const session = new AgentSession({
    apiKey: "k", model: "claude-sonnet-4-6", systemPrompt: "s", workspaceRoot: "C:/w", provider: "anthropic",
    runtime: runtime as never, context: { workspaceState: { get: () => undefined, update: async () => undefined } } as never,
    checkpointingEnabled: false, maxIterations: 4, approvalProvider: approvalProvider as never,
    supportsVision: vision ?? false,
    disabledTools,
    mcpServerProvider: async () => ({
      ok: true,
      server: { id: "docs", url: "https://docs.example/mcp" } as never,
      toolSchema: (name: string) => catalog.find((tool) => tool.toolName === name)?.definition.input_schema as Record<string, unknown> | undefined,
      autoApproval,
      destructive,
    }),
    mcpToolCatalog: () => catalog,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  const events: AgentEvent[] = [];
  for await (const event of session.send("go")) events.push(event);
  return { events, runtime, approvalProvider, scripted };
}

const typedCall = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: "t1", name, input });

describe("typed MCP tools", () => {
  it("dispatch as mcp.call_tool with the model's input as the tool's arguments", async () => {
    const { runtime, approvalProvider } = await run({ call: typedCall("mcp__docs__retrieve_doc", { filename: "guide.md" }) });
    const confirmed = runtime.handleMessage.mock.calls.map(([message]) => message).find((message) => message.payload["confirmed"] === true);
    expect(confirmed).toMatchObject({ type: "mcp.call_tool", payload: { toolName: "retrieve_doc", args: { filename: "guide.md" } } });
    // The host's descriptor travels, not a model-supplied id.
    expect(confirmed!.payload["server"]).toMatchObject({ id: "docs" });
    expect(confirmed!.payload).not.toHaveProperty("serverId");
    expect(approvalProvider).toHaveBeenCalledWith("t1", "mcp__docs__retrieve_doc", expect.any(String), "network");
  });

  it("check arguments against the tool's own schema before anyone is asked", async () => {
    const { events, runtime, approvalProvider } = await run({ call: typedCall("mcp__docs__retrieve_doc", { name: "guide.md" }) });
    const result = events.find((event) => event.type === "tool_call_result");
    expect(result && "summary" in result ? result.summary : "").toContain("filename is required");
    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(approvalProvider).not.toHaveBeenCalled();
  });

  it("answer a name no longer in the catalog as an unknown tool", async () => {
    const { events, runtime } = await run({ call: typedCall("mcp__docs__vanished", {}) });
    const result = events.find((event) => event.type === "tool_call_result");
    expect(result && "summary" in result ? result.summary : "").toContain("Unknown tool: mcp__docs__vanished");
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it("are switched off with the MCP tool family under Tool Access", async () => {
    const { events, runtime } = await run({ call: typedCall("mcp__docs__retrieve_doc", { filename: "a" }), disabledTools: ["mcp_list_tools", "mcp_call_tool"] });
    const result = events.find((event) => event.type === "tool_call_result");
    expect(result && "summary" in result ? result.summary : "").toContain("Unknown tool");
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it("run without a prompt once the user chose Always allow for that tool", async () => {
    const { runtime, approvalProvider } = await run({
      call: typedCall("mcp__docs__retrieve_doc", { filename: "a" }),
      autoApproval: (tool) => (tool === "retrieve_doc" ? "always" : undefined),
    });
    expect(approvalProvider).not.toHaveBeenCalled();
    expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
    expect(runtime.handleMessage.mock.calls[0]![0].payload["confirmed"]).toBe(true);
  });

  it("gate a tool its server marks destructive as a destructive operation", async () => {
    const { approvalProvider } = await run({ call: typedCall("mcp__docs__drop_index", {}), destructive: (tool) => tool === "drop_index" });
    expect(approvalProvider).toHaveBeenCalledWith("t1", "mcp__docs__drop_index", expect.stringContaining("marks this tool as destructive"), "destructive");
  });

  it("show an image the tool returned to a vision model, and keep the base64 out of the transcript", async () => {
    const { events, scripted } = await run({
      call: typedCall("mcp__docs__retrieve_doc", { filename: "a" }),
      autoApproval: () => "always",
      vision: true,
      runtimeResult: { ok: true, content: [{ type: "text", text: "see image" }], images: [{ mimeType: "image/png", data: PIXEL }] },
    });
    expect(scripted.images).toHaveLength(1);
    expect(scripted.images[0]!.source).toMatchObject({ type: "base64", media_type: "image/png" });
    const result = events.find((event) => event.type === "tool_call_result") as { result?: { images?: unknown[] } } | undefined;
    expect(result?.result?.images).toEqual([{ mimeType: "image/png", omitted: true }]);
    expect(JSON.stringify(scripted.toolResults)).not.toContain(PIXEL);
  });
});

describe("MCP approval grants", () => {
  const mcpScope = (server: string, tool: string) => commandApprovalScope("mcp_call_tool", "mcp.call_tool", "network", { server: { id: server }, toolName: tool }, false);

  it("cover repeat calls of one tool on one server only", () => {
    expect(approvalGrantKey(mcpScope("docs", "retrieve_doc"))).toBe(approvalGrantKey(mcpScope("docs", "retrieve_doc")));
    expect(approvalGrantKey(mcpScope("docs", "retrieve_doc"))).not.toBe(approvalGrantKey(mcpScope("docs", "drop_index")));
    expect(approvalGrantKey(mcpScope("docs", "retrieve_doc"))).not.toBe(approvalGrantKey(mcpScope("other", "retrieve_doc")));
  });

  it("no longer share a key with network shell commands such as git push", () => {
    const push = commandApprovalScope("shell_run", "system.shell", "network", { command: "git", args: ["push"] }, false);
    expect(approvalGrantKey(push)).toBe("command:network");
    expect(approvalGrantKey(mcpScope("docs", "retrieve_doc"))).toBe("mcp:network:docs/retrieve_doc");
  });
});
