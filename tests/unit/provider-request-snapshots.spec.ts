/**
 * The exact request every provider path sends, pinned to files under
 * __snapshots__/provider-requests/.
 *
 * Prompt caching only pays when a request's prefix is byte-identical to the one before it, so a
 * refactor that reorders keys, moves a cache breakpoint or changes a single separator costs real
 * money without failing any behavioural test. These snapshots are the guard for moving the
 * provider layer into packages/llm: every request below must stay identical through the move.
 * Never update one of these files just to make a run pass — find what changed the bytes first.
 *
 * Each scenario drives a real AgentSession over a stubbed `fetch`. Tool schemas are large and
 * stable, so a snapshot keeps their names in order plus a hash of the exact schema bytes; the rest
 * of the body is kept verbatim. Volatile values (the session id and SigV4 date/signature headers)
 * are replaced by placeholders.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionOptions } from "../../src/agent-session.js";
import type { ImageBlock } from "@blacksite-agent/llm";
import type { HostedSearchPolicy } from "@blacksite-agent/llm";
import { anthropicSseStream } from "@blacksite-agent/llm/testing";
import { eventFrame, streamFromChunks } from "@blacksite-agent/llm/testing";
import { responsesReasoningToolCallTurn, responsesTextTurn } from "@blacksite-agent/llm/testing";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()), mkdir: vi.fn(async () => {}) }));

afterEach(() => { vi.unstubAllGlobals(); });

type Route = "anthropic" | "mantle" | "bedrock" | "openai" | "openrouter" | "responses";
const ROUTES: Route[] = ["anthropic", "mantle", "bedrock", "openai", "openrouter", "responses"];

const SEARCH: HostedSearchPolicy = { scope: "approved", allowedDomains: ["nodejs.org", "github.com"], deniedDomains: ["denied.example"] };
const IMAGE: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==" } };

function routeOptions(route: Route): Partial<AgentSessionOptions> {
  const bedrock = { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" };
  switch (route) {
    case "anthropic":
      return { provider: "anthropic", model: "claude-sonnet-4-6", thinking: { enabled: true, budgetTokens: 4000, effort: "medium" } };
    case "mantle":
      return { provider: "bedrock", bedrockApi: "mantle", bedrock, model: "anthropic.claude-sonnet-4-6", thinking: { enabled: true, budgetTokens: 4000, effort: "medium" } };
    case "bedrock":
      return { provider: "bedrock", bedrockApi: "converse", bedrock, model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", thinking: { enabled: true, budgetTokens: 4000 } };
    case "openai":
      return { provider: "openai", model: "gpt-4.1" };
    case "openrouter":
      return { provider: "openrouter", model: "anthropic/claude-sonnet-4.6", thinking: { enabled: true, budgetTokens: 4000, effort: "medium" } };
    case "responses":
      return { provider: "openai", model: "o4-mini", useResponsesApi: true, reasoningEffort: "medium" };
  }
}

function createSession(route: Route, extra: Partial<AgentSessionOptions> = {}): AgentSession {
  return new AgentSession({
    apiKey: "test-key",
    systemPrompt: "You are the snapshot agent.",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, content: "# Readme\nhello" } })) } as never,
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } } as never,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" } as never,
    maxIterations: 4,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ...routeOptions(route),
    ...extra,
  } as AgentSessionOptions);
}

// ── Response streams: a tool-calling turn (with reasoning where the route has it) and a text turn ──

function anthropicToolTurn(): ReadableStream<Uint8Array> {
  return anthropicSseStream([
    { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should read the readme." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG_1" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "file_read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  ]);
}

function anthropicTextTurn(): ReadableStream<Uint8Array> {
  return anthropicSseStream([
    { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ]);
}

function bedrockToolTurn(): ReadableStream<Uint8Array> {
  return streamFromChunks([
    eventFrame("messageStart", { role: "assistant" }),
    eventFrame("contentBlockDelta", { delta: { reasoningContent: { text: "I should read the readme." } }, contentBlockIndex: 0 }),
    eventFrame("contentBlockDelta", { delta: { reasoningContent: { signature: "SIG_1" } }, contentBlockIndex: 0 }),
    eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
    eventFrame("contentBlockStart", { start: { toolUse: { toolUseId: "tooluse_1", name: "file_read" } }, contentBlockIndex: 1 }),
    eventFrame("contentBlockDelta", { delta: { toolUse: { input: "{\"path\":\"README.md\"}" } }, contentBlockIndex: 1 }),
    eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
    eventFrame("messageStop", { stopReason: "tool_use" }),
    eventFrame("metadata", { usage: { inputTokens: 100, outputTokens: 20 } }),
  ]);
}

function bedrockTextTurn(): ReadableStream<Uint8Array> {
  return streamFromChunks([
    eventFrame("messageStart", { role: "assistant" }),
    eventFrame("contentBlockDelta", { delta: { text: "Done." }, contentBlockIndex: 0 }),
    eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
    eventFrame("messageStop", { stopReason: "end_turn" }),
    eventFrame("metadata", { usage: { inputTokens: 100, outputTokens: 5 } }),
  ]);
}

function sse(lines: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(line)}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function chatToolTurn(): ReadableStream<Uint8Array> {
  return sse([
    { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "file_read", arguments: "" } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ]);
}

function chatTextTurn(): ReadableStream<Uint8Array> {
  return sse([
    { choices: [{ delta: { role: "assistant", content: "Done." }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } },
  ]);
}

function toolTurn(route: Route): ReadableStream<Uint8Array> {
  switch (route) {
    case "anthropic": case "mantle": return anthropicToolTurn();
    case "bedrock": return bedrockToolTurn();
    case "openai": case "openrouter": return chatToolTurn();
    case "responses": return responsesReasoningToolCallTurn({
      reasoningId: "rs_1", summaryText: "I should read the readme.", encryptedContent: "ENC_1",
      callId: "call_1", toolName: "file_read", toolArgs: { path: "README.md" },
    });
  }
}

function textTurn(route: Route): ReadableStream<Uint8Array> {
  switch (route) {
    case "anthropic": case "mantle": return anthropicTextTurn();
    case "bedrock": return bedrockTextTurn();
    case "openai": case "openrouter": return chatTextTurn();
    case "responses": return responsesTextTurn("Done.");
  }
}

// ── Capture and normalisation ───────────────────────────────────────────────────────────────

const VOLATILE_HEADERS = new Set(["authorization", "x-amz-date", "x-amz-security-token"]);

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Tool arrays keep their names in order plus a hash of their exact bytes. */
function summarizeTools(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const names = value.map((tool) => {
    const t = tool as Record<string, unknown>;
    const fn = t["function"] as Record<string, unknown> | undefined;
    const spec = t["toolSpec"] as Record<string, unknown> | undefined;
    const cachePoint = t["cachePoint"] !== undefined ? "<cachePoint>" : undefined;
    return String(t["name"] ?? fn?.["name"] ?? spec?.["name"] ?? cachePoint ?? t["type"] ?? "?");
  });
  return { names, sha256: sha(JSON.stringify(value)) };
}

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "tools") out[key] = summarizeTools(value);
    else if (key === "toolConfig" && value && typeof value === "object") {
      const config = value as Record<string, unknown>;
      out[key] = { ...config, tools: summarizeTools(config["tools"]) };
    } else out[key] = value;
  }
  return out;
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  bodySha256: string;
  body: unknown;
}

