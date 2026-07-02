import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { DEFAULT_PAGE_CHAR_LIMIT } from "../../src/tool-result-paging.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";

/**
 * End-to-end coverage for the tool_output_page mechanism: a huge tool result gets
 * capped before it reaches the model, and the agent can page back into the stored
 * original using exactly the toolCallId + offset the truncation notice suggests —
 * exercised through the real AgentSession dispatch path, not just the pure helpers.
 *
 * A capped tool_result is deliberately NOT valid JSON — it's a JSON string cut off
 * mid-structure plus a plain-text notice — so assertions on capped content use string
 * matching, not JSON.parse. A page response that stays under the ceiling (the normal
 * case) IS valid JSON, since it's built fresh rather than sliced from existing JSON text.
 */

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const fakeContext = createFakeContext();
  const runtime = overrides.runtime ?? { handleMessage: vi.fn(async () => ({ result: { ok: true } })) };
  const session = new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: fakeContext as unknown as ConstructorParameters<typeof AgentSession>[0]["context"],
    provider: "anthropic",
    maxIterations: 10,
    checkpointingEnabled: false,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    ...overrides,
  });
  return { session, runtime };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** Extracts the offset a truncation notice suggests, e.g. "...offset 19998 to continue...". */
function extractSuggestedOffset(noticeText: string): number {
  const match = /offset (\d+) to continue/.exec(noticeText);
  if (!match) throw new Error(`No offset found in: ${noticeText}`);
  return Number(match[1]);
}

