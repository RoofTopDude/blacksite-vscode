import { describe, expect, it } from "vitest";
import { toBedrockMessages, toBedrockTools } from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";
import type { ToolDefinition } from "../../src/tools/definitions.js";

describe("toBedrockMessages", () => {
  it("converts a plain string user message", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hello" }];
    expect(toBedrockMessages(messages)).toEqual([
      { role: "user", content: [{ text: "hello" }] },
    ]);
  });

  it("converts assistant text + tool_use blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    expect(toBedrockMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { text: "let me check" },
          { toolUse: { toolUseId: "tu_1", name: "read_file", input: { path: "a.ts" } } },
        ],
      },
    ]);
  });

  it("converts tool_result blocks into a user toolResult", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body" }] },
    ];
    expect(toBedrockMessages(messages)).toEqual([
      {
        role: "user",
        content: [{ toolResult: { toolUseId: "tu_1", content: [{ text: "file body" }] } }],
      },
    ]);
  });

  it("drops thinking blocks and keeps a non-empty content array", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }] },
    ];
    // All real content was a thinking block (dropped) — must still emit ≥1 block.
    expect(toBedrockMessages(messages)).toEqual([
      { role: "assistant", content: [{ text: "" }] },
    ]);
  });

  it("filters empty text blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool_use", id: "tu_9", name: "noop", input: {} },
        ],
      },
    ];
    expect(toBedrockMessages(messages)).toEqual([
      { role: "assistant", content: [{ toolUse: { toolUseId: "tu_9", name: "noop", input: {} } }] },
    ]);
  });
});

describe("toBedrockTools", () => {
  it("maps tool definitions into Bedrock toolSpec form", () => {
    const tools: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      } as ToolDefinition,
    ];
    expect(toBedrockTools(tools)).toEqual([
      {
        toolSpec: {
          name: "read_file",
          description: "Read a file",
          inputSchema: { json: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        },
      },
    ]);
  });
});
