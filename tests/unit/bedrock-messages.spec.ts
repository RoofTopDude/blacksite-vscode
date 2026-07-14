import { describe, expect, it } from "vitest";
import {
  toBedrockMessages,
  toBedrockTools,
  withBedrockRollingCacheBreakpoint,
  withBedrockToolsCacheBreakpoint,
  isBedrockCacheValidationError,
  bedrockStreamFrameErrorMessage,
  anthropicStreamErrorMessage,
  openAIStreamErrorMessage,
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

  it("replays a signed thinking block verbatim for the next Converse turn", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "carefully reasoned", signature: "aws-signed-token" }] },
    ];
    expect(toBedrockMessages(messages)).toEqual([
      { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "carefully reasoned", signature: "aws-signed-token" } } }] },
    ]);
  });

  it("does not replay a legacy unsigned thinking block that Converse would reject", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "old unsigned thought" }] },
    ];
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

/**
 * Regression coverage for a real bug: Bedrock ConverseStream failure frames (throttling,
 * internal server error, validation, model overload, …) arrive tagged via the
 * `:exception-type` header — a normal-looking protocol frame, not an HTTP error. The
 * streaming switch previously had no case for them: the frame was silently dropped, the
 * stream ended right after with no messageStop, and the turn completed as an
 * apparently-successful but silently EMPTY end_turn. bedrockStreamFrameErrorMessage is the
 * classification the switch's default case now throws on.
 */
describe("bedrockStreamFrameErrorMessage", () => {
  it("classifies a known exception-type frame and includes the payload's message", () => {
    const msg = bedrockStreamFrameErrorMessage("throttlingException", { message: "Too many requests, please wait." });
    expect(msg).toBe("Bedrock stream error (throttlingException): Too many requests, please wait.");
  });

  it("covers every documented Bedrock ConverseStream exception type", () => {
    for (const eventType of [
      "internalServerException", "modelStreamErrorException", "validationException",
      "throttlingException", "serviceUnavailableException", "modelTimeoutException",
      "modelNotReadyException", "resourceNotFoundException", "accessDeniedException",
    ]) {
      expect(bedrockStreamFrameErrorMessage(eventType, {})).toContain(eventType);
    }
  });

  it("falls back to the eventType itself when the frame carries no message field", () => {
    const msg = bedrockStreamFrameErrorMessage("validationException", {});
    expect(msg).toBe("Bedrock stream error (validationException): validationException");
  });

  it("returns null for a normal content frame — never throws on legitimate streaming", () => {
    expect(bedrockStreamFrameErrorMessage("contentBlockDelta", { delta: { text: "hi" } })).toBeNull();
    expect(bedrockStreamFrameErrorMessage("messageStop", { stopReason: "end_turn" })).toBeNull();
    expect(bedrockStreamFrameErrorMessage("metadata", { usage: {} })).toBeNull();
  });
});

/**
 * Regression coverage for the identical defect on the Anthropic-direct / Bedrock-Mantle SSE
 * path (both share _parseAnthropicSSE): a mid-stream `{"type":"error","error":{...}}` event
 * (overloaded_error, api_error, …) previously matched none of the parser's branches and was
 * silently dropped — the turn completed as if it had ended cleanly with whatever partial
 * text/thinking had streamed so far, sometimes nothing at all.
 */
describe("anthropicStreamErrorMessage", () => {
  it("formats the error type and message from a well-formed error event", () => {
    const msg = anthropicStreamErrorMessage({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    expect(msg).toBe("Anthropic stream error (overloaded_error): Overloaded");
  });

  it("falls back to sensible defaults when the error event is malformed", () => {
    expect(anthropicStreamErrorMessage({ type: "error" })).toBe("Anthropic stream error (unknown_error): Anthropic reported a stream error.");
    expect(anthropicStreamErrorMessage({ type: "error", error: {} })).toBe("Anthropic stream error (unknown_error): Anthropic reported a stream error.");
  });
});

/**
 * Regression coverage for the same defect class on the OpenAI-compatible SSE path: OpenRouter
 * (and some gateways) can send a mid-stream `{"error":{...}}` chunk with no `choices` after
 * the HTTP response already streamed 200 + partial content. `if (!choices?.length) continue`
 * previously skipped it silently instead of surfacing the failure.
 */
describe("openAIStreamErrorMessage", () => {
  it("extracts the message from an object-shaped error chunk", () => {
    expect(openAIStreamErrorMessage({ error: { message: "Rate limit exceeded", code: 429 } })).toBe("Rate limit exceeded");
  });

  it("stringifies an error object with no message field", () => {
    expect(openAIStreamErrorMessage({ error: { code: 500 } })).toBe(JSON.stringify({ code: 500 }));
  });

  it("passes through a bare string error", () => {
    expect(openAIStreamErrorMessage({ error: "upstream provider unavailable" })).toBe("upstream provider unavailable");
  });

  it("returns null when there is no error field — never flags a normal chunk", () => {
    expect(openAIStreamErrorMessage({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(openAIStreamErrorMessage({ usage: { prompt_tokens: 10 } })).toBeNull();
  });
});
