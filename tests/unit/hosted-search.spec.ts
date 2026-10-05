import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type AgentSessionOptions } from "../../src/agent-session.js";
import type { AgentMessage, ProviderTurnStreamEvent } from "../../src/agent-loop-contract.js";
import {
  anthropicSearchResults,
  anthropicWebSearchTool,
  codexSearchResults,
  codexWebSearchConfig,
  isCodexSearchCell,
  openRouterCitations,
  openRouterServerToolCall,
  openRouterWebSearchTool,
} from "../../src/agent/hosted-search.js";
import { resolveAnthropicNativeBlocks } from "../../src/agent/transcript-hygiene.js";
import { toResponsesInputItems } from "../../src/agent/wire/openai.js";
import { ChatGptService, toCodexInputItems, type SubscriptionRequest } from "../../src/chatgpt-service.js";
import type { CodexAppServer, CodexMessage } from "../../src/codex-app-server.js";
import { BrowserApprovalCoordinator } from "../../src/browser/approval-coordinator.js";
import type { BrowserProposal, HostedSearchPolicy } from "../../src/browser/approval-types.js";
import { DomainPolicy, normalizePolicy } from "../../src/browser/domain-policy.js";
import { hostedSearchPurpose, ResearchService } from "../../src/browser/research-service.js";
import { anthropicSseStream } from "./helpers/anthropic-sse.js";
import { responsesSseStream } from "./helpers/responses-api-sse.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()), mkdir: vi.fn(async () => {}) }));

const ANY: HostedSearchPolicy = { scope: "any", allowedDomains: ["nodejs.org"], deniedDomains: ["denied.example"] };
const APPROVED: HostedSearchPolicy = { scope: "approved", allowedDomains: ["nodejs.org", "github.com"], deniedDomains: ["denied.example"] };

afterEach(() => { vi.unstubAllGlobals(); });

describe("hosted search tool declarations", () => {
  it("declares Anthropic's basic search tool with one domain filter chosen by scope", () => {
    expect(anthropicWebSearchTool(ANY)).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5, blocked_domains: ["denied.example"] });
    expect(anthropicWebSearchTool(APPROVED)).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5, allowed_domains: ["nodejs.org", "github.com"] });
    // Allowed and blocked lists in one request are a 400; nothing denied means no filter at all.
    expect(anthropicWebSearchTool({ ...ANY, deniedDomains: [] })).not.toHaveProperty("blocked_domains");
  });

  it("declares OpenRouter's server tool with excluded or allowed domains", () => {
    expect(openRouterWebSearchTool(ANY)).toEqual({ type: "openrouter:web_search", parameters: { max_uses: 5, max_results: 8, excluded_domains: ["denied.example"] } });
    expect(openRouterWebSearchTool(APPROVED).parameters).toMatchObject({ allowed_domains: ["nodejs.org", "github.com"] });
  });

  it("turns Codex search on only when allowed, allow-listing without explicit nulls", () => {
    expect(codexWebSearchConfig(undefined)).toEqual({ web_search: "disabled" });
    expect(codexWebSearchConfig(ANY)).toEqual({ web_search: "cached" });
    // The live app-server rejected { allowed_domains, context_size: null, location: null }.
    expect(codexWebSearchConfig(APPROVED)).toEqual({ web_search: "cached", "tools.web_search": { allowed_domains: ["nodejs.org", "github.com"] } });
  });
});

