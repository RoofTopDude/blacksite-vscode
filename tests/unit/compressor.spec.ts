import { afterEach, describe, expect, it, vi } from "vitest";
import { compressHistory, type CompressorOptions } from "../../src/compressor.js";
import * as bedrockClient from "../../src/bedrock-client.js";

const VALID_SUMMARY = JSON.stringify({
  compressionMeta: { messageCount: 2, version: 1 },
  objective: "test",
  status: "in_progress",
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response);
}

const MESSAGES = [
  { role: "user" as const, content: "please fix the bug" },
  {
    role: "assistant" as const,
    content: [
      { type: "text", text: "looking into it" },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file contents" },
      { type: "thinking", thinking: "considering approaches" },
    ],
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compression deadlines and unusable responses", () => {
  const opts: CompressorOptions = { apiKey: "k", model: "slow-model", provider: "openrouter" };

  function mockTimeouts(): void {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
  }

  it("allows a long summary to finish after the old 60-second deadline", async () => {
    mockTimeouts();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      setTimeout(() => resolve(jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] })), 90_000);
    })));
    const pending = compressHistory(opts, MESSAGES);
    const result = expect(pending).resolves.toBe(VALID_SUMMARY);
    await vi.advanceTimersByTimeAsync(90_000);
    await result;
  });

  it("bounds the entire retry sequence and reports the provider/model on timeout", async () => {
    mockTimeouts();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
      signals.push(init.signal!);
      if (signals.length === 1) return jsonResponse("busy", false, 503);
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }));
    const pending = compressHistory(opts, MESSAGES);
    const result = expect(pending).rejects.toMatchObject({ name: "TimeoutError", message: expect.stringMatching(/openrouter \/ slow-model.*Timed out after 300s/) });
    await vi.advanceTimersByTimeAsync(300_000);
    await result;
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it.each([
    { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: VALID_SUMMARY }, finish_reason: "length" }] },
    { content: [{ type: "text", text: " " }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: VALID_SUMMARY }], stop_reason: "max_tokens" },
  ])("rejects empty or truncated output before history can be discarded: %j", async (body) => {
    const fetchMock = vi.fn(() => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(compressHistory({ ...opts, provider: "content" in body ? "anthropic" : "openrouter" }, MESSAGES))
      .rejects.toThrow(/empty summary|output token limit/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a provider error returned inside HTTP 200 instead of accepting an empty summary", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ error: { code: 401, message: "User not found." } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(compressHistory(opts, MESSAGES)).rejects.toMatchObject({ status: 401, message: expect.stringContaining("User not found.") });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("compressHistory — anthropic", () => {
  const opts: CompressorOptions = { apiKey: "k", model: "claude-x", provider: "anthropic" };

  it("posts to the Anthropic messages endpoint and returns the validated JSON summary", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ content: [{ type: "text", text: VALID_SUMMARY }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await compressHistory(opts, MESSAGES);
    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-x");
    // the serialized transcript should carry every block type through
    expect(body.messages[0].content).toContain("please fix the bug");
    expect(body.messages[0].content).toContain("[tool_call:read_file]");
    // Results are labelled with the tool that produced them, resolved from the tool_use id —
    // the summariser needs the name to apply the "never drop a question_card answer" rule.
    expect(body.messages[0].content).toContain("[tool_result:read_file] file contents");
    expect(body.messages[0].content).toContain("[thinking] considering approaches");
  });

  it("honors a custom baseUrl", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ content: [{ type: "text", text: VALID_SUMMARY }] }));
    vi.stubGlobal("fetch", fetchMock);
    await compressHistory({ ...opts, baseUrl: "https://proxy.example/v1/messages" }, MESSAGES);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/v1/messages");
  });
});