describe("AgentSession — tool_output_page end-to-end", () => {
  it("caps a huge tool result at creation time and serves the rest via tool_output_page", async () => {
    const hugeContent = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const fullStringified = JSON.stringify({ ok: true, content: hugeContent });
    const bigResultRuntime = { handleMessage: vi.fn(async () => ({ result: { ok: true, content: hugeContent } })) };

    const turnFactory: ScriptedTurnFactory = ({ turnIndex, toolResults }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-big", name: "file_read", input: { path: "huge.log" } };
        return {
          toolCalls: [call],
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      if (turnIndex === 1) {
        // Behave like the model actually would: read the notice from turn 0's own
        // capped result and copy its suggested toolCallId/offset verbatim. Ask for a
        // moderate page size so the wrapped response itself stays comfortably under
        // the ceiling — the "requesting everything re-triggers the cap" case has its
        // own test below.
        const cappedContent = String(toolResults[0]![0]!.content);
        const offset = extractSuggestedOffset(cappedContent);
        const call: ToolUseBlock = { type: "tool_use", id: "call-page", name: "tool_output_page", input: { toolCallId: "call-big", offset, limit: 5000 } };
        return {
          toolCalls: [call],
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({
      runtime: bigResultRuntime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      providerTurnSessionFactory: () => scripted,
    });

    const events = await collectEvents(session.send("read the huge log"));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(scripted.toolResults).toHaveLength(2);

    // Turn 0: the file_read result was capped, not sent to the model whole.
    const cappedRaw = String(scripted.toolResults[0]![0]!.content);
    expect(cappedRaw.length).toBeLessThan(fullStringified.length);
    expect(cappedRaw).toContain('toolCallId "call-big"');
    expect(cappedRaw).toContain("tool_output_page");
    const noticeIndex = cappedRaw.indexOf("\n\n[Output truncated");
    expect(noticeIndex).toBeGreaterThan(0);
    const cappedPrefix = cappedRaw.slice(0, noticeIndex);
    expect(fullStringified.startsWith(cappedPrefix)).toBe(true);
    expect(cappedPrefix.length).toBeLessThanOrEqual(DEFAULT_PAGE_CHAR_LIMIT);

    // Turn 1: tool_output_page's response stayed under the ceiling, so it's well-formed JSON.
    const pageRaw = String(scripted.toolResults[1]![0]!.content);
    const page = JSON.parse(pageRaw) as {
      ok: boolean; toolCallId: string; offset: number; totalLength: number; hasMore: boolean; content: string;
    };
    expect(page.ok).toBe(true);
    expect(page.toolCallId).toBe("call-big");
    expect(page.totalLength).toBe(fullStringified.length);

    // Stitching the first capped prefix + the returned page reproduces a contiguous,
    // lossless read of the full JSON-stringified result starting from index 0.
    const reconstructed = cappedPrefix + page.content;
    expect(fullStringified.startsWith(reconstructed)).toBe(true);
  });

  it("returns a clear error when paging an unknown or expired toolCallId", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-page", name: "tool_output_page", input: { toolCallId: "never-existed", offset: 0 } };
        return { toolCalls: [call], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    };
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    await collectEvents(session.send("try paging something that was never truncated"));

    const resultRaw = String(scripted.toolResults[0]![0]!.content);
    const result = JSON.parse(resultRaw) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("never-existed");
  });

  it("respects a custom limit and reports hasMore/totalLength accurately", async () => {
    const hugeContent = Array.from({ length: 5_000 }, (_, i) => `row-${i}`).join("\n");
    const fullStringified = JSON.stringify({ ok: true, content: hugeContent });
    const bigResultRuntime = { handleMessage: vi.fn(async () => ({ result: { ok: true, content: hugeContent } })) };

    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-big", name: "shell_run", input: { command: "cat", args: ["huge.log"] } };
        return { toolCalls: [call], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      if (turnIndex === 1) {
        // A deliberately small page size, smaller than the original cap.
        const call: ToolUseBlock = { type: "tool_use", id: "call-page", name: "tool_output_page", input: { toolCallId: "call-big", offset: 0, limit: 500 } };
        return { toolCalls: [call], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    };
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({
      runtime: bigResultRuntime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      providerTurnSessionFactory: () => scripted,
    });

    await collectEvents(session.send("read the huge log with a small page size"));

    const page = JSON.parse(String(scripted.toolResults[1]![0]!.content)) as {
      ok: boolean; totalLength: number; hasMore: boolean; content: string;
    };
    expect(page.ok).toBe(true);
    expect(page.totalLength).toBe(fullStringified.length);
    expect(page.hasMore).toBe(true);
    // The returned page respects the requested small limit (allowing for boundary snapping).
    expect(page.content.length).toBeLessThanOrEqual(500);
  });

  it("re-caps the page response itself when a requested limit would exceed the ceiling — the cap is uniform, not a per-tool special case", async () => {
    const hugeContent = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const fullStringified = JSON.stringify({ ok: true, content: hugeContent });
    const bigResultRuntime = { handleMessage: vi.fn(async () => ({ result: { ok: true, content: hugeContent } })) };

    const turnFactory: ScriptedTurnFactory = ({ turnIndex, toolResults }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-big", name: "file_read", input: { path: "huge.log" } };
        return { toolCalls: [call], stopReason: "tool_use", usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      if (turnIndex === 1) {
        const cappedContent = String(toolResults[0]![0]!.content);
        const offset = extractSuggestedOffset(cappedContent);
        // Attempt to bypass the cap entirely by asking for everything remaining in one page.
        const call: ToolUseBlock = {
          type: "tool_use", id: "call-page", name: "tool_output_page",
          input: { toolCallId: "call-big", offset, limit: fullStringified.length },
        };
        return { toolCalls: [call], stopReason: "tool_use", usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    };
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({
      runtime: bigResultRuntime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      providerTurnSessionFactory: () => scripted,
    });

    await collectEvents(session.send("try to get everything back in one page"));

    // The page response went through the exact same capping wrapper as any other tool
    // result — an oversized limit doesn't actually let the agent bypass the ceiling.
    const pageRaw = String(scripted.toolResults[1]![0]!.content);
    expect(pageRaw.length).toBeLessThanOrEqual(DEFAULT_PAGE_CHAR_LIMIT + 300); // ceiling + notice overhead
    expect(pageRaw).toContain("tool_output_page");
    // This second-order truncation notice points at its OWN call id, so continuing
    // further pages the page request itself — self-consistent, no special-casing.
    expect(pageRaw).toContain('toolCallId "call-page"');
  });
});