describe("hosted search result parsing", () => {
  it("reads Anthropic results and error objects without touching encrypted content", () => {
    expect(anthropicSearchResults([{ type: "web_search_result", url: "https://nodejs.org/", title: "Node.js", encrypted_content: "ENC", page_age: "April 1, 2026" }]))
      .toEqual({ results: [{ title: "Node.js", url: "https://nodejs.org/", age: "April 1, 2026" }] });
    expect(anthropicSearchResults({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" })).toEqual({ results: [], error: "max_uses_exceeded" });
  });

  it("reads Codex webSearch results in the shape the live app-server sends", () => {
    expect(codexSearchResults([
      { type: "text_result", domain: "nodejs.org", ref_id: "turn0search0", snippet: "v24 Krypton", title: "Node.js Releases", url: "https://nodejs.org/en/about/previous-releases" },
      { type: "image_result" },
    ])).toEqual([{ title: "Node.js Releases", url: "https://nodejs.org/en/about/previous-releases", snippet: "v24 Krypton" }]);
  });

  it("deduplicates OpenRouter citations in nested and flat form", () => {
    expect(openRouterCitations([
      { type: "url_citation", url_citation: { url: "https://a.example/", title: "A", content: "alpha" } },
      { type: "url_citation", url: "https://a.example/", title: "A again" },
      { url: "https://b.example/", title: "B" },
      { type: "file_citation", url: "https://c.example/" },
    ])).toEqual([{ title: "A", url: "https://a.example/", snippet: "alpha" }, { title: "B", url: "https://b.example/" }]);
  });

  it("reads an OpenRouter server tool call record and ignores other reasoning details", () => {
    expect(openRouterServerToolCall({ type: "reasoning.text", text: "thinking" })).toBeUndefined();
    expect(openRouterServerToolCall({ type: "reasoning.server_tool_call", tool_name: "web_search", tool_call_id: "st1", arguments: "{\"query\":\"node lts\"}", result: JSON.stringify([{ url: "https://nodejs.org/", title: "Node", content: "LTS" }]) }))
      .toEqual({ id: "st1", query: "node lts", results: [{ title: "Node", url: "https://nodejs.org/", snippet: "LTS" }] });
  });

  it("recognizes a code-mode cell that only searched", () => {
    expect(isCodexSearchCell("const r = await tools.web__run({search_query:[{q:\"x\"}]}); text(r);")).toBe(true);
    expect(isCodexSearchCell("const r = await tools.web__run({}); await tools.blacksite_note({}); text(r);")).toBe(false);
    expect(isCodexSearchCell("text(await tools.blacksite_note({}));")).toBe(false);
  });
});

const serverUse = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "node lts" } };
const serverResult = { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://nodejs.org/", title: "Node", encrypted_content: "ENC1" }] };
const nativeTurn: AgentMessage[] = [
  { role: "user", content: "What is the current LTS?" },
  { role: "assistant", content: [
    { type: "thinking", thinking: "search it", signature: "sig" },
    { type: "provider_native", provider: "anthropic", block: serverUse },
    { type: "provider_native", provider: "anthropic", block: serverResult },
    { type: "text", text: "Node 24." },
  ] },
];

describe("provider-native blocks on the wire", () => {
  it("expands Anthropic blocks in place, byte for byte, only when the search tool is on", () => {
    const expanded = resolveAnthropicNativeBlocks(nativeTurn, true);
    expect((expanded[1]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["thinking", "server_tool_use", "web_search_tool_result", "text"]);
    expect(JSON.stringify(expanded)).toContain("ENC1");
    const stripped = resolveAnthropicNativeBlocks(nativeTurn, false);
    expect((stripped[1]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["thinking", "text"]);
    // Nothing to resolve: the same array comes back, no copy on the hot path.
    const plain = nativeTurn.slice(0, 1);
    expect(resolveAnthropicNativeBlocks(plain, true)).toBe(plain);
  });

  it("keeps a turn that held only search blocks wire-valid when they are stripped", () => {
    const only: AgentMessage[] = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "provider_native", provider: "anthropic", block: serverUse }] }];
    expect(resolveAnthropicNativeBlocks(only, false)[1]!.content).toEqual([{ type: "text", text: "(no response)" }]);
  });

  it("replays a Codex search cell after the reasoning it followed, for Codex only", () => {
    const cell = { type: "custom_tool_call", call_id: "call_s", name: "exec", input: "const r = await tools.web__run({}); text(r);" };
    const output = { type: "custom_tool_call_output", call_id: "call_s", output: [{ type: "input_text", text: "Node.js Releases (https://nodejs.org/)" }] };
    const messages: AgentMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "", encryptedContent: "E", reasoningItemId: "rs_1" },
        { type: "provider_native", provider: "codex", block: cell },
        { type: "provider_native", provider: "codex", block: output },
        { type: "text", text: "Node 24." },
      ] },
    ];
    expect(toResponsesInputItems(messages).map((i) => i.type)).toEqual(["message", "reasoning", "message"]);
    expect(toResponsesInputItems(messages, { codexNative: true }).map((i) => i.type)).toEqual(["message", "reasoning", "custom_tool_call", "custom_tool_call_output", "message"]);
    // The reasoning item is kept because it leads to the search cell, not dropped as dangling.
    expect(toCodexInputItems(messages, true).map((i) => i.type)).toEqual(["message", "reasoning", "custom_tool_call", "custom_tool_call_output", "message"]);
    expect(toCodexInputItems(messages, false).map((i) => i.type)).toEqual(["message", "message"]);
  });
});

