import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionOptions } from "../../src/agent-session.js";
import type { ProviderTurnStreamEvent } from "../../src/agent-loop-contract.js";
import type { SubscriptionRequest } from "../../src/chatgpt-service.js";
import { currentProviderSettings, effectiveReasoningEffort, subscriptionReasoningEffort, supportedReasoningEfforts } from "../../src/webview/react/components/settings/helpers.js";
import { ChatProvider } from "../../src/chat-provider.js";
import * as modelFetcher from "../../src/model-fetcher.js";

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT routing through Blacksite", () => {
  it("ignores a late API catalog after switching to subscription authentication", async () => {
    let subscription = false;
    let complete!: (models: modelFetcher.ModelInfo[]) => void;
    vi.spyOn(modelFetcher, "fetchModels").mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const post = vi.fn();
    const host = Object.assign(Object.create(ChatProvider.prototype), {
      _usesChatGpt: () => subscription,
      _post: post,
      _secrets: { getApiKey: async () => "api-key" },
      _modelCache: new Map(),
    }) as { _fetchAndSendModels: (provider: string) => Promise<void> };
    const pending = host._fetchAndSendModels("openai");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    subscription = true;
    complete([{ id: "api-only-model", name: "API model", source: "api" }]);
    await pending;
    expect(post.mock.calls.some(([message]) => message.type === "models_data")).toBe(false);
  });
  it("reports sign-in errors in the transcript when starting a session", async () => {
    const host = Object.create(ChatProvider.prototype) as {
      _readSettings: () => { provider: string };
      _modelCredential: () => Promise<string>;
      _post: ReturnType<typeof vi.fn>;
      _ensureSession: () => Promise<unknown>;
    };
    host._readSettings = () => ({ provider: "openai" });
    host._modelCredential = async () => { throw new Error("Sign in with ChatGPT"); };
    host._post = vi.fn();
    expect(await host._ensureSession()).toBeNull();
    expect(host._post).toHaveBeenCalledWith({ type: "stream_error", message: "Failed to start session: Sign in with ChatGPT" });
  });
  it("runs the existing tool loop using subscription calls without HTTP or API credentials", async () => {
    const fetch = vi.fn(() => { throw new Error("API transport must not be called"); });
    vi.stubGlobal("fetch", fetch);
    const requests: SubscriptionRequest[] = [];
    const handleMessage = vi.fn(async () => ({ result: { ok: true, entries: [{ name: "a.ts", kind: "file" }] } }));
    const session = new AgentSession({
      apiKey: "", provider: "openai", model: "test-model", systemPrompt: "Test", workspaceRoot: process.cwd(),
      runtime: { handleMessage },
      context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      maxIterations: 3, checkpointingEnabled: false,
      subscriptionStream: async function* (request: SubscriptionRequest): AsyncGenerator<ProviderTurnStreamEvent> {
        requests.push(structuredClone({ ...request, signal: undefined }));
        if (requests.length === 1) {
          yield { type: "tool_use_block", block: { type: "tool_use", id: "call1", name: "file_list", input: { path: "." } } };
          yield { type: "stop_reason", reason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "The file is a.ts." };
          yield { type: "stop_reason", reason: "end_turn" };
        }
      },
    } as unknown as AgentSessionOptions);
    for await (const _event of session.send("List files")) { /* drive the real loop */ }
    expect(handleMessage).toHaveBeenCalled();
    expect(JSON.stringify(requests[1]?.messages)).toContain("tool_result");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hands the chosen reasoning depth and speed tier to the subscription stream", async () => {
    const seen: Array<Pick<SubscriptionRequest, "reasoningEffort" | "serviceTier">> = [];
    const run = async (extra: Record<string, unknown>) => {
      const session = new AgentSession({
        apiKey: "", provider: "openai", model: "gpt-6-sol", systemPrompt: "Test", workspaceRoot: process.cwd(),
        runtime: { handleMessage: vi.fn() }, maxIterations: 1, checkpointingEnabled: false,
        context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
        memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
        subscriptionStream: async function* (request: SubscriptionRequest): AsyncGenerator<ProviderTurnStreamEvent> {
          seen.push({ reasoningEffort: request.reasoningEffort, serviceTier: request.serviceTier });
          yield { type: "text_delta", text: "ok" };
          yield { type: "stop_reason", reason: "end_turn" };
        },
        ...extra,
      } as unknown as AgentSessionOptions);
      for await (const _event of session.send("hi")) { /* drive the real loop */ }
    };
    await run({ reasoningEffort: "high", serviceTier: "fast" });
    await run({ serviceTier: "priority" });
    await run({ serviceTier: "default" });
    await run({ serviceTier: "flex" });
    expect(seen).toEqual([
      { reasoningEffort: "high", serviceTier: "priority" }, { reasoningEffort: undefined, serviceTier: "priority" },
      { reasoningEffort: undefined, serviceTier: "default" }, { reasoningEffort: undefined, serviceTier: undefined },
    ]);
  });

  it("does not substitute an API model when the subscription catalog has not loaded", () => {
    expect(currentProviderSettings({ provider: "openai", providerSettings: { openai: { authMode: "chatgpt", model: "", temperature: 1, maxTokens: 8192 } }, maxIterations: 40, disabledTools: [] }).model).toBe("");
  });

  it("sizes a subscription conversation from the Codex catalog, never the API's window", () => {
    type Host = { _cachedContextLength: (provider: string, model: string) => number | undefined };
    const host = (subscription: boolean, cached: number | undefined) => Object.assign(Object.create(ChatProvider.prototype), {
      _usesChatGpt: () => subscription,
      _modelCache: new Map([["openai", cached ? [{ id: "gpt-5.6-luna", contextLength: cached, source: "api" }] : []]]),
    }) as Host;
    expect(host(true, 258_400)._cachedContextLength("openai", "gpt-5.6-luna")).toBe(258_400);
    // Until the catalog loads the answer is "not known yet": the API table says 1,050,000 for this model.
    expect(host(true, undefined)._cachedContextLength("openai", "gpt-5.6-luna")).toBeUndefined();
    expect(host(false, undefined)._cachedContextLength("openai", "gpt-5.6-luna")).toBe(1_050_000);
  });

  it("sends a reasoning depth under ChatGPT sign-in only when the user chose one", () => {
    type Host = { _reasoningEffortFor: (provider: string, settings: unknown, pSettings: unknown) => string | undefined };
    const host = Object.assign(Object.create(ChatProvider.prototype), {
      _usesChatGpt: (_provider: string, settings: { providerSettings: { openai?: { authMode?: string } } }) => settings.providerSettings.openai?.authMode === "chatgpt",
    }) as Host;
    const merged = { reasoningEffort: "medium" };
    const subscription = (subscriptionReasoningEffort?: string, apiKeyEffort?: string) => ({ providerSettings: { openai: { authMode: "chatgpt", ...(subscriptionReasoningEffort ? { subscriptionReasoningEffort } : {}), ...(apiKeyEffort ? { reasoningEffort: apiKeyEffort } : {}) } } });
    expect(host._reasoningEffortFor("openai", subscription(), merged)).toBeUndefined();
    expect(host._reasoningEffortFor("openai", subscription("xhigh"), merged)).toBe("xhigh");
    // A depth chosen under API-key sign-in (here one ChatGPT models do not have) is not inherited.
    expect(host._reasoningEffortFor("openai", subscription(undefined, "none"), merged)).toBeUndefined();
    expect(host._reasoningEffortFor("openai", { providerSettings: { openai: {} } }, merged)).toBe("medium");
  });

  it("offers the depths and default the catalog lists, and keeps the API table for API models", () => {
    const info = { id: "gpt-5.5", reasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"], defaultReasoningEffort: "xhigh" };
    expect(supportedReasoningEfforts("gpt-5.5", info)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportedReasoningEfforts("gpt-5.5")).toContain("none");
    expect(effectiveReasoningEffort("gpt-5.5", undefined, info)).toBe("xhigh");
    expect(effectiveReasoningEffort("gpt-5.5", "low", info)).toBe("low");
    expect(effectiveReasoningEffort("gpt-5.5", "max", info)).toBe("xhigh");
    const settings = (subscriptionReasoningEffort?: string, apiKeyEffort?: string) => ({ provider: "openai", providerSettings: { openai: { authMode: "chatgpt", model: "gpt-5.5", ...(subscriptionReasoningEffort ? { subscriptionReasoningEffort } : {}), ...(apiKeyEffort ? { reasoningEffort: apiKeyEffort } : {}) } }, maxIterations: 40, disabledTools: [] }) as never;
    expect(subscriptionReasoningEffort(settings(), info)).toBe("xhigh");
    expect(subscriptionReasoningEffort(settings("medium"), info)).toBe("medium");
    expect(subscriptionReasoningEffort(settings(undefined, "low"), info)).toBe("xhigh");
  });
});
