import { describe, expect, it } from "vitest";
import {
  toBedrockMessages,
  toBedrockTools,
  withBedrockRollingCacheBreakpoint,
  withBedrockToolsCacheBreakpoint,
  isBedrockCacheValidationError,
} from "../../src/agent-session.js";
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

describe("withBedrockRollingCacheBreakpoint", () => {
  it("appends a cachePoint block to only the final message", () => {
    const messages = toBedrockMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
    const out = withBedrockRollingCacheBreakpoint(messages);
    expect(out[0]!.content).toEqual([{ text: "first" }]);
    expect(out[1]!.content).toEqual([{ text: "second" }, { cachePoint: { type: "default" } }]);
  });

  it("is a no-op on an empty message list", () => {
    expect(withBedrockRollingCacheBreakpoint([])).toEqual([]);
  });
});

describe("withBedrockToolsCacheBreakpoint", () => {
  it("appends a cachePoint entry after the tool list", () => {
    const tools = toBedrockTools([
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: {} } } as ToolDefinition,
    ]);
    expect(withBedrockToolsCacheBreakpoint(tools)).toEqual([
      ...tools,
      { cachePoint: { type: "default" } },
    ]);
  });

  it("is a no-op on an empty tool list", () => {
    expect(withBedrockToolsCacheBreakpoint([])).toEqual([]);
  });
});

describe("isBedrockCacheValidationError", () => {
  it("matches a 400 validation error mentioning cache", () => {
    expect(isBedrockCacheValidationError(new Error("Bedrock 400: cachePoint is not supported for this model"))).toBe(true);
  });

  it("matches a 422 validation error mentioning cache case-insensitively", () => {
    expect(isBedrockCacheValidationError(new Error("Bedrock 422: Cache checkpoints are not enabled for this account"))).toBe(true);
  });

  it("does not match a cache-unrelated 400 error", () => {
    expect(isBedrockCacheValidationError(new Error("Bedrock 400: max_tokens must be positive"))).toBe(false);
  });

  it("does not match an auth error even if not client-side", () => {
    expect(isBedrockCacheValidationError(new Error("Bedrock 403: The security token included in the request is invalid"))).toBe(false);
  });

  it("does not match a 5xx server error mentioning cache", () => {
    expect(isBedrockCacheValidationError(new Error("Bedrock 500: internal error while reading cache"))).toBe(false);
  });

  it("handles non-Error thrown values", () => {
    expect(isBedrockCacheValidationError("Bedrock 400: cache not supported")).toBe(true);
    expect(isBedrockCacheValidationError({ weird: true })).toBe(false);
  });
});