function searchTurn(stop = "end_turn", withText = true) {
  const events: Array<Record<string, unknown>> = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"node lts\"}" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: serverResult },
    { type: "content_block_stop", index: 1 },
  ];
  if (withText) events.push(
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Node 24 is LTS." } },
    { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://nodejs.org/", title: "Node", encrypted_index: "IDX", cited_text: "v24" } } },
    { type: "content_block_stop", index: 2 },
  );
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } });
  return { ok: true, body: anthropicSseStream(events) };
}

function textTurn(text: string) {
  return { ok: true, body: anthropicSseStream([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ]) };
}

function session(extra: Record<string, unknown>, hosted: () => HostedSearchPolicy | undefined) {
  return new AgentSession({
    provider: "anthropic", model: "claude-sonnet-4-6",
    apiKey: "test", systemPrompt: "Test", workspaceRoot: "C:/workspace",
    bedrock: { region: "us-east-1", accessKeyId: "test", secretAccessKey: "test" },
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) },
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    researchProvider: { dispatch: vi.fn(async () => ({ ok: true })), hostedSearch: hosted },
    maxIterations: 3, checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ...extra,
  } as unknown as AgentSessionOptions);
}

async function run(s: AgentSession, text: string) {
  const events: AgentEvent[] = [];
  for await (const event of s.send(text)) events.push(event);
  return events;
}

function body(fetch: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  return JSON.parse(String((fetch.mock.calls[call]![1] as RequestInit).body)) as Record<string, unknown>;
}

describe("Anthropic hosted search through the session", () => {
  it("declares the tool in web_search's place, shows the search, and replays it verbatim", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(searchTurn()).mockResolvedValueOnce(textTurn("Anything else?"));
    vi.stubGlobal("fetch", fetch);
    const s = session({}, () => ANY);
    const events = await run(s, "What is the current Node LTS?");

    const tools = body(fetch, 0)["tools"] as Array<Record<string, unknown>>;
    expect(tools.filter((t) => t["name"] === "web_search")).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5, blocked_domains: ["denied.example"] }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_start", toolCallId: "srvtoolu_1", toolName: "web_search", input: { query: "node lts" } }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_result", toolCallId: "srvtoolu_1", ok: true, summary: "1 result from Claude's search" }));

    await run(s, "Thanks");
    const replayed = (body(fetch, 1)["messages"] as Array<{ role: string; content: unknown }>).find((m) => m.role === "assistant")!;
    expect((replayed.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(JSON.stringify(replayed)).toContain("ENC1");
    expect((replayed.content as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "srvtoolu_1", input: { query: "node lts" } });
  });

  it("drops the search blocks and offers web_search again once search is turned off", async () => {
    let on = true;
    const fetch = vi.fn().mockResolvedValueOnce(searchTurn()).mockResolvedValueOnce(textTurn("ok"));
    vi.stubGlobal("fetch", fetch);
    const s = session({}, () => (on ? ANY : undefined));
    await run(s, "Search please");
    on = false;
    await run(s, "Again");
    const second = body(fetch, 1);
    expect(JSON.stringify(second["messages"])).not.toContain("server_tool_use");
    expect((second["tools"] as Array<Record<string, unknown>>).find((t) => t["name"] === "web_search")).not.toHaveProperty("type");
  });

  it("continues a paused search turn by sending the paused content back as the last message", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(searchTurn("pause_turn", false)).mockResolvedValueOnce(textTurn("Node 24 is LTS."));
    vi.stubGlobal("fetch", fetch);
    const s = session({}, () => ANY);
    const events = await run(s, "What is the current Node LTS?");
    expect(fetch).toHaveBeenCalledTimes(2);
    const resumed = body(fetch, 1)["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(resumed.at(-1)!.role).toBe("assistant");
    expect(resumed.at(-1)!.content.map((b) => b["type"])).toEqual(["server_tool_use", "web_search_tool_result"]);
    const assistant = s.history.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect((assistant[0]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["provider_native", "provider_native", "text"]);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("never sends search blocks or the search tool to Bedrock Mantle", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(textTurn("ok"));
    vi.stubGlobal("fetch", fetch);
    const s = session({ provider: "bedrock", bedrockApi: "mantle" }, () => ANY);
    (s as unknown as { messages: AgentMessage[] }).messages.push(...nativeTurn);
    await run(s, "Continue");
    const sent = body(fetch, 0);
    expect(JSON.stringify(sent)).not.toContain("server_tool_use");
    expect(JSON.stringify(sent["tools"])).not.toContain("web_search_20250305");
  });

  it("is not offered through a custom Anthropic endpoint", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(textTurn("ok"));
    vi.stubGlobal("fetch", fetch);
    await run(session({ baseUrl: "https://gateway.example/v1/messages" }, () => ANY), "Hi");
    expect(JSON.stringify(body(fetch, 0)["tools"])).not.toContain("web_search_20250305");
  });
});

