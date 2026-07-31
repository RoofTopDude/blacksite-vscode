import { describe, expect, it } from "vitest";
import { defaultBedrockModel } from "../../src/bedrock-config.js";
import { currentProviderSettings } from "../../src/webview/react/components/settings/helpers.js";
import type { ExtendedSettings } from "../../src/webview/react/lib/protocol.js";

function makeSettings(overrides: Partial<ExtendedSettings> = {}): ExtendedSettings {
  return {
    provider: "bedrock",
    providerSettings: {},
    maxIterations: 40,
    disabledTools: [],
    ...overrides,
  };
}

describe("defaultBedrockModel", () => {
  it("returns the correct default per Bedrock API path", () => {
    expect(defaultBedrockModel()).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
    expect(defaultBedrockModel("converse")).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
    expect(defaultBedrockModel("mantle")).toBe("anthropic.claude-opus-5");
  });
});

describe("currentProviderSettings", () => {
  it("uses the mantle default model when Bedrock is in mantle mode", () => {
    const settings = makeSettings({ bedrockApi: "mantle" });
    expect(currentProviderSettings(settings).model).toBe("anthropic.claude-opus-5");
  });

  it("treats an empty model override as provider default", () => {
    const settings = makeSettings({
      bedrockApi: "mantle",
      providerSettings: {
        bedrock: { model: "", temperature: 0.8, maxTokens: 4096 },
      },
    });

    expect(currentProviderSettings(settings)).toMatchObject({
      model: "anthropic.claude-opus-5",
      temperature: 0.8,
      maxTokens: 4096,
    });
  });
});