describe("compressHistory — openai / openrouter", () => {
  it("posts to the chat completions endpoint for openai", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await compressHistory({ apiKey: "k", model: "gpt-x", provider: "openai" }, MESSAGES);
    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("adds OpenRouter-specific headers and endpoint", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await compressHistory({ apiKey: "k", model: "m", provider: "openrouter" }, MESSAGES);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>)["HTTP-Referer"]).toBe("https://blacksite.dev");
  });

  /** Direct OpenAI's reasoning-tier models (o1/o3/o4, gpt-5+) reject `max_tokens` outright and
   *  require `max_completion_tokens` instead — this used to be hardcoded to max_tokens
   *  unconditionally, 400ing every background compaction pass against one of these models. */
  it("sends max_completion_tokens (not max_tokens) for a direct-OpenAI reasoning model", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await compressHistory({ apiKey: "k", model: "gpt-5.2", provider: "openai" }, MESSAGES);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_tokens).toBeUndefined();
  });

  it("still sends max_tokens for a direct-OpenAI non-reasoning model", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await compressHistory({ apiKey: "k", model: "gpt-4o", provider: "openai" }, MESSAGES);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  /** OpenRouter normalizes this quirk for whatever it routes to, so a reasoning-family model id
   *  routed *through* OpenRouter must keep sending max_tokens — only the direct OpenAI provider
   *  needs the substitution. Regression guard against gating on model id alone. */
  it("still sends max_tokens for a reasoning-family model routed through OpenRouter", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await compressHistory({ apiKey: "k", model: "openai/gpt-5.2", provider: "openrouter" }, MESSAGES);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("compressHistory — bedrock", () => {
  const CREDS = { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s" };

  it("throws when bedrock credentials are missing", async () => {
    await expect(compressHistory({ apiKey: "", model: "m", provider: "bedrock" }, MESSAGES))
      .rejects.toThrow("Bedrock compression requires AWS credentials");
  });

  it("uses converseBedrock by default", async () => {
    const spy = vi.spyOn(bedrockClient, "converseBedrock").mockResolvedValue({
      output: { message: { content: [{ text: VALID_SUMMARY }] } },
    } as unknown as Awaited<ReturnType<typeof bedrockClient.converseBedrock>>);

    const result = await compressHistory({ apiKey: "", model: "m", provider: "bedrock", bedrock: CREDS }, MESSAGES);
    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("uses mantleMessage when bedrockApi is 'mantle'", async () => {
    const spy = vi.spyOn(bedrockClient, "mantleMessage").mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
    } as unknown as Awaited<ReturnType<typeof bedrockClient.mantleMessage>>);

    const result = await compressHistory(
      { apiKey: "", model: "m", provider: "bedrock", bedrock: CREDS, bedrockApi: "mantle" },
      MESSAGES,
    );
    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("compressHistory — output validation / graceful degradation", () => {
  const opts: CompressorOptions = { apiKey: "k", model: "m", provider: "anthropic" };

  it("strips markdown code fences around the JSON object", async () => {
    const fenced = `Here is the summary:\n\`\`\`json\n${VALID_SUMMARY}\n\`\`\``;
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ content: [{ type: "text", text: fenced }] })));
    const result = await compressHistory(opts, MESSAGES);
    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));
  });

  it("falls back to the raw trimmed text when there is no JSON object at all", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ content: [{ type: "text", text: "  no json here  " }] })));
    const result = await compressHistory(opts, MESSAGES);
    expect(result).toBe("no json here");
  });

  it("falls back to the raw trimmed text when the extracted braces don't parse as JSON", async () => {
    const broken = 'prose that mentions {code} inline but is not itself JSON, and ends with a stray "}"';
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ content: [{ type: "text", text: broken }] })));
    const result = await compressHistory(opts, MESSAGES);
    expect(result).toBe(broken.trim());
  });

  it("propagates a non-retryable HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse("bad request", false, 400)));
    await expect(compressHistory(opts, MESSAGES)).rejects.toThrow(/Compression API error 400/);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls += 1;
      if (calls < 2) return jsonResponse("overloaded", false, 503);
      return jsonResponse({ content: [{ type: "text", text: VALID_SUMMARY }] });
    }));
    const result = await compressHistory(opts, MESSAGES);
    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));
    expect(calls).toBe(2);
  });
});
/* Compaction is a schema-filling call on a hard deadline with an 8k output budget. Reasoning
   spends both: thinking tokens are billed against the same max_tokens as the summary (so the
   JSON stops mid-structure and is discarded), and deep reasoning on a long transcript walks
   past the five-minute budget. Every provider therefore gets an explicit "off", because on
   several of them an absent field is not off — Sonnet 5 runs adaptive thinking when `thinking`
   is omitted entirely. */
