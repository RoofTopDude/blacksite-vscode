import { afterEach, describe, expect, it, vi } from "vitest";
import { isOnDemandInvokable, listAvailableBedrockModels } from "../../src/bedrock-models.js";

const CREDS = {
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret123",
};

/** The real shape AWS returns for a Claude model that is only reachable via an inference profile. */
const HAIKU_FOUNDATION = {
  modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
  modelName: "Claude Haiku 4.5",
  providerName: "Anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  inferenceTypesSupported: ["INFERENCE_PROFILE"],
};

const SONNET_FOUNDATION = {
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  modelName: "Claude 3.5 Sonnet",
  providerName: "Anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  inferenceTypesSupported: ["ON_DEMAND"],
};

const HAIKU_PROFILE = {
  inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  inferenceProfileName: "US Claude Haiku 4.5",
  models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0" }],
};

function stubListings(foundationModels: unknown[], profiles: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(
      String(url).includes("/inference-profiles")
        ? { inferenceProfileSummaries: profiles }
        : { modelSummaries: foundationModels },
    ),
  } as unknown as Response)));
}

describe("isOnDemandInvokable", () => {
  it("rejects a foundation model that AWS lists as inference-profile only", () => {
    expect(isOnDemandInvokable({
      id: "anthropic.claude-haiku-4-5-20251001-v1:0",
      label: "x", providerName: "Anthropic", source: "foundation_model",
      modalities: ["TEXT"], inferenceTypes: ["INFERENCE_PROFILE"], customizationsSupported: [],
    })).toBe(false);
  });

  it("accepts a foundation model that supports on-demand throughput", () => {
    expect(isOnDemandInvokable({
      id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      label: "x", providerName: "Anthropic", source: "foundation_model",
      modalities: ["TEXT"], inferenceTypes: ["ON_DEMAND", "PROVISIONED"], customizationsSupported: [],
    })).toBe(true);
  });

  it("keeps a model when AWS reports no inference types rather than hiding a usable one", () => {
    expect(isOnDemandInvokable({
      id: "some.model",
      label: "x", providerName: "Other", source: "foundation_model",
      modalities: ["TEXT"], inferenceTypes: [], customizationsSupported: [],
    })).toBe(true);
  });

  it("always accepts inference profiles", () => {
    expect(isOnDemandInvokable({
      id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      label: "x", providerName: "Anthropic", source: "inference_profile",
      modalities: ["TEXT"], inferenceTypes: ["INFERENCE_PROFILE"], customizationsSupported: [],
    })).toBe(true);
  });
});

describe("listAvailableBedrockModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Offering the bare foundation id put an unusable model in the picker: selecting it failed every
  // turn with "Invocation of model ID ... with on-demand throughput isn't supported".
  it("hides inference-profile-only foundation models but keeps their profile entry", async () => {
    stubListings([HAIKU_FOUNDATION, SONNET_FOUNDATION], [HAIKU_PROFILE]);

    const result = await listAvailableBedrockModels(CREDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.data.models.map((model) => model.id);
    expect(ids).not.toContain("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(ids).toContain("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(ids).toContain("anthropic.claude-3-5-sonnet-20241022-v2:0");
  });

  it("warns about how many models were hidden so the omission is explainable", async () => {
    stubListings([HAIKU_FOUNDATION, SONNET_FOUNDATION], [HAIKU_PROFILE]);

    const result = await listAvailableBedrockModels(CREDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings.some((warning) => warning.includes("1 model(s) require an inference profile"))).toBe(true);
  });
});
