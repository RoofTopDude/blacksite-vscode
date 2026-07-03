import { describe, expect, it } from "vitest";
import { toOpenAIMessages, toBedrockMessages } from "../../src/agent-session.js";
import type { AgentMessage, ImageBlock } from "../../src/agent-loop-contract.js";

const IMAGE: ImageBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
};

describe("toOpenAIMessages — image blocks", () => {
  it("sends an image as an image_url content part alongside sibling text", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "{\"ok\":true}" },
          { type: "text", text: "zoomed region" },
          IMAGE,
        ],
      },
    ];
    const out = toOpenAIMessages(messages, "sys");
    const userMsg = out.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const parts = userMsg!.content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    expect(parts[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    expect(parts.find((p) => p.type === "text")?.text).toBe("zoomed region");
  });

  it("still emits the tool_result as its own role:tool message, never inside the image message", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "reference_zoom_image", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"ok\":true}" }, IMAGE] },
    ];
    const out = toOpenAIMessages(messages, "sys");
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("{\"ok\":true}");
    expect(typeof toolMsg?.content).toBe("string");
  });

  it("emits a plain string user message with no array wrapping when there are no images", () => {
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const out = toOpenAIMessages(messages, "sys");
    expect(out.find((m) => m.role === "user")?.content).toBe("hi");
  });
});

describe("toBedrockMessages — image blocks", () => {
  it("converts an image block into a Bedrock image content block", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }, IMAGE] },
    ];
    const out = toBedrockMessages(messages);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "call_1", content: [{ text: "x" }] } },
          { image: { format: "png", source: { bytes: "AAAA" } } },
        ],
      },
    ]);
  });

  it("maps jpeg/gif/webp media types to their Bedrock format, defaulting unknown types to png", () => {
    const jpeg: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } };
    const gif: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/gif", data: "x" } };
    const webp: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/webp", data: "x" } };
    const unknown: ImageBlock = { type: "image", source: { type: "base64", media_type: "application/octet-stream", data: "x" } };
    for (const [block, format] of [[jpeg, "jpeg"], [gif, "gif"], [webp, "webp"], [unknown, "png"]] as const) {
      const [out] = toBedrockMessages([{ role: "user", content: [block] }]);
      expect(out!.content).toEqual([{ image: { format, source: { bytes: "x" } } }]);
    }
  });
});