describe("compressHistory — reasoning is switched off on every provider", () => {
  function anthropicBody(fetchMock: ReturnType<typeof vi.fn>) {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  function stubOk(shape: "anthropic" | "openai") {
    const body = shape === "anthropic"
      ? { content: [{ type: "text", text: VALID_SUMMARY }] }
      : { choices: [{ message: { content: VALID_SUMMARY } }] };
    const fetchMock = vi.fn(() => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("states thinking off explicitly for an adaptive-era Claude model", async () => {
    const fetchMock = stubOk("anthropic");
    await compressHistory({ apiKey: "k", model: "claude-sonnet-5", provider: "anthropic" }, MESSAGES);
    const body = anthropicBody(fetchMock);
    // Omitting the field would leave Sonnet 5 running adaptive thinking.
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("omits thinking for Fable, which cannot be turned off and 400s on {type:'disabled'}", async () => {
    const fetchMock = stubOk("anthropic");
    await compressHistory({ apiKey: "k", model: "claude-fable-5-1", provider: "anthropic" }, MESSAGES);
    const body = anthropicBody(fetchMock);
    expect(body.thinking).toBeUndefined();
    // Effort is the only lever left on this family, so it still has to be sent.
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("omits both fields for a budget-era model, which is off when thinking is absent and 400s on effort", async () => {
    const fetchMock = stubOk("anthropic");
    await compressHistory({ apiKey: "k", model: "claude-3-7-sonnet", provider: "anthropic" }, MESSAGES);
    const body = anthropicBody(fetchMock);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it.each([
    ["gpt-5.2", "none"],
    ["gpt-5", "minimal"],
    ["o3-mini", "low"],
  ])("asks direct OpenAI for the shallowest rung %s accepts (%s)", async (model, effort) => {
    const fetchMock = stubOk("openai");
    await compressHistory({ apiKey: "k", model, provider: "openai" }, MESSAGES);
    const body = anthropicBody(fetchMock);
    expect(body.reasoning_effort).toBe(effort);
  });

  it("sends no reasoning_effort to a non-reasoning OpenAI model, which rejects the field", async () => {
    const fetchMock = stubOk("openai");
    await compressHistory({ apiKey: "k", model: "gpt-4o", provider: "openai" }, MESSAGES);
    const body = anthropicBody(fetchMock);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it("uses OpenRouter's unified switch, which applies to whatever it routes to", async () => {
    const fetchMock = stubOk("openai");
    await compressHistory({ apiKey: "k", model: "anthropic/claude-sonnet-5", provider: "openrouter" }, MESSAGES);
    const body = anthropicBody(fetchMock);
    expect(body.reasoning).toEqual({ enabled: false });
    // OpenRouter has no reasoning_effort field; sending one alongside would be noise.
    expect(body.reasoning_effort).toBeUndefined();
  });

  /* OpenRouter refuses reasoning.enabled=false for models that always think (Gemini 2.5 Pro, the
     o-series). Before the fallback that 400 failed every compaction on those models, so the
     session never shed context. */
  it("retries without the off switch when OpenRouter says reasoning is mandatory", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => jsonResponse(
        { error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 } },
        false,
        400,
      ))
      .mockImplementationOnce(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await compressHistory({ apiKey: "k", model: "google/gemini-2.5-pro", provider: "openrouter" }, MESSAGES);

    expect(JSON.parse(result)).toEqual(JSON.parse(VALID_SUMMARY));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retried = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(retried.reasoning).toBeUndefined();
    expect(retried.max_tokens).toBe(8192);
  });

  it("retries direct OpenAI without reasoning_effort when the model rejects the rung", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => jsonResponse(
        { error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model." } },
        false,
        400,
      ))
      .mockImplementationOnce(() => jsonResponse({ choices: [{ message: { content: VALID_SUMMARY } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await compressHistory({ apiKey: "k", model: "gpt-5.9-pro", provider: "openai" }, MESSAGES);

    const retried = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(retried.reasoning_effort).toBeUndefined();
    // The retry must still use the parameter reasoning models require.
    expect(retried.max_completion_tokens).toBe(8192);
  });

  it("does not retry a 400 that has nothing to do with reasoning", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ error: { message: "context_length_exceeded" } }, false, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(compressHistory({ apiKey: "k", model: "google/gemini-2.5-pro", provider: "openrouter" }, MESSAGES))
      .rejects.toThrow(/context_length_exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes the off switch through Bedrock Converse", async () => {
    const spy = vi.spyOn(bedrockClient, "converseBedrock").mockResolvedValue({
      output: { message: { content: [{ text: VALID_SUMMARY }] } },
    } as unknown as Awaited<ReturnType<typeof bedrockClient.converseBedrock>>);

    await compressHistory({
      apiKey: "", model: "us.anthropic.claude-sonnet-5-v1:0", provider: "bedrock",
      bedrock: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s" },
    }, MESSAGES);

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ thinking: { type: "disabled" }, effort: "low" });
  });

  it("passes the off switch through Bedrock Mantle", async () => {
    const spy = vi.spyOn(bedrockClient, "mantleMessage").mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
    } as unknown as Awaited<ReturnType<typeof bedrockClient.mantleMessage>>);

    await compressHistory({
      apiKey: "", model: "anthropic.claude-opus-4-8", provider: "bedrock", bedrockApi: "mantle",
      bedrock: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s" },
    }, MESSAGES);

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ thinking: { type: "disabled" }, effort: "low" });
  });
});
