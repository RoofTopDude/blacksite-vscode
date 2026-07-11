import { describe, expect, it } from "vitest";
import { stripUnsignedThinking } from "../../src/agent-session.js";
import type { AgentMessage, ContentBlock } from "../../src/agent-loop-contract.js";

function blocks(msg: AgentMessage): ContentBlock[] {
  return msg.content as ContentBlock[];
}

describe("stripUnsignedThinking", () => {
  it("keeps a signed thinking block so it can be replayed to Anthropic verbatim", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think", signature: "sig-abc" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const out = stripUnsignedThinking(messages);
    expect(blocks(out[1]!)).toHaveLength(2);
    expect(blocks(out[1]!)[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
  });

  it("drops an unsigned thinking block (which Anthropic would reject) but keeps the rest", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "unsigned reasoning" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "t1", name: "file_list", input: {} },
        ],
      },
    ];
    const out = stripUnsignedThinking(messages);
    const kept = blocks(out[0]!);
    expect(kept.some((b) => b.type === "thinking")).toBe(false);
    expect(kept.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("substitutes a placeholder when stripping would leave an empty assistant turn", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "only unsigned reasoning" }] },
    ];
    const out = stripUnsignedThinking(messages);
    const kept = blocks(out[0]!);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ type: "text" });
  });

  it("leaves string-content and thinking-free messages untouched (same reference)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "plain" },
      { role: "assistant", content: [{ type: "text", text: "no thinking here" }] },
    ];
    const out = stripUnsignedThinking(messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
  });
});
