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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
