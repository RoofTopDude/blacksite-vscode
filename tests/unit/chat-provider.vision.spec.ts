import { describe, expect, it, vi } from "vitest";
import { ChatProvider } from "../../src/chat-provider.js";
import type { AgentMessage, ImageBlock } from "../../src/agent-loop-contract.js";
import type { ModelInfo } from "../../src/model-fetcher.js";
import { PERSISTED_IMAGE_STUB, stripImagesForPersistence } from "../../src/agent/transcript-hygiene.js";

/* The host decides whether a session's model can see images and hands a rebuilt session its
   transcript. Both used to drop pictures the model could have seen: the first by reading a
   static table whenever no model picker had loaded the catalog, the second by restoring from a
   store that keeps no pixels. */

interface Host {
  _resolveSupportsVision(provider: string, model: string): boolean;
  _warmModelCatalog(provider: string, apiKey: string): void;
  _restoreSessionFromState(session: unknown, messages: AgentMessage[], state?: unknown, sessionId?: string): void;
  _modelCache: Map<string, ModelInfo[]>;
  _fetchModelCatalog: ReturnType<typeof vi.fn>;
  _liveTranscript: { sessionId: string; messages: AgentMessage[]; fullHistory: AgentMessage[] } | null;
}

function makeHost(): Host {
  return Object.assign(Object.create(ChatProvider.prototype), {
    _modelCache: new Map(),
    _modelFetchInFlight: new Map(),
    _fetchModelCatalog: vi.fn(async () => []),
    _sessionStore: { loadFullHistory: () => undefined },
    _sessionSpend: new Map(),
    _liveTranscript: null,
  }) as Host;
}

const IMAGE: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

describe("ChatProvider vision support", () => {
  it("sees images on a cold window for models the static tables do not list verbatim", () => {
    const host = makeHost();
    expect(host._resolveSupportsVision("bedrock", "us.anthropic.claude-opus-4-8")).toBe(true);
    expect(host._resolveSupportsVision("anthropic", "claude-opus-4-6")).toBe(true);
    // ChatGPT sign-in has no fallback list at all; it used to resolve every model as blind.
    expect(host._resolveSupportsVision("openai", "gpt-5.6-sol")).toBe(true);
  });

  it("lets a live catalog row decide, and falls through when the row says nothing", () => {
    const host = makeHost();
    host._modelCache.set("openrouter", [
      { id: "x-ai/grok-4", name: "Grok 4", supportsVision: false, source: "api" },
      { id: "anthropic/claude-sonnet-5", name: "Sonnet", source: "api" },
    ]);
    expect(host._resolveSupportsVision("openrouter", "x-ai/grok-4")).toBe(false);
    expect(host._resolveSupportsVision("openrouter", "anthropic/claude-sonnet-5")).toBe(true);
  });

  it("stays text-only for a family it cannot place", () => {
    expect(makeHost()._resolveSupportsVision("openrouter", "someco/mystery-7b")).toBe(false);
  });

  it("loads the live catalog once for a cold provider, and never for Bedrock", () => {
    const host = makeHost();
    host._warmModelCatalog("anthropic", "key");
    host._warmModelCatalog("bedrock", "key");
    host._modelCache.set("openai", []);
    host._warmModelCatalog("openai", "key");
    expect(host._fetchModelCatalog).toHaveBeenCalledTimes(1);
    expect(host._fetchModelCatalog).toHaveBeenCalledWith("anthropic", "key");
  });
});

describe("ChatProvider session rebuild", () => {
  const live: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "what is wrong here?" }, IMAGE] },
    { role: "assistant", content: [{ type: "text", text: "the header overlaps" }] },
  ];

  it("gives a rebuilt session back the images the store dropped", () => {
    const host = makeHost();
    host._liveTranscript = { sessionId: "s1", messages: live, fullHistory: live };
    const session = { restoreState: vi.fn() };
    host._restoreSessionFromState(session, stripImagesForPersistence(live), { fullHistory: stripImagesForPersistence(live) }, "s1");

    const restored = session.restoreState.mock.calls[0]![0] as { messages: AgentMessage[]; fullHistory: AgentMessage[] };
    expect(restored.messages[0]!.content).toEqual([{ type: "text", text: "what is wrong here?" }, IMAGE]);
    expect(restored.fullHistory[0]!.content).toEqual([{ type: "text", text: "what is wrong here?" }, IMAGE]);
  });

  it("never borrows images from a different conversation", () => {
    const host = makeHost();
    host._liveTranscript = { sessionId: "other", messages: live, fullHistory: live };
    const session = { restoreState: vi.fn() };
    host._restoreSessionFromState(session, stripImagesForPersistence(live), undefined, "s1");

    const restored = session.restoreState.mock.calls[0]![0] as { messages: AgentMessage[] };
    expect(restored.messages[0]!.content).toEqual([{ type: "text", text: "what is wrong here?" }, { type: "text", text: PERSISTED_IMAGE_STUB }]);
  });
});
