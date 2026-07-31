import { describe, expect, it } from "vitest";
import {
  toBedrockMessages,
  toBedrockTools,
  withBedrockRollingCacheBreakpoint,
  withBedrockToolsCacheBreakpoint,
  isBedrockCacheValidationError,
  bedrockStreamFrameError,
  anthropicStreamError,
  openAIStreamError,
  responsesStreamError,
} from "../../src/agent-session.js";
import { isRetryableError } from "../../src/provider-retry.js";
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

  /**
   * This test used to assert `content: [{ text: "" }]` — i.e. it pinned the bug in place. A
   * *blank* text block is exactly what Converse rejects
   * (`ValidationException: The text field in the ContentBlock object at messages.N.content.0 is
   * blank`), so the "guard" against an empty content array was trading one fatal shape for
   * another. The fallback must be non-blank.
   */
  it("substitutes a non-blank placeholder when every block is dropped — a blank text block is a 400", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "old unsigned thought" }] },
    ];
    const [msg] = toBedrockMessages(messages);
    expect(msg!.content).toHaveLength(1);
    const block = msg!.content[0] as { text: string };
    expect(block.text.trim().length).toBeGreaterThan(0);
  });

  it("never emits a blank text block for a contentless assistant turn", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: [] }];
    const [msg] = toBedrockMessages(messages);
    const block = msg!.content[0] as { text: string };
    expect(block.text.trim().length).toBeGreaterThan(0);
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
 * Bedrock ConverseStream failure frames (throttling, internal server error, validation, model
 * overload, …) arrive tagged via the `:exception-type` header — a normal-looking protocol frame,
 * not an HTTP error.
 *
 * This is the single biggest reason Bedrock ran less reliably than every other provider: the
 * other providers surface a throttle as a pre-stream 429 that `_fetchWithRetry` absorbs, while
 * AWS delivers it *inside* an already-200 stream, past that retry window. The frame is now
 * classified into a ProviderStreamError carrying a `retryable` flag, so a throttle re-enters the
 * same backoff cycle as any other transient failure instead of ending the run.
 */
describe("bedrockStreamFrameError", () => {
  it("classifies a known exception-type frame and includes the payload's message", () => {
    const err = bedrockStreamFrameError("throttlingException", { message: "Too many requests, please wait." });
    expect(err?.message).toBe("Bedrock stream error (throttlingException): Too many requests, please wait.");
  });

  it("covers every documented Bedrock ConverseStream exception type", () => {
    for (const eventType of [
      "internalServerException", "modelStreamErrorException", "validationException",
      "throttlingException", "serviceUnavailableException", "modelTimeoutException",
      "modelNotReadyException", "resourceNotFoundException", "accessDeniedException",
    ]) {
      expect(bedrockStreamFrameError(eventType, {})?.message).toContain(eventType);
    }
  });

  it("marks transient AWS failures retryable — the whole point of the classification", () => {
    for (const eventType of [
      "throttlingException", "internalServerException", "serviceUnavailableException",
      "modelTimeoutException", "modelStreamErrorException", "modelNotReadyException",
    ]) {
      const err = bedrockStreamFrameError(eventType, {})!;
      expect(err.retryable, eventType).toBe(true);
      // The retry loop asks isRetryableError, not the flag directly — assert the wiring too.
      expect(isRetryableError(err), eventType).toBe(true);
    }
  });

  it("does NOT retry a broken request — replaying it can only reproduce the failure", () => {
    for (const eventType of ["validationException", "resourceNotFoundException", "accessDeniedException"]) {
      const err = bedrockStreamFrameError(eventType, {})!;
      expect(err.retryable, eventType).toBe(false);
      expect(isRetryableError(err), eventType).toBe(false);
    }
  });

  it("falls back to the eventType itself when the frame carries no message field", () => {
    expect(bedrockStreamFrameError("validationException", {})?.message)
      .toBe("Bedrock stream error (validationException): validationException");
  });

  it("returns null for a normal content frame — never throws on legitimate streaming", () => {
    expect(bedrockStreamFrameError("contentBlockDelta", { delta: { text: "hi" } })).toBeNull();
    expect(bedrockStreamFrameError("messageStop", { stopReason: "end_turn" })).toBeNull();
    expect(bedrockStreamFrameError("metadata", { usage: {} })).toBeNull();
  });
});

/**
 * The identical defect class on the Anthropic-direct / Bedrock-Mantle SSE path (both share
 * _parseAnthropicSSE): a mid-stream `{"type":"error","error":{...}}` event. `overloaded_error` is
 * Anthropic's 529 — the exact failure the retry layer exists for, and it was fatal here.
 */
