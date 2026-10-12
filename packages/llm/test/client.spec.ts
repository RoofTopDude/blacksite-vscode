import { afterEach, describe, expect, it, vi } from "vitest";
import {
  complete,
  createModelClient,
  hostedSearchRouteFor,
  modelRouteFor,
  planThinking,
  subscriptionTransport,
  type ModelRequest,
  type ProviderTurnStreamEvent,
  type SubscriptionRequest,
} from "@blacksite-agent/llm";
import { anthropicTextTurn } from "@blacksite-agent/llm/testing";

afterEach(() => { vi.unstubAllGlobals(); });

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "claude-sonnet-4-6",
    system: "You are terse.",
    systemSummary: "",
    contextTail: "",
    messages: [{ role: "user", content: "hi" }],
    tools: { wire: [], deferred: new Set() },
    thinking: planThinking({ model: "claude-sonnet-4-6", provider: "anthropic", configuredMaxTokens: 1024, ceiling: null, thinkingEnabled: false, budgetTokens: 0, effort: undefined, temperature: undefined }),
    conversationId: "conv-1",
    turnIndex: 0,
    ...overrides,
  };
}

async function drain(stream: AsyncGenerator<ProviderTurnStreamEvent>): Promise<ProviderTurnStreamEvent[]> {
  const events: ProviderTurnStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("modelRouteFor", () => {
  it("picks the wire format from the provider, the Bedrock API and the model", () => {
    expect(modelRouteFor({ provider: "anthropic" }, "claude-sonnet-4-6")).toBe("anthropic");
    expect(modelRouteFor({ provider: "bedrock" }, "x")).toBe("bedrock-converse");
    expect(modelRouteFor({ provider: "bedrock", bedrockApi: "mantle" }, "x")).toBe("bedrock-mantle");
    expect(modelRouteFor({ provider: "openrouter" }, "o4-mini")).toBe("openai-chat");
    expect(modelRouteFor({ provider: "openai" }, "o4-mini")).toBe("openai-chat");
    expect(modelRouteFor({ provider: "openai", useResponsesApi: true }, "o4-mini")).toBe("openai-responses");
    // The Responses API is only for reasoning models; others stay on Chat Completions.
    expect(modelRouteFor({ provider: "openai", useResponsesApi: true }, "gpt-4.1")).toBe("openai-chat");
  });
});

describe("hostedSearchRouteFor", () => {
  it("offers the provider's search only on its own endpoint", () => {
    expect(hostedSearchRouteFor({ provider: "anthropic" })).toEqual({ provider: "anthropic", label: "Claude" });
    expect(hostedSearchRouteFor({ provider: "anthropic", baseUrl: "https://gateway.example/v1/messages" })).toBeUndefined();
    expect(hostedSearchRouteFor({ provider: "openrouter" })).toEqual({ provider: "openrouter", label: "OpenRouter" });
    expect(hostedSearchRouteFor({ provider: "bedrock" })).toBeUndefined();
    expect(subscriptionTransport(async function* () { /* never called */ }).hostedSearchRoute).toEqual({ provider: "chatgpt", label: "ChatGPT" });
  });
});

describe("ModelClient", () => {
  it("asks a credential function for the key on every request", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: anthropicTextTurn("Hello") }));
    vi.stubGlobal("fetch", fetchMock);
    let issued = 0;
    const client = createModelClient({ provider: "anthropic", apiKey: async () => `key-${++issued}` });
    await drain(client.stream(request()));
    await drain(client.stream(request()));
    const keys = fetchMock.mock.calls.map((call) => ((call as unknown[])[1] as RequestInit).headers as Record<string, string>).map((h) => h["x-api-key"]);
    expect(keys).toEqual(["key-1", "key-2"]);
  });

  it("keeps what it learns about the endpoint per client, not across clients", async () => {
    const rejectStrict = { ok: false, status: 400, text: async () => "tools.0.strict: not supported", body: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejectStrict)
      .mockImplementation(async () => ({ ok: true, status: 200, body: anthropicTextTurn("ok") }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = { wire: [{ name: "read", description: "Read a file", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } }], deferred: new Set<string>() };
    const first = createModelClient({ provider: "anthropic", apiKey: "k" });
    const events = await drain(first.stream(request({ tools })));
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", message: expect.stringContaining("Strict tool schemas were rejected") }));
    expect(first.latches.strictToolsUnsupported).toBe(true);
    expect(createModelClient({ provider: "anthropic", apiKey: "k" }).latches.strictToolsUnsupported).toBe(false);
  });
});

describe("subscriptionTransport", () => {
  it("maps a request onto the subscription shape, Codex tier names included", async () => {
    const seen: SubscriptionRequest[] = [];
    const transport = subscriptionTransport(async function* (req) {
      seen.push(req);
      yield { type: "stop_reason", reason: "end_turn" };
    }, { reasoningEffort: "high", serviceTier: "fast" });
    await drain(transport.stream(request({ systemSummary: "Earlier: a refactor.", contextTail: "<ctx/>" })));
    expect(seen[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      systemPrompt: "You are terse.\n\n[COMPRESSED CONVERSATION HISTORY]\nEarlier: a refactor.",
      contextTail: "<ctx/>",
      conversationId: "conv-1",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  });
});

describe("complete", () => {
  it("returns one finished turn from any transport", async () => {
    const result = await complete({
      async *stream() {
        yield { type: "text_delta", text: "Hi" } as const;
        yield { type: "stop_reason", reason: "end_turn" } as const;
      },
    }, request());
    expect(result).toMatchObject({ text: "Hi", stopReason: "end_turn", toolCalls: [], empty: false });
  });
});
