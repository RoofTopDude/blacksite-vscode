import { describe, expect, it } from "vitest";
import { BEDROCK_MANTLE_MODELS, getFallbackModels, type ModelInfo } from "../../src/model-fetcher.js";
import {
  BEDROCK_CONVERSE_DEFAULT_MODEL,
  BEDROCK_MANTLE_DEFAULT_MODEL,
  defaultBedrockModel,
} from "../../src/bedrock-config.js";

// A wrong model id costs a whole session: it is only discovered when a turn 400s, and every
// retry fails the same way. Two shipped ids were wrong in exactly this way —
// "us.anthropic.claude-sonnet-4-6" (an Anthropic-native name wearing a Bedrock prefix, with no
// version suffix) and a bare "anthropic.*-v1:0" foundation id that AWS only serves through an
// inference profile. Both are decidable from the string alone, so assert the shapes here rather
// than waiting for a provider to reject them.

/**
 * Bedrock Converse takes either a cross-region inference profile ("us.anthropic.…-v1:0") or a
 * foundation model id ("anthropic.…-v1:0"). Both carry a vendor prefix AND a version suffix.
 */
const BEDROCK_CONVERSE_ID = /^(?:(?:us|eu|apac)\.)?[a-z0-9-]+\.[a-z0-9.-]+-v\d+:\d+$/;
/** Current-generation Claude inference profiles carry no version suffix: AWS's Sonnet 5 model card
 *  lists `us.`/`eu.`/`au.`/`global.anthropic.claude-sonnet-5` as its Converse ids. A profile prefix
 *  is still required — only the suffix rule changed. */
const BEDROCK_CONVERSE_PROFILE_ID = /^(?:us|eu|apac|jp|au|global)\.anthropic\.claude-[a-z0-9-]+$/;
const isConverseId = (id: string): boolean => BEDROCK_CONVERSE_ID.test(id) || BEDROCK_CONVERSE_PROFILE_ID.test(id);
/** Mantle speaks the Anthropic Messages API: vendor-prefixed, no AWS version suffix. */
const MANTLE_ID = /^anthropic\.claude-[a-z0-9-]+$/;
/** Anthropic's own API takes a bare model name — no vendor prefix, no version suffix. */
const ANTHROPIC_ID = /^claude-[a-z0-9-]+$/;
/** OpenRouter namespaces every model as "vendor/model". */
const OPENROUTER_ID = /^[a-z0-9-]+\/[a-zA-Z0-9.:-]+$/;

function ids(models: ModelInfo[]): string[] {
  return models.map((model) => model.id);
}

describe("model catalog — id shapes", () => {
  it("every Bedrock Converse fallback id is a dated id or a current-generation profile id", () => {
    for (const id of ids(getFallbackModels("bedrock"))) {
      // Older models need the -vN:N suffix. Current-generation profiles do not have one — AWS now
      // documents "us.anthropic.claude-sonnet-4-6" and "…claude-sonnet-5" as Converse ids — but
      // they still need the profile prefix, which the next test enforces for Claude 4.x.
      expect(isConverseId(id), `${id} is not a valid Bedrock Converse model id`).toBe(true);
    }
  });

  it("no Bedrock Converse fallback is a bare foundation id for a profile-only Claude model", () => {
    // Claude 4.x on Bedrock is inference-profile-only. Shipping the bare "anthropic.…" id makes
    // every turn fail with "on-demand throughput isn't supported", so the table must use "us.".
    const profileOnly = ids(getFallbackModels("bedrock"))
      .filter((id) => /^anthropic\.claude-(?:opus|sonnet|haiku)-4/.test(id));
    expect(profileOnly, "these need a region prefix (us.) to be invokable").toEqual([]);
  });

  it("every Mantle model id is vendor-prefixed with no AWS version suffix", () => {
    for (const id of ids(BEDROCK_MANTLE_MODELS)) {
      expect(id, `${id} is not a valid Mantle model id`).toMatch(MANTLE_ID);
    }
  });

  it("every Anthropic fallback id is a bare model name", () => {
    for (const id of ids(getFallbackModels("anthropic"))) {
      expect(id, `${id} should not carry a vendor prefix`).toMatch(ANTHROPIC_ID);
    }
  });

  it("every OpenRouter fallback id is vendor-namespaced", () => {
    for (const id of ids(getFallbackModels("openrouter"))) {
      expect(id, `${id} is not a valid OpenRouter model id`).toMatch(OPENROUTER_ID);
    }
  });

  it("keeps each provider's ids distinct", () => {
    for (const provider of ["anthropic", "openrouter", "openai", "bedrock"] as const) {
      const all = ids(getFallbackModels(provider));
      expect(new Set(all).size, `${provider} has a duplicate model id`).toBe(all.length);
    }
  });

  it("gives every listed model a usable context length", () => {
    const every = [...BEDROCK_MANTLE_MODELS, ...(["anthropic", "openrouter", "openai", "bedrock"] as const)
      .flatMap((provider) => getFallbackModels(provider))];
    for (const model of every) {
      expect(model.contextLength, `${model.id} has no context length`).toBeGreaterThan(0);
    }
  });
});

describe("model catalog — defaults are reachable", () => {
  // A default that isn't in its own picker list is a stale table: the user never chose it, so a
  // bad default silently breaks the first turn of every new session.
  it("the Bedrock Converse default is a valid Converse id", () => {
    expect(isConverseId(BEDROCK_CONVERSE_DEFAULT_MODEL)).toBe(true);
  });

  it("the Bedrock Converse default is offered in the Converse fallback list", () => {
    expect(ids(getFallbackModels("bedrock"))).toContain(BEDROCK_CONVERSE_DEFAULT_MODEL);
  });

  it("the Mantle default is a valid Mantle id offered in the Mantle list", () => {
    expect(BEDROCK_MANTLE_DEFAULT_MODEL).toMatch(MANTLE_ID);
    expect(ids(BEDROCK_MANTLE_MODELS)).toContain(BEDROCK_MANTLE_DEFAULT_MODEL);
  });

  it("resolves the default for each Bedrock API mode to that mode's id shape", () => {
    expect(isConverseId(defaultBedrockModel("converse"))).toBe(true);
    expect(isConverseId(defaultBedrockModel("converse", { latest: false }))).toBe(true);
    expect(defaultBedrockModel("mantle")).toMatch(MANTLE_ID);
    expect(isConverseId(defaultBedrockModel(undefined))).toBe(true); // converse is the default mode
  });
});