describe("anthropicStreamError", () => {
  it("formats the error type and message from a well-formed error event", () => {
    const err = anthropicStreamError({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    expect(err.message).toBe("Anthropic stream error (overloaded_error): Overloaded");
  });

  it("marks overload/api/rate-limit errors retryable", () => {
    for (const type of ["overloaded_error", "api_error", "rate_limit_error", "timeout_error"]) {
      const err = anthropicStreamError({ type: "error", error: { type } });
      expect(err.retryable, type).toBe(true);
      expect(isRetryableError(err), type).toBe(true);
    }
  });

  it("does not retry a request-shape error", () => {
    for (const type of ["invalid_request_error", "authentication_error", "permission_error"]) {
      const err = anthropicStreamError({ type: "error", error: { type } });
      expect(err.retryable, type).toBe(false);
    }
  });

  it("falls back to sensible defaults when the error event is malformed", () => {
    expect(anthropicStreamError({ type: "error" }).message).toBe("Anthropic stream error (unknown_error): Anthropic reported a stream error.");
    expect(anthropicStreamError({ type: "error", error: {} }).message).toBe("Anthropic stream error (unknown_error): Anthropic reported a stream error.");
  });

  it("treats an unrecognised error type as fatal rather than retrying blindly", () => {
    expect(anthropicStreamError({ type: "error", error: { type: "some_new_error" } }).retryable).toBe(false);
  });
});

/**
 * Same defect class on the OpenAI-compatible SSE path: OpenRouter (and some gateways) send a
 * mid-stream `{"error":{...}}` chunk with no `choices` after the HTTP response already streamed
 * 200 + partial content. Retryability comes from the chunk's own `code`, which carries the
 * upstream HTTP status.
 */
describe("openAIStreamError", () => {
  it("extracts the message from an object-shaped error chunk", () => {
    expect(openAIStreamError({ error: { message: "Rate limit exceeded", code: 429 } })?.message).toBe("Rate limit exceeded");
  });

  it("reads retryability from the upstream status code", () => {
    expect(openAIStreamError({ error: { message: "rate limited", code: 429 } })?.retryable).toBe(true);
    expect(openAIStreamError({ error: { message: "bad gateway", code: 502 } })?.retryable).toBe(true);
    expect(openAIStreamError({ error: { message: "overloaded", code: "503" } })?.retryable).toBe(true);
    expect(openAIStreamError({ error: { message: "bad request", code: 400 } })?.retryable).toBe(false);
    expect(openAIStreamError({ error: { message: "no key", code: 401 } })?.retryable).toBe(false);
  });

  it("treats an error with no recognisable status as fatal", () => {
    expect(openAIStreamError({ error: { message: "something went wrong" } })?.retryable).toBe(false);
    expect(openAIStreamError({ error: "upstream provider unavailable" })?.retryable).toBe(false);
  });

  it("stringifies an error object with no message field", () => {
    expect(openAIStreamError({ error: { code: 500 } })?.message).toBe(JSON.stringify({ code: 500 }));
  });

  it("passes through a bare string error", () => {
    expect(openAIStreamError({ error: "upstream provider unavailable" })?.message).toBe("upstream provider unavailable");
  });

  it("returns null when there is no error field — never flags a normal chunk", () => {
    expect(openAIStreamError({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(openAIStreamError({ usage: { prompt_tokens: 10 } })).toBeNull();
  });
});

/**
 * The same defect class again on the OpenAI Responses path, where it was worst: this endpoint's
 * `error` event carries a *symbolic string* code ("server_error"), and the old inline classifier
 * pushed it through `Number()` before `isRetryableStatus`. Every real error event therefore scored
 * NaN → fatal, so a flex-tier backend blip ended a long agent run outright, reported as a bare
 * "OpenAI Responses stream error" with the provider's actual message dropped.
 */
describe("responsesStreamError", () => {
  it("retries the symbolic codes a healthy request gets from an unhealthy backend", () => {
    for (const code of ["server_error", "rate_limit_exceeded", "service_unavailable", "slow_down", "timeout"]) {
      const err = responsesStreamError({ type: "error", code, message: "upstream hiccup" });
      expect(err.retryable, code).toBe(true);
      expect(isRetryableError(err), code).toBe(true);
    }
  });

  it("keeps the provider's own message and code instead of a bare placeholder", () => {
    const err = responsesStreamError({ type: "error", code: "server_error", message: "The server had an error." });
    expect(err.message).toBe("OpenAI Responses stream error (server_error): The server had an error.");
  });

  it("reads the nested {error:{...}} shape proxies send, not just the documented flat one", () => {
    const err = responsesStreamError({ type: "error", error: { type: "server_error", message: "Backend unavailable" } });
    expect(err.message).toBe("OpenAI Responses stream error (server_error): Backend unavailable");
    expect(err.retryable).toBe(true);
  });

  it("still honours a numeric status when one is present", () => {
    expect(responsesStreamError({ type: "error", code: 429, message: "slow down" }).retryable).toBe(true);
    expect(responsesStreamError({ type: "error", code: 503, message: "unavailable" }).retryable).toBe(true);
    expect(responsesStreamError({ type: "error", code: 400, message: "bad request" }).retryable).toBe(false);
    expect(responsesStreamError({ type: "error", code: 401, message: "no key" }).retryable).toBe(false);
  });

  it("does not retry a broken request, which would fail identically every attempt", () => {
    for (
      const code of [
        "invalid_request_error",
        "invalid_prompt",
        "unsupported_parameter",
        "model_not_found",
        "insufficient_quota",
        "context_length_exceeded",
      ]
    ) {
      expect(responsesStreamError({ type: "error", code, message: "nope" }).retryable, code).toBe(false);
    }
  });

  /**
   * Inverted relative to openAIStreamError on purpose — see the classifier's doc comment. A
   * request that reaches this event has already cleared validation (a bad one is rejected with a
   * pre-stream 400), so an unrecognised post-200 failure is far more likely backend-side.
   */
  it("retries an unrecognised code rather than ending the run on it", () => {
    expect(responsesStreamError({ type: "error", code: "some_new_transient_code", message: "?" }).retryable).toBe(true);
    expect(responsesStreamError({ type: "error", message: "no code at all" }).retryable).toBe(true);
  });

  it("degrades to a usable message when the event carries no payload at all", () => {
    expect(responsesStreamError({ type: "error" }).message)
      .toBe("OpenAI Responses stream error (unknown_error): OpenAI reported a stream error.");
  });

  it("classifies a response.failed object, which shares the error payload", () => {
    const failed = { status: "failed", error: { code: "server_error", message: "generation failed" } };
    const err = responsesStreamError(failed);
    expect(err.message).toBe("OpenAI Responses stream error (server_error): generation failed");
    expect(err.retryable).toBe(true);
  });
});