describe("OpenRouter hosted search through the session", () => {
  it("declares the server tool, shows cited sources, and never executes the server's own call", async () => {
    const handleMessage = vi.fn(async () => ({ result: { ok: true } }));
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: responsesSseStream([
      { choices: [{ delta: { content: "Node 24 is LTS.", annotations: [{ type: "url_citation", url_citation: { url: "https://nodejs.org/", title: "Node", content: "v24" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "ws_1", function: { name: "web_search", arguments: "{\"query\":\"node lts\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]) });
    vi.stubGlobal("fetch", fetch);
    const s = session({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6", runtime: { handleMessage } }, () => ANY);
    const events = await run(s, "What is the current Node LTS?");
    const tools = body(fetch, 0)["tools"] as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({ type: "openrouter:web_search", parameters: { max_uses: 5, max_results: 8, excluded_domains: ["denied.example"] } });
    expect(tools.some((t) => (t["function"] as { name?: string } | undefined)?.name === "web_search")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_result", toolCallId: "ws_1", toolName: "web_search", ok: true }));
    expect(handleMessage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });
});

describe("ChatGPT hosted search", () => {
  it("hands the policy to the subscription stream and leaves web_search off the tool list", async () => {
    const requests: SubscriptionRequest[] = [];
    const s = session({
      provider: "openai", model: "gpt-6-sol",
      subscriptionStream: async function* (request: SubscriptionRequest): AsyncGenerator<ProviderTurnStreamEvent> {
        requests.push(structuredClone({ ...request, signal: undefined }));
        yield { type: "hosted_search", id: "exec-1", query: "node lts", results: [{ title: "Node", url: "https://nodejs.org/" }] };
        yield { type: "text_delta", text: "Node 24." };
        yield { type: "stop_reason", reason: "end_turn" };
      },
    }, () => APPROVED);
    const events = await run(s, "What is the current Node LTS?");
    expect(requests[0]!.hostedSearch).toEqual(APPROVED);
    expect(requests[0]!.tools.map((t) => t.name)).not.toContain("web_search");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_result", toolCallId: "exec-1", summary: "1 result from ChatGPT's search" }));
  });

  it("starts the Codex thread with search on, reports it, and keeps the search cell for replay", async () => {
    const listeners = new Set<(message: CodexMessage) => void>();
    const emit = (method: string, params: Record<string, unknown>) => { for (const l of listeners) l({ method, params }); };
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "a@example.com", planType: "plus" } };
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/start") return { thread: { id: "t1" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          emit("rawResponseItem/completed", { threadId: "t1", item: { type: "custom_tool_call", call_id: "call_s", name: "exec", input: "const r = await tools.web__run({search_query:[{q:\"node lts\"}]}); text(r);\n" } });
          emit("item/completed", { threadId: "t1", item: { type: "webSearch", id: "exec-9", query: "node lts", action: { type: "search", query: "node lts" }, results: [{ type: "text_result", domain: "nodejs.org", title: "Node", url: "https://nodejs.org/", snippet: "v24" }] } });
          emit("rawResponseItem/completed", { threadId: "t1", item: { type: "custom_tool_call_output", call_id: "call_s", output: [{ type: "input_text", text: "Node (https://nodejs.org/)" }] } });
          emit("item/agentMessage/delta", { threadId: "t1", delta: "Node 24." });
          emit("turn/completed", { threadId: "t1", turn: { status: "completed" } });
        });
        return { turn: { id: "turn1" } };
      }
      return {};
    });
    const rpc = { request, start: vi.fn(async () => {}), dispose: vi.fn(), subscribe: (l: (m: CodexMessage) => void) => { listeners.add(l); return () => listeners.delete(l); } };
    const service = new ChatGptService(rpc as unknown as CodexAppServer, "/isolated", vi.fn(), vi.fn(async () => true), () => ({ reasoningSummary: "auto", extendedContext: false }));
    const events: ProviderTurnStreamEvent[] = [];
    for await (const e of service.stream({ model: "gpt-6-sol", systemPrompt: "S", messages: [{ role: "user", content: "q" }], tools: [], hostedSearch: APPROVED })) events.push(e);
    const start = request.mock.calls.find(([m]) => m === "thread/start")![1] as unknown as { config: Record<string, unknown>; developerInstructions: string };
    expect(start.config).toMatchObject({ web_search: "cached", "tools.web_search": { allowed_domains: ["nodejs.org", "github.com"] } });
    // "Use only the blacksite_ tools" would talk the model out of the search it was just given.
    expect(start.developerInstructions).toContain("blacksite_ tools and web search");
    expect(events).toContainEqual({ type: "hosted_search", id: "exec-9", query: "node lts", results: [{ title: "Node", url: "https://nodejs.org/", snippet: "v24" }] });
    const native = events.filter((e) => e.type === "provider_native_block");
    expect(native.map((e) => (e as { block: { block: { type: string } } }).block.block.type)).toEqual(["custom_tool_call", "custom_tool_call_output"]);
  });

  it("does not record the injected history's search cell again when Codex echoes it back", async () => {
    // Seen live: after thread/inject_items, the app-server re-emits each injected item as
    // rawResponseItem/completed. Recording the echo replayed every earlier search twice.
    const listeners = new Set<(message: CodexMessage) => void>();
    const emit = (method: string, params: Record<string, unknown>) => { for (const l of listeners) l({ method, params }); };
    const cell = { type: "custom_tool_call", call_id: "call_s", name: "exec", input: "const r = await tools.web__run({}); text(r);" };
    const output = { type: "custom_tool_call_output", call_id: "call_s", output: [{ type: "input_text", text: "Node (https://nodejs.org/)" }] };
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "a@example.com", planType: "plus" } };
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/start") return { thread: { id: "t1" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          emit("rawResponseItem/completed", { threadId: "t1", item: { ...cell, id: "ctc_1", status: "completed" } });
          emit("rawResponseItem/completed", { threadId: "t1", item: { ...output, id: "ctco_1" } });
          emit("item/agentMessage/delta", { threadId: "t1", delta: "Node 24." });
          emit("turn/completed", { threadId: "t1", turn: { status: "completed" } });
        });
        return { turn: { id: "turn1" } };
      }
      return {};
    });
    const rpc = { request, start: vi.fn(async () => {}), dispose: vi.fn(), subscribe: (l: (m: CodexMessage) => void) => { listeners.add(l); return () => listeners.delete(l); } };
    const service = new ChatGptService(rpc as unknown as CodexAppServer, "/isolated", vi.fn(), vi.fn(async () => true), () => ({ reasoningSummary: "auto", extendedContext: false }));
    const history: AgentMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "provider_native", provider: "codex", block: cell }, { type: "provider_native", provider: "codex", block: output }, { type: "text", text: "Found it." }] },
      { role: "user", content: "And the codename?" },
    ];
    const events: ProviderTurnStreamEvent[] = [];
    for await (const e of service.stream({ model: "gpt-6-sol", systemPrompt: "S", messages: history, tools: [], hostedSearch: ANY })) events.push(e);
    expect(events.filter((e) => e.type === "provider_native_block")).toEqual([]);
    expect(JSON.stringify(request.mock.calls.find(([m]) => m === "thread/inject_items"))).toContain("call_s");
  });

  it("keeps Codex search disabled when it is not on", async () => {
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "thread/start") return { thread: { id: "t1" } };
      if (method === "turn/start") { queueMicrotask(() => { for (const l of listeners) l({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } }); }); return { turn: { id: "turn1" } }; }
      if (method === "account/read") return { account: { type: "chatgpt", email: "a@example.com", planType: "plus" } };
      if (method === "model/list") return { data: [], nextCursor: null };
      return {};
    });
    const listeners = new Set<(message: CodexMessage) => void>();
    const rpc = { request, start: vi.fn(async () => {}), dispose: vi.fn(), subscribe: (l: (m: CodexMessage) => void) => { listeners.add(l); return () => listeners.delete(l); } };
    const service = new ChatGptService(rpc as unknown as CodexAppServer, "/isolated", vi.fn(), vi.fn(async () => true), () => ({ reasoningSummary: "auto", extendedContext: false }));
    for await (const _e of service.stream({ model: "gpt-6-sol", systemPrompt: "S", messages: [{ role: "user", content: "q" }], tools: [] })) { /* drain */ }
    const start = request.mock.calls.find(([m]) => m === "thread/start")![1] as unknown as { config: Record<string, unknown> };
    expect(start.config["web_search"]).toBe("disabled");
    expect(start.config).not.toHaveProperty("tools.web_search");
  });
});

