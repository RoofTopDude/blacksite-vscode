import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionOptions } from "../../src/agent-session.js";
import type { ProviderTurnStreamEvent } from "../../src/agent-loop-contract.js";
import type { SubscriptionRequest } from "../../src/chatgpt-service.js";
import { currentProviderSettings } from "../../src/webview/react/components/settings/helpers.js";
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

  it("does not substitute an API model when the subscription catalog has not loaded", () => {
    expect(currentProviderSettings({ provider: "openai", providerSettings: { openai: { authMode: "chatgpt", model: "", temperature: 1, maxTokens: 8192 } }, maxIterations: 40, disabledTools: [] }).model).toBe("");
  });
});
