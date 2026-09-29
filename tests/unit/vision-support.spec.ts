import { describe, expect, it } from "vitest";
import { getVisionSupport, modelFamilySupportsVision, mapOpenRouterModelEntry } from "../../src/model-fetcher.js";
import { bedrockModelsToModelInfo, type BedrockAvailableModel } from "../../src/bedrock-models.js";
import type { ProviderName } from "../../src/agent-session.js";

/* Vision support used to come from the static model table, matched on the exact id, whenever no
   model picker had loaded the live catalog — which is every session after a window reload. A model
   missing from that table was treated as blind and every image it produced was withheld. These pin
   the fallback that replaced it. */

describe("modelFamilySupportsVision", () => {
  it.each([
    "claude-opus-4-6", "claude-3-5-haiku-20241022", "anthropic/claude-haiku-4.5",
    "gpt-4o-mini", "gpt-4.1", "gpt-4-turbo", "gpt-5-nano", "gpt-5.1-codex", "gpt-5.6",
    "o1", "o3", "o4-mini", "google/gemini-3-pro-preview", "x-ai/grok-4",
    "meta-llama/llama-4-maverick", "us.meta.llama3-2-90b-instruct-v1:0", "us.amazon.nova-pro-v1:0",
    "mistral.pixtral-large-2502-v1:0", "qwen/qwen3-vl-235b-a22b-instruct",
  ])("treats %s as a vision model", (id) => {
    expect(modelFamilySupportsVision(id)).toBe(true);
  });

  it.each([
    "o3-mini", "o1-mini", "gpt-3.5-turbo", "gpt-4", "gpt-4-0613", "openai/gpt-oss-120b",
    "us.amazon.nova-micro-v1:0", "anthropic.claude-instant-v1",
  ])("treats %s as text-only", (id) => {
    expect(modelFamilySupportsVision(id)).toBe(false);
  });

  it("does not guess about a family it has never seen", () => {
    expect(modelFamilySupportsVision("someco/mystery-7b")).toBeUndefined();
    expect(modelFamilySupportsVision("")).toBeUndefined();
  });
});

describe("getVisionSupport — no live catalog", () => {
  it("recognises vision models the static tables do not list verbatim", () => {
    const cases: Array<[ProviderName, string]> = [
      ["anthropic", "claude-opus-4-6"],
      ["anthropic", "claude-sonnet-4-5-20250929"],
      ["openai", "gpt-5.6"],
      ["openai", "gpt-4.1"],
      ["openrouter", "anthropic/claude-opus-4.7"],
      ["openrouter", "openai/gpt-5.6-luna"],
      ["bedrock", "global.anthropic.claude-sonnet-5"],
      ["bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"],
      ["bedrock", "us.anthropic.claude-opus-4-8"],
      ["bedrock", "anthropic.claude-mythos-5"],
    ];
    for (const [provider, id] of cases) expect(getVisionSupport(provider, id), `${provider} ${id}`).toBe(true);
  });

  it("answers from the static row, not a prefix of another model's id", () => {
    // The fallback table lists o3 (vision) before o3-mini (text-only); a prefix match would let
    // the first answer for the second.
    expect(getVisionSupport("openai", "o3-mini")).toBe(false);
    expect(getVisionSupport("openrouter", "openai/o3-mini")).toBe(false);
  });

  it("leaves an unknown family undecided so the caller can choose the safe default", () => {
    expect(getVisionSupport("openrouter", "someco/mystery-7b")).toBeUndefined();
  });
});

describe("live catalogs", () => {
  const bedrockModel = (id: string): BedrockAvailableModel => ({
    id, label: id, providerName: "x", source: "foundation", modalities: [], inferenceTypes: [], customizationsSupported: [],
  } as unknown as BedrockAvailableModel);

  it("marks Bedrock's non-Claude vision families as vision-capable", () => {
    const [nova, micro, claude] = bedrockModelsToModelInfo([
      bedrockModel("us.amazon.nova-pro-v1:0"),
      bedrockModel("us.amazon.nova-micro-v1:0"),
      bedrockModel("us.anthropic.claude-opus-4-8"),
    ]);
    expect([nova!.supportsVision, micro!.supportsVision, claude!.supportsVision]).toEqual([true, false, true]);
  });

  it("keeps OpenRouter's own modalities authoritative when it reports them", () => {
    expect(mapOpenRouterModelEntry({ id: "x-ai/grok-4", architecture: { input_modalities: ["text"] } }).supportsVision).toBe(false);
    expect(mapOpenRouterModelEntry({ id: "openai/o3-mini" }).supportsVision).toBe(false);
  });
});
