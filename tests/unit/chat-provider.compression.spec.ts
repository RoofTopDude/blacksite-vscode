import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, type ExtendedSettings, type ProviderSettings } from "../../src/chat-provider.js";
import type { CompressionProvider } from "../../src/agent-session.js";
import * as compressor from "../../src/compressor.js";

// Exercise the real factory without constructing unrelated webviews, databases or runners.
function factory(settings: ExtendedSettings, getApiKey = vi.fn(async () => "current-key")) {
  const host = Object.create(ChatProvider.prototype) as {
    _secrets: { getApiKey: typeof getApiKey };
    _buildCompressionProvider(key: string, settings: ExtendedSettings, main: ProviderSettings): CompressionProvider;
  };
  host._secrets = { getApiKey };
  const provider = host._buildCompressionProvider("captured-key", settings, settings.providerSettings.openai!);
  return { provider, getApiKey };
}

function settings(): ExtendedSettings {
  return {
    provider: "openai", maxIterations: 10, disabledTools: [],
    providerSettings: {
      openai: { model: "gpt-5.2" },
      openrouter: { model: "routed/model", baseUrl: "https://proxy.example/chat/completions" },
    },
    compression: { enabled: true, provider: "openrouter" },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("compression provider configuration", () => {
  it("uses the selected provider's model, key and endpoint when no compression model is specified", async () => {
    const compress = vi.spyOn(compressor, "compressHistory").mockResolvedValue("summary");
    const { provider, getApiKey } = factory(settings());
    await provider.compress([]);
    expect(getApiKey).toHaveBeenCalledWith("openrouter");
    expect(compress).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter", model: "routed/model", apiKey: "current-key", baseUrl: "https://proxy.example/chat/completions",
    }), []);
    expect(provider.handlesRetries).toBe(true);
  });

  it("honors an explicit compression model", async () => {
    const compress = vi.spyOn(compressor, "compressHistory").mockResolvedValue("summary");
    const config = settings();
    config.compression!.model = "custom/summary";
    await factory(config).provider.compress([]);
    expect(compress).toHaveBeenCalledWith(expect.objectContaining({ model: "custom/summary" }), []);
  });

  it("refreshes the same-provider key after rotation during a session", async () => {
    const compress = vi.spyOn(compressor, "compressHistory").mockResolvedValue("summary");
    const config = settings();
    config.compression!.provider = "openai";
    const getApiKey = vi.fn().mockResolvedValueOnce("first-key").mockResolvedValueOnce("rotated-key");
    const { provider } = factory(config, getApiKey);
    await provider.compress([]);
    await provider.compress([]);
    expect(compress).toHaveBeenNthCalledWith(1, expect.objectContaining({ apiKey: "first-key", model: "gpt-5.2" }), []);
    expect(compress).toHaveBeenNthCalledWith(2, expect.objectContaining({ apiKey: "rotated-key", model: "gpt-5.2" }), []);
  });

  it("never sends the main provider's key to another provider when its key is missing", async () => {
    const compress = vi.spyOn(compressor, "compressHistory");
    const { provider } = factory(settings(), vi.fn().mockResolvedValue(undefined));
    await expect(provider.compress([])).rejects.toThrow(/No API key configured/);
    expect(compress).not.toHaveBeenCalled();
  });
});