function capture(call: unknown[], sessionId: string): CapturedRequest {
  const [url, init] = call as [string, RequestInit];
  const rawBody = String(init.body ?? "");
  const headerEntries = Object.entries((init.headers ?? {}) as Record<string, string>)
    .map(([k, v]) => [k.toLowerCase(), VOLATILE_HEADERS.has(k.toLowerCase()) ? "<volatile>" : String(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const replaceSession = (text: string): string => text.split(sessionId).join("<session>");
  const body = rawBody ? JSON.parse(replaceSession(rawBody)) as Record<string, unknown> : {};
  return {
    url: String(url),
    headers: Object.fromEntries(headerEntries.map(([k, v]) => [k, replaceSession(v)])),
    bodySha256: sha(replaceSession(rawBody)),
    body: normalizeBody(body),
  };
}

async function run(session: AgentSession, prompt: string, images?: ImageBlock[]): Promise<void> {
  for await (const _event of session.send(prompt, images ? { images } : undefined)) { /* drain */ }
}

function snapshotPath(scenario: string, route: Route): string {
  return path.join(__dirname, "__snapshots__", "provider-requests", `${scenario}.${route}.json`);
}

async function expectRequests(fetchMock: ReturnType<typeof vi.fn>, session: AgentSession, scenario: string, route: Route): Promise<void> {
  const requests = fetchMock.mock.calls.map((call) => capture(call, session.sessionId));
  expect(requests.length).toBeGreaterThan(0);
  await expect(`${JSON.stringify(requests, null, 2)}\n`).toMatchFileSnapshot(snapshotPath(scenario, route));
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────

describe("provider request snapshots", () => {
  for (const route of ROUTES) {
    it(`${route}: reasoning plus a tool round trip`, async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, body: toolTurn(route) })
        .mockResolvedValueOnce({ ok: true, status: 200, body: textTurn(route) });
      vi.stubGlobal("fetch", fetchMock);
      const session = createSession(route);
      await run(session, "Read the readme and summarise it.");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expectRequests(fetchMock, session, "tool-round-trip", route);
    });

    it(`${route}: an attached image`, async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, body: textTurn(route) });
      vi.stubGlobal("fetch", fetchMock);
      const session = createSession(route, { supportsVision: true });
      await run(session, "What is in this picture?", [IMAGE]);
      await expectRequests(fetchMock, session, "image", route);
    });

    it(`${route}: hosted search with on-demand tool loading`, async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, body: textTurn(route) });
      vi.stubGlobal("fetch", fetchMock);
      const session = createSession(route, {
        toolLoading: () => "on_demand",
        researchProvider: { dispatch: vi.fn(async () => ({ ok: true })), hostedSearch: () => SEARCH },
      });
      await run(session, "What is the current Node LTS?");
      await expectRequests(fetchMock, session, "hosted-search", route);
    });
  }

  /* The ChatGPT subscription route never calls fetch: the session hands a request object to the
     Codex stream. That object is the contract to keep identical. */
  it("chatgpt: the subscription request across a tool round trip with hosted search", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let round = 0;
    const subscriptionStream = vi.fn(async function* (request: Record<string, unknown>) {
      const { signal: _signal, ...rest } = request;
      requests.push(structuredClone(rest));
      if (round++ === 0) {
        yield { type: "thinking_block", text: "I should read the readme.", encryptedContent: "ENC_1", reasoningItemId: "rs_1" } as const;
        yield { type: "tool_use_block", block: { type: "tool_use", id: "call_1", name: "file_read", input: { path: "README.md" } } } as const;
        yield { type: "stop_reason", reason: "tool_use" } as const;
      } else {
        yield { type: "text_delta", text: "Done." } as const;
        yield { type: "stop_reason", reason: "end_turn" } as const;
      }
    });
    const session = createSession("openai", {
      model: "gpt-5.5",
      subscriptionStream: subscriptionStream as never,
      reasoningEffort: "medium",
      serviceTier: "fast",
      researchProvider: { dispatch: vi.fn(async () => ({ ok: true })), hostedSearch: () => SEARCH },
    });
    await run(session, "Read the readme and summarise it.", [IMAGE]);
    expect(requests).toHaveLength(2);
    const text = JSON.stringify(requests.map((r) => ({ ...r, tools: summarizeTools(r["tools"]) })), null, 2)
      .split(session.sessionId).join("<session>");
    await expect(`${text}\n`).toMatchFileSnapshot(path.join(__dirname, "__snapshots__", "provider-requests", "subscription.chatgpt.json"));
  });
});
