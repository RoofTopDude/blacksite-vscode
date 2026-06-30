import { describe, expect, it } from "vitest";
import {
  toOpenAIMessages,
  safeRecentStart,
  withRollingCacheBreakpoint,
  buildAnthropicSystemBlocks,
} from "../../src/agent-session.js";
import type { AgentMessage, ContentBlock } from "../../src/agent-loop-contract.js";

describe("toOpenAIMessages — tool-pair integrity (prevents the run-ending 400)", () => {
  it("never emits a tool message whose call_id has no matching assistant tool_call", () => {
    // An orphan tool_result that slipped past sanitize must not reach the provider as a
    // 'function call output' with no call — that is the fatal OpenRouter/OpenAI 400.
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_orphan", content: "x" }] },
      { role: "assistant", content: "hi" },
    ];
    const out = toOpenAIMessages(messages, "sys");
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("pairs a tool result only with an emitted call, once", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_1", content: "a" },
        { type: "tool_result", tool_use_id: "call_1", content: "dup" }, // duplicate
        { type: "tool_result", tool_use_id: "ghost", content: "b" },    // orphan
      ] },
    ];
    const toolMsgs = toOpenAIMessages(messages, "sys").filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0]!.tool_call_id).toBe("call_1");
  });

  it("skips a bare empty assistant turn that would desync pairing", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [] as ContentBlock[] },
      { role: "user", content: "next" },
    ];
    const out = toOpenAIMessages(messages, "sys");
    // system + the user message only; the empty assistant is dropped.
    expect(out.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("safeRecentStart — compression never splits a tool pair", () => {
  it("walks the boundary back so recent never starts on a tool_result", () => {
    // 6 messages; keepRecent=3 would start recent at index 3 — a tool_result message.
    const messages: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "n", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", content: "r0" }] }, // idx 3
      { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "n", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "r2" }] },
    ];
    const start = safeRecentStart(messages, 3);
    // index 3 carries a tool_result, so the boundary must move earlier than 3.
    expect(start).toBeLessThan(3);
    const first = messages[start]!;
    const carriesResult = first.role === "user" && Array.isArray(first.content)
      && (first.content as ContentBlock[]).some((b) => b.type === "tool_result");
    expect(carriesResult).toBe(false);
  });

  it("leaves a clean boundary unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    expect(safeRecentStart(messages, 2)).toBe(2);
  });
});

describe("Anthropic prompt caching (head hygiene + cache rate)", () => {
  it("marks the stable system prompt with a cache breakpoint", () => {
    const blocks = buildAnthropicSystemBlocks("SYSTEM", "");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } });
  });

  it("puts the growing summary in a separate UNcached block so it cannot bust the cached head", () => {
    const blocks = buildAnthropicSystemBlocks("SYSTEM", "SUMMARY");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]!.cache_control).toBeUndefined();
    expect(blocks[1]!.text).toContain("SUMMARY");
  });

  it("adds a rolling cache breakpoint on the last message only", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "first" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ];
    const out = withRollingCacheBreakpoint(messages);
    const lastBlock = (out[1]!.content as Array<ContentBlock & { cache_control?: unknown }>)[0]!;
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
    // earlier message is untouched (still a plain string)
    expect(out[0]!.content).toBe("first");
  });

  it("does not mutate the input messages array", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "only" }];
    const snapshot = JSON.parse(JSON.stringify(messages));
    withRollingCacheBreakpoint(messages);
    expect(messages).toEqual(snapshot);
  });
});
