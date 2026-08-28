import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function context() {
  const values = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); },
    },
  };
}

async function runBrowserCall(url: string) {
  const call: ToolUseBlock = { type: "tool_use", id: "browser-1", name: "browser_navigate", input: { url } };
  const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
    ? { toolCalls: [call], stopReason: "tool_use", usage }
    : { text: "done", stopReason: "end_turn", usage });
  const dispatch = vi.fn(async () => ({ ok: true, url, title: "Test" }));
  const approvalProvider = vi.fn(async () => "allow" as const);
  const session = new AgentSession({
    apiKey: "key",
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as any,
    context: context() as any,
    provider: "anthropic",
    maxIterations: 4,
    checkpointingEnabled: false,
    browserRunner: { available: () => true, dispatch, dispose: async () => undefined },
    approvalProvider,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  const events: AgentEvent[] = [];
  for await (const event of session.send("browse")) events.push(event);
  return { events, dispatch, approvalProvider };
}

describe("AgentSession browser approval boundary", () => {
  it("requires approval before HTTP navigation", async () => {
    const { events, dispatch, approvalProvider } = await runBrowserCall("https://example.com/path?secret=redacted");
    expect(events).toContainEqual(expect.objectContaining({
      type: "approval_pending",
      toolCallId: "browser-1",
      tier: "network",
    }));
    expect(approvalProvider).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects file navigation before prompting or dispatching", async () => {
    const { events, dispatch, approvalProvider } = await runBrowserCall("file:///C:/Windows/win.ini");
    expect(events.some((event) => event.type === "approval_pending")).toBe(false);
    expect(approvalProvider).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call_result",
      toolCallId: "browser-1",
      result: expect.objectContaining({ ok: false, error: expect.stringMatching(/only HTTP\(S\)/i) }),
    }));
  });
});