describe("turning hosted search on from web_search", () => {
  const anchor = { toolCallId: "call_1", toolName: "web_search" };
  function service(decision: "session" | "global" | "deny", enabled = false) {
    const policy = new DomainPolicy({ allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none" });
    const asked: BrowserProposal[] = [];
    const coordinator = new BrowserApprovalCoordinator(policy, { ask: async (p) => { asked.push(p); return { id: p.id, decision }; } });
    const enable = vi.fn(async () => {});
    let declined = false;
    const hosted = { enabled: () => enabled, enable, declined: () => declined, decline: () => { declined = true; } };
    return { asked, enable, research: new ResearchService(coordinator, async () => undefined, undefined, hosted) };
  }

  it("asks once on a route with a hosted search and turns it on for the chosen scope", async () => {
    const { asked, enable, research } = service("global");
    const result = await research.dispatch("search", { query: "node lts" }, undefined, anchor, { hostedRoute: { provider: "anthropic", label: "Claude" } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "search", title: "Claude", fields: [], anchor });
    expect(asked[0]!.purpose).toContain("$10 per 1,000 searches");
    expect(enable).toHaveBeenCalledWith("global");
    expect(result).toMatchObject({ ok: true, enabled: "Claude" });
    expect(JSON.stringify(result)).toContain("Call web_search again");
  });

  it("enables nothing when the card is denied, says what to do instead, and does not ask again", async () => {
    const { asked, enable, research } = service("deny");
    const route = { hostedRoute: { provider: "openrouter" as const, label: "OpenRouter" } };
    const result = await research.dispatch("search", { query: "x" }, undefined, anchor, route);
    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(JSON.stringify(result)).toContain("Read sources you can name with web_read");
    expect(enable).not.toHaveBeenCalled();
    await research.dispatch("search", { query: "y" }, undefined, anchor, route);
    expect(asked).toHaveLength(1);
  });

  it("explains what to do on a route without hosted search instead of asking", async () => {
    const { asked, research } = service("session");
    const result = await research.dispatch("search", { query: "x" }, undefined, anchor, {});
    expect(asked).toHaveLength(0);
    expect(JSON.stringify(result)).toContain("No web search is set up for this model provider");
  });

  it("points at web_request_access when search is on but limited to approved sites with none approved", async () => {
    const { asked, research } = service("session", true);
    const result = await research.dispatch("search", { query: "x" }, undefined, anchor, { hostedRoute: { provider: "chatgpt", label: "ChatGPT" } });
    expect(asked).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(JSON.stringify(result)).toContain("web_request_access");
  });

  it("says what each provider charges and where results may come from", () => {
    expect(hostedSearchPurpose({ provider: "openrouter", label: "OpenRouter" }, "any")).toContain("except the ones you deny");
    expect(hostedSearchPurpose({ provider: "chatgpt", label: "ChatGPT" }, "any")).toContain("cannot exclude sites");
    expect(hostedSearchPurpose({ provider: "anthropic", label: "Claude" }, "approved")).toContain("limited to the sites you have approved");
  });
});

describe("research policy compatibility", () => {
  it("reads a policy saved before search scopes existed as any-site, not as invalid", () => {
    expect(normalizePolicy({ allowedDomains: ["example.com"], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none" }).searchScope).toBe("any");
    expect(normalizePolicy({ allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "hosted", searchScope: "approved" }).searchProvider).toBe("hosted");
    expect(() => normalizePolicy({ allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none", searchScope: "everywhere" as never })).toThrow();
  });
});
