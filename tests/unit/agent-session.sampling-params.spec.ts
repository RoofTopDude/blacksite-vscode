/**
 * Coverage for sampling controls beyond temperature (top_p, top_k, penalties, seed …) on the
 * OpenAI-compatible request path, which is what OpenRouter uses.
 *
 * Drives a real AgentSession over a mocked wire and asserts the request body, so this pins
 * what is actually sent rather than the pure helper in isolation (that is covered by
 * sampling-parameters.spec.ts). The cases that matter are the two ways this can go wrong:
 * sending a parameter the routed model does not accept, and *failing* to send one the user
 * configured for a model that does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/agent-session.js";

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
}

/** The sampling surface a richly-parameterised OpenRouter model reports. */
const RICH_PARAMS = [
  "max_tokens", "temperature", "top_p", "top_k", "min_p",
  "repetition_penalty", "frequency_penalty", "presence_penalty", "seed", "tools",
];

function createSession(opts: {
  model?: string;
  sampling?: Record<string, number>;
  modelSupportedParameters?: string[];
}) {
  return new AgentSession({
    apiKey: "test-key",
    model: opts.model ?? "moonshotai/kimi-k2",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
    context: createFakeContext() as never,
    provider: "openrouter",
    sampling: opts.sampling,
    modelSupportedParameters: opts.modelSupportedParameters,
    maxIterations: 5,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

function sseSuccessStream(text: string): ReadableStream<Uint8Array> {
  const lines = [
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  ];
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

function successResponse(text: string) {
  return { ok: true, status: 200, headers: { get: () => null }, body: sseSuccessStream(text) };
}

async function bodyOfOneTurn(session: AgentSession): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn().mockResolvedValue(successResponse("done"));
  vi.stubGlobal("fetch", fetchMock);
  for await (const _event of session.send("hello")) { /* drain */ }
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

describe("OpenRouter sampling parameters", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends every configured control the routed model reports as supported", async () => {
    const body = await bodyOfOneTurn(createSession({
      sampling: { topP: 0.9, topK: 40, minP: 0.05, frequencyPenalty: 0.4, presencePenalty: 0.2, repetitionPenalty: 1.1, seed: 7 },
      modelSupportedParameters: RICH_PARAMS,
    }));

    expect(body).toMatchObject({
      top_p: 0.9, top_k: 40, min_p: 0.05,
      frequency_penalty: 0.4, presence_penalty: 0.2, repetition_penalty: 1.1, seed: 7,
    });
  });

  it("omits a configured control the routed model does not report", async () => {
    // top_k is set, but this model never advertised it — sending it would 400.
    const body = await bodyOfOneTurn(createSession({
      sampling: { topP: 0.9, topK: 40 },
      modelSupportedParameters: ["temperature", "top_p", "tools"],
    }));

    expect(body["top_p"]).toBe(0.9);
    expect(body).not.toHaveProperty("top_k");
  });

  it("sends nothing extra when no sampling controls are configured", async () => {
    const body = await bodyOfOneTurn(createSession({ modelSupportedParameters: RICH_PARAMS }));
    for (const wire of ["top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed"]) {
      expect(body, wire).not.toHaveProperty(wire);
    }
  });

  /* The regression that motivated gating the request path as well as the UI: these values are
     stored per provider, so switching to a model that rejects sampling parameters entirely
     would otherwise keep sending whatever the previous model was configured with — a 400 on
     every turn, with no control visible in the panel to explain why. */
  it("sends no sampling parameters at all to a modern Claude, which rejects them outright", async () => {
    const body = await bodyOfOneTurn(createSession({
      model: "anthropic/claude-sonnet-5",
      sampling: { topP: 0.9, topK: 40 },
      modelSupportedParameters: RICH_PARAMS,
    }));

    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("temperature");
  });

  it("clamps an out-of-range persisted value instead of putting it on the wire", async () => {
    const body = await bodyOfOneTurn(createSession({
      sampling: { topP: 42 },
      modelSupportedParameters: RICH_PARAMS,
    }));
    expect(body["top_p"]).toBe(1);
  });
});
