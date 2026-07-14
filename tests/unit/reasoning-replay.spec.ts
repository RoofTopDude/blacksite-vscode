/**
 * Reasoning blocks have to survive the round trip.
 *
 * With thinking enabled, Anthropic requires an assistant turn that made tool calls to lead with its
 * reasoning. Two block shapes carry that reasoning, and the parsers used to drop both:
 *
 *  - `redacted_thinking` — safety-encrypted reasoning. The parser had no case for the type at all,
 *    so it vanished on arrival.
 *  - a thinking block with a *signature but no text* — which is exactly what `display: "omitted"`
 *    (the default on Claude 4.7+) produces. The parser required non-empty text to emit it.
 *
 * Either way the assistant turn was recorded without its reasoning, replayed leading with
 * `tool_use`, and took a 400 on the next request.
 */
import { describe, expect, it } from "vitest";
import { normalizeForProvider, toBedrockMessages } from "../../src/agent-session.js";
import type { AgentMessage, ContentBlock } from "../../src/agent-loop-contract.js";

const turnWithRedactedReasoning: AgentMessage[] = [
  { role: "user", content: "do the thing" },
  {
    role: "assistant",
    content: [
      { type: "redacted_thinking", data: "ENCRYPTED_PAYLOAD" },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
];

describe("redacted thinking survives normalization", () => {
  it("is not treated as contentless — it is a real, required block", () => {
    const out = normalizeForProvider(turnWithRedactedReasoning);
    const assistant = out.find((m) => m.role === "assistant")!;
    const blocks = assistant.content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "ENCRYPTED_PAYLOAD" });
  });

  it("stays ahead of the tool_use it belongs to", () => {
    const out = normalizeForProvider(turnWithRedactedReasoning);
    const blocks = (out.find((m) => m.role === "assistant")!.content as ContentBlock[]).map((b) => b.type);
    expect(blocks.indexOf("redacted_thinking")).toBeLessThan(blocks.indexOf("tool_use"));
  });
});

describe("redacted thinking maps to Converse's redactedContent", () => {
  it("serializes to reasoningContent.redactedContent, not a dropped block", () => {
    const [, assistant] = toBedrockMessages(normalizeForProvider(turnWithRedactedReasoning));
    expect(assistant!.content[0]).toEqual({ reasoningContent: { redactedContent: "ENCRYPTED_PAYLOAD" } });
    // And the tool call it precedes is still there.
    expect(assistant!.content[1]).toMatchObject({ toolUse: { toolUseId: "tu_1" } });
  });
});

describe("signed-but-empty thinking blocks", () => {
  /** `display: "omitted"` is the default on Claude 4.7+: the block streams with an empty text field
   *  but a real signature. It is still structurally required on replay. */
  it("replay to Bedrock with their signature intact", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-abc" },
          { type: "tool_use", id: "tu_2", name: "noop", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }] },
    ];
    const [, assistant] = toBedrockMessages(normalizeForProvider(messages));
    expect(assistant!.content[0]).toEqual({
      reasoningContent: { reasoningText: { text: "", signature: "sig-abc" } },
    });
  });

  it("are not mistaken for a contentless turn", () => {
    const out = normalizeForProvider([
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-abc" }] },
    ]);
    const blocks = out.find((m) => m.role === "assistant")!.content as ContentBlock[];
    expect(blocks[0]!.type).toBe("thinking");
  });
});
