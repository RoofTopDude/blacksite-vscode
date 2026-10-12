import { afterEach, describe, expect, it, vi } from "vitest";
import { completeText } from "@blacksite-agent/llm";
import * as bedrockClient from "../src/bedrock-client.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const IMAGE = { mediaType: "image/png", data: "AAAA" };

function sent(fetchMock: ReturnType<typeof vi.fn>): { url: string; headers: Record<string, string>; body: unknown } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
}

describe("completeText", () => {
  it("sends Anthropic a plain Messages request and returns the first text block", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: " verdict " }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const text = await completeText({ provider: "anthropic", model: "claude-haiku-4-5", maxTokens: 512, systemPrompt: "S", userPrompt: "U", image: IMAGE, apiKey: "k" });
    expect(text).toBe("verdict");
    expect(sent(fetchMock)).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "anthropic-version": "2023-06-01", "x-api-key": "k", "content-type": "application/json" },
      body: {
        model: "claude-haiku-4-5",
        max_tokens: 512,
        system: "S",
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "U" }] }],
      },
    });
  });

  it("sends OpenRouter Chat Completions with attribution headers", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await completeText({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6", maxTokens: 256, systemPrompt: "S", userPrompt: "U", apiKey: "k" });
    expect(sent(fetchMock)).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: { "Authorization": "Bearer k", "content-type": "application/json", "HTTP-Referer": "https://blacksite.dev", "X-Title": "Blacksite" },
      body: { model: "anthropic/claude-sonnet-4.6", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], max_tokens: 256 },
    });
  });

  it("uses max_completion_tokens and the effort for direct OpenAI reasoning models", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await completeText({ provider: "openai", model: "o4-mini", maxTokens: 256, systemPrompt: "S", userPrompt: "U", apiKey: "k", reasoningEffort: "low" });
    expect(sent(fetchMock).body).toEqual({ model: "o4-mini", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], max_completion_tokens: 256, reasoning_effort: "low" });
  });

  it("goes through Converse or Mantle on Bedrock", async () => {
    const creds = { region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" };
    const converse = vi.spyOn(bedrockClient, "converseBedrock").mockResolvedValue({ output: { message: { content: [{ text: "a" }, { text: "b" }] } } } as never);
    expect(await completeText({ provider: "bedrock", model: "m", maxTokens: 64, systemPrompt: "S", userPrompt: "U", bedrock: creds })).toBe("a\n\nb");
    expect(converse.mock.calls[0]![0]).toMatchObject({ modelId: "m", systemPrompt: "S", maxTokens: 64, messages: [{ role: "user", content: [{ text: "U" }] }] });
    const mantle = vi.spyOn(bedrockClient, "mantleMessage").mockResolvedValue({ content: [{ type: "text", text: " m " }] } as never);
    expect(await completeText({ provider: "bedrock", bedrockApi: "mantle", model: "m", maxTokens: 64, systemPrompt: "S", userPrompt: "U", bedrock: creds })).toBe("m");
    expect(mantle.mock.calls[0]![0]).toMatchObject({ model: "m", system: "S", maxTokens: 64, messages: [{ role: "user", content: "U" }] });
  });

  it("refuses to send without a credential", async () => {
    await expect(completeText({ provider: "anthropic", model: "m", maxTokens: 1, systemPrompt: "", userPrompt: "" })).rejects.toThrow("No API key configured for anthropic.");
    await expect(completeText({ provider: "bedrock", model: "m", maxTokens: 1, systemPrompt: "", userPrompt: "" })).rejects.toThrow("No AWS credentials configured for Bedrock.");
  });
});
