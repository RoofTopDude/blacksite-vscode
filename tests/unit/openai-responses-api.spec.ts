import { describe, expect, it } from "vitest";
import {
  appendResponsesWorkspaceContextTail, normalizeResponsesStopReason, toResponsesInputItems, toResponsesTools,
} from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";

describe("toResponsesTools", () => {
  it("uses the flat {type,name,description,parameters} shape, not Chat Completions' nested function wrapper", () => {
    const tools = toResponsesTools([
      { name: "file_read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    expect(tools).toEqual([{
      type: "function",
      name: "file_read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }]);
  });
});

describe("toResponsesInputItems", () => {
  it("converts a plain string user/assistant turn to bare-string message items", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ];
    expect(toResponsesInputItems(messages)).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "hello there" },
    ]);
  });

  it("flattens a tool_use + tool_result pair into standalone function_call / function_call_output items", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "file_list", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.txt\nb.txt" }] },
    ];
    const items = toResponsesInputItems(messages);
    expect(items).toContainEqual({ type: "function_call", call_id: "call_1", name: "file_list", arguments: JSON.stringify({ path: "." }) });
    expect(items).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" });
  });

  it("drops an orphaned tool_result whose call_id was never emitted by a preceding tool_use", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "stray" }] },
    ];
    expect(toResponsesInputItems(messages)).toEqual([]);
  });

  it("never answers the same call_id twice", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "first" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "duplicate" }] },
    ];
    const outputs = toResponsesInputItems(messages).filter((i) => i["type"] === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ output: "first" });
  });

  it("replays an OpenAI-origin reasoning block (reasoningItemId present) ahead of the tool call it informed", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should list files first", reasoningItemId: "rs_abc", encryptedContent: "enc_xyz" },
          { type: "tool_use", id: "call_1", name: "file_list", input: {} },
        ],
      },
    ];
    const items = toResponsesInputItems(messages);
    expect(items[0]).toEqual({
      type: "reasoning",
      id: "rs_abc",
      summary: [{ type: "summary_text", text: "I should list files first" }],
      encrypted_content: "enc_xyz",
    });
    expect(items[1]).toMatchObject({ type: "function_call", call_id: "call_1" });
  });

  it("drops an Anthropic-origin thinking block (signature, no reasoningItemId) — it means nothing to this API", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "anthropic reasoning", signature: "sig-abc" }, { type: "text", text: "answer" }] },
    ];
    const items = toResponsesInputItems(messages);
    expect(items.some((i) => i["type"] === "reasoning")).toBe(false);
    expect(items).toEqual([{ type: "message", role: "assistant", content: "answer" }]);
  });

  it("drops a compaction block silently — Anthropic-only, meaningless to this API", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "compaction", content: "summary" }, { type: "text", text: "answer" }] },
    ];
    expect(toResponsesInputItems(messages)).toEqual([{ type: "message", role: "assistant", content: "answer" }]);
  });

  it("builds an input_image + input_text content array for a user turn with an attachment", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what's in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ];
    const items = toResponsesInputItems(messages);
    expect(items).toEqual([{
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
        { type: "input_text", text: "what's in this image?" },
      ],
    }]);
  });

  it("skips an empty string turn instead of emitting a blank message item", () => {
    expect(toResponsesInputItems([{ role: "user", content: "" }])).toEqual([]);
  });
});

describe("appendResponsesWorkspaceContextTail", () => {
  it("appends a trailing user message item with the workspace context", () => {
    const items = [{ type: "message", role: "user", content: "hi" }];
    const out = appendResponsesWorkspaceContextTail(items, "current workspace state...");
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ type: "message", role: "user", content: "current workspace state..." });
  });

  it("is a no-op for blank workspace context or an empty item list", () => {
    const items = [{ type: "message", role: "user", content: "hi" }];
    expect(appendResponsesWorkspaceContextTail(items, "")).toBe(items);
    expect(appendResponsesWorkspaceContextTail(items, "   ")).toBe(items);
    expect(appendResponsesWorkspaceContextTail([], "context")).toEqual([]);
  });

  it("never mutates the input array", () => {
    const items = [{ type: "message", role: "user", content: "hi" }];
    const snapshot = JSON.stringify(items);
    appendResponsesWorkspaceContextTail(items, "context");
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

describe("normalizeResponsesStopReason", () => {
  it("maps a completed response with no tool calls to end_turn", () => {
    expect(normalizeResponsesStopReason({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })).toBe("end_turn");
  });

  it("maps a function_call output to tool_use regardless of status wording", () => {
    expect(normalizeResponsesStopReason({ status: "completed", output: [{ type: "function_call", call_id: "c1", name: "x", arguments: "{}" }] })).toBe("tool_use");
  });

  it("maps incomplete/max_output_tokens to max_tokens", () => {
    expect(normalizeResponsesStopReason({ status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } })).toBe("max_tokens");
  });

  it("maps incomplete/content_filter to refusal", () => {
    expect(normalizeResponsesStopReason({ status: "incomplete", output: [], incomplete_details: { reason: "content_filter" } })).toBe("refusal");
  });

  it("maps a message content part of type refusal to refusal even when status is completed", () => {
    const resp = { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] };
    expect(normalizeResponsesStopReason(resp)).toBe("refusal");
  });

  it("maps cancelled to cancelled", () => {
    expect(normalizeResponsesStopReason({ status: "cancelled", output: [] })).toBe("cancelled");
  });

  it("fails open into protocol_violation for an unrecognized status or incomplete reason", () => {
    expect(normalizeResponsesStopReason({ status: "weird_future_status", output: [] })).toBe("protocol_violation");
    expect(normalizeResponsesStopReason({ status: "incomplete", output: [], incomplete_details: { reason: "something_new" } })).toBe("protocol_violation");
  });

  it("prioritizes tool_use over an incidental refusal-shaped message elsewhere in output", () => {
    // A turn that both made a tool call and (oddly) carries a refusal-typed part should still
    // resolve as tool_use — matches the same priority the Anthropic/Chat-Completions paths use.
    const resp = {
      status: "completed",
      output: [
        { type: "function_call", call_id: "c1", name: "x", arguments: "{}" },
        { type: "message", content: [{ type: "refusal", refusal: "partial" }] },
      ],
    };
    expect(normalizeResponsesStopReason(resp)).toBe("tool_use");
  });
});
