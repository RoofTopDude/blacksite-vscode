import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

/* A guessed argument name used to cost an approval and a round trip to the server before the
   server said what was missing — and the next session guessed the same way. When the tool's
   schema is known, a call that cannot succeed is answered locally, before anyone is asked. */

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const schema = {
  type: "object",
  properties: { filename: { type: "string" }, version: { type: "string" } },
  required: ["filename"],
};

async function callWith(args: Record<string, unknown>) {
  const call: ToolUseBlock = { type: "tool_use", id: "m", name: "mcp_call_tool", input: { serverId: "docs", toolName: "retrieve_doc", args } };
  const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
    ? { toolCalls: [call], stopReason: "tool_use", usage }
    : { text: "done", stopReason: "end_turn", usage });
  const runtime = { handleMessage: vi.fn(async () => ({ result: { ok: true, requiresConfirmation: true, tier: "network", description: "call it" } })) };
  const approvalProvider = vi.fn(async () => "deny" as const);
  const session = new AgentSession({
    apiKey: "k", model: "claude-sonnet-4-6", systemPrompt: "s", workspaceRoot: "C:/w", provider: "anthropic",
    runtime: runtime as never, context: { workspaceState: { get: () => undefined, update: async () => undefined } } as never,
    checkpointingEnabled: false, maxIterations: 4, approvalProvider: approvalProvider as never,
    mcpServerProvider: async () => ({ ok: true, server: { url: "https://docs.example/mcp" } as never, toolSchema: (name: string) => name === "retrieve_doc" ? schema : undefined }),
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  const events: AgentEvent[] = [];
  for await (const event of session.send("get the doc")) events.push(event);
  return { events, runtime, approvalProvider };
}

describe("MCP arguments checked against the discovered schema", () => {
  it("answers a call missing a required argument without asking or contacting the server", async () => {
    const { events, runtime, approvalProvider } = await callWith({ name: "guide.md" });

    const result = events.find((event) => event.type === "tool_call_result");
    expect(result).toMatchObject({ ok: false });
    expect(result && "summary" in result ? result.summary : "").toContain("filename is required");
    expect(result && "summary" in result ? result.summary : "").toContain("Expected args: { filename: string");
    expect(approvalProvider).not.toHaveBeenCalled();
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it("lets a well-formed call through to the usual approval", async () => {
    const { runtime } = await callWith({ filename: "guide.md" });
    expect(runtime.handleMessage).toHaveBeenCalled();
  });
});
