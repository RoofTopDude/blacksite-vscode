import { describe, expect, it } from "vitest";
import {
  toOpenAIMessages,
  safeRecentStart,
  normalizeForProvider,
  sanitizeOversizedToolInputs,
  withRollingCacheBreakpoint,
  buildAnthropicSystemBlocks,
  withResponsesCacheBreakpoints,
  hasResponsesCacheBreakpoint,
  appendResponsesWorkspaceContextTail,
  applyOpenAICacheParams,
  stripOpenAICacheParams,
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

describe("normalizeForProvider — leading-user guarantee (prevents the post-compression 400)", () => {
  it("prepends a user turn when compression leaves the window opening on an assistant tool_use", () => {
    // Reproduces the execution-log failure: after "Compression ×2 applied", messages[0]
    // was an assistant tool_use (wUqk), which Bedrock rejects with a fatal, recurring
    // "Expected toolResult blocks at messages.0.content" 400.
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "wUqk", name: "file_search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "wUqk", content: "ok" }] },
    ];
    const out = normalizeForProvider(messages);
    expect(out[0]!.role).toBe("user");
    // The assistant tool_use and its result are still present and paired.
    const flatUseIds = out.flatMap((m) => Array.isArray(m.content)
      ? (m.content as ContentBlock[]).filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id)
      : []);
    expect(flatUseIds).toContain("wUqk");
  });

  it("leaves an already user-first conversation unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = normalizeForProvider(messages);
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe("user");
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

/**
 * Prompt caching on the OpenAI Responses path.
 *
 * This path was left on implicit caching, which auto-anchors the *newest* input item — and the
 * newest item here is the per-turn workspace tail. A breakpoint keyed on content that never
 * recurs can only ever be written, never read. Measured over a real 635-iteration session: 68.7%
 * of input tokens were cache writes against 24% reads, a 2.87:1 ratio on a model family that
 * bills a write at 1.25x fresh input.
 */
describe("withResponsesCacheBreakpoints", () => {
  const userMsg = (text: string) => ({ type: "message", role: "user", content: text });
  const toolLoop = () => ([
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "function_call", call_id: "c1", name: "file_read", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "contents" },
  ]);

  function breakpointCount(items: Array<Record<string, unknown>>): number {
    return items.filter((i) =>
      Array.isArray(i["content"])
      && (i["content"] as Array<Record<string, unknown>>).some((p) => p["prompt_cache_breakpoint"])).length;
}

describe("historical tool-input bounds", () => {
  it("replaces an oversized function-call input before provider replay without mutating history", () => {
    const huge = "x".repeat(300_000);
    const messages: AgentMessage[] = [
      { role: "user", content: "render it" },
      { role: "assistant", content: [{ type: "tool_use", id: "preview-1", name: "question_card", input: { questions: huge } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "preview-1", content: "ok" }] },
    ];
    const out = sanitizeOversizedToolInputs(messages);
    const original = (messages[1]!.content as ContentBlock[])[0] as { input: { questions: string } };
    const sanitized = (out[1]!.content as ContentBlock[])[0] as { input: Record<string, unknown> };
    expect(original.input.questions).toBe(huge);
    expect(sanitized.input).not.toHaveProperty("questions");
    expect(sanitized.input).toHaveProperty("_history_input_omitted");
  });

  it("applies the bound in shared provider normalization", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "big", name: "question_card", input: { code: "x".repeat(300_000) } }] },
    ];
    const normalized = normalizeForProvider(messages);
    const block = (normalized[1]!.content as ContentBlock[])[0] as { input: Record<string, unknown> };
    expect(JSON.stringify(block.input).length).toBeLessThan(1_048_576);
    expect(block.input).toHaveProperty("_history_input_omitted");
  });
});

  it("anchors the static prefix and the newest user turn, and nothing in between", () => {
    const items = [userMsg("first"), ...toolLoop(), userMsg("middle"), ...toolLoop(), userMsg("newest")];
    const out = withResponsesCacheBreakpoints(items);
    expect(breakpointCount(out)).toBe(2);
    expect(out[0]).toMatchObject({ content: [{ type: "input_text", text: "first", prompt_cache_breakpoint: { mode: "explicit" } }] });
    expect(out.at(-1)).toMatchObject({ content: [{ type: "input_text", text: "newest", prompt_cache_breakpoint: { mode: "explicit" } }] });
  });

  /**
   * The whole point. appendResponsesWorkspaceContextTail runs *after* this, so the tail must be
   * the one item that never carries an anchor — anchoring it is the bug, not the fix.
   */
  it("never anchors the volatile workspace tail appended after it", () => {
    const anchored = withResponsesCacheBreakpoints([userMsg("hello"), ...toolLoop()]);
    const withTail = appendResponsesWorkspaceContextTail(anchored, "open editors: a.ts\ngit: 3 changed");
    const tail = withTail.at(-1)!;
    expect(tail["content"]).toBe("open editors: a.ts\ngit: 3 changed");
    expect(breakpointCount([tail])).toBe(0);
  });

  it("places one anchor when there is only one user turn", () => {
    expect(breakpointCount(withResponsesCacheBreakpoints([userMsg("only"), ...toolLoop()]))).toBe(1);
  });

  it("anchors nothing it cannot legally anchor, so explicit mode stays off", () => {
    // function_call_output carries a bare `output` string with no content part to mark, and the
    // API documents breakpoints on input_text/input_image/input_file only.
    const out = withResponsesCacheBreakpoints(toolLoop());
    expect(hasResponsesCacheBreakpoint(out)).toBe(false);
    const body: Record<string, unknown> = {};
    applyOpenAICacheParams(body, "gpt-5.6-terra", hasResponsesCacheBreakpoint(out));
    expect(body["prompt_cache_options"]).toBeUndefined();
  });

  it("turns explicit mode on once an anchor exists", () => {
    const out = withResponsesCacheBreakpoints([userMsg("hi")]);
    expect(hasResponsesCacheBreakpoint(out)).toBe(true);
    const body: Record<string, unknown> = {};
    applyOpenAICacheParams(body, "gpt-5.6-terra", hasResponsesCacheBreakpoint(out));
    expect(body["prompt_cache_options"]).toEqual({ mode: "explicit" });
  });

  it("does not mutate the items it was given", () => {
    const items = [userMsg("hello")];
    const snapshot = JSON.parse(JSON.stringify(items)) as unknown;
    withResponsesCacheBreakpoints(items);
    expect(items).toEqual(snapshot);
  });

  it("skips an empty user message rather than anchoring an invalid block", () => {
    const out = withResponsesCacheBreakpoints([userMsg(""), userMsg("real")]);
    expect(breakpointCount(out)).toBe(1);
    expect(out[1]).toMatchObject({ content: [{ type: "input_text", text: "real" }] });
  });

  it("anchors the last input_text part of a multipart user message", () => {
    const multipart = {
      type: "message", role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }, { type: "input_text", text: "describe" }],
    };
    const out = withResponsesCacheBreakpoints([multipart]);
    const parts = out[0]!["content"] as Array<Record<string, unknown>>;
    expect(parts[0]?.["prompt_cache_breakpoint"]).toBeUndefined();
    expect(parts[1]?.["prompt_cache_breakpoint"]).toEqual({ mode: "explicit" });
  });
});

/** The rejection-retry must actually change the payload it retries with — see stripOpenAICacheParams. */
describe("stripOpenAICacheParams — Responses payloads", () => {
  it("strips breakpoints out of `input`, not just `messages`", () => {
    const body: Record<string, unknown> = {
      prompt_cache_options: { mode: "explicit" },
      input: withResponsesCacheBreakpoints([{ type: "message", role: "user", content: "hello" }]),
    };
    expect(stripOpenAICacheParams(body)).toBe(true);
    expect(body["prompt_cache_options"]).toBeUndefined();
    expect(hasResponsesCacheBreakpoint(body["input"] as Array<Record<string, unknown>>)).toBe(false);
    // The content itself must survive the strip — only the marker goes.
    expect(body["input"]).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  });

  it("reports no change when a Responses body carries nothing to strip", () => {
    const body: Record<string, unknown> = { input: [{ type: "message", role: "user", content: "hello" }] };
    expect(stripOpenAICacheParams(body)).toBe(false);
  });
});
