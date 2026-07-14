/**
 * What actually goes on the wire for each model × provider combination.
 *
 * `thinking-modes.spec.ts` pins the capability table; this pins the request built from it. The two
 * failure modes are symmetric and both fatal: sending `budget_tokens` to an adaptive-era model, or
 * `adaptive` to a budget-era one, is a 400 on every turn. So is `temperature` on Opus 4.7+.
 */
import { describe, expect, it } from "vitest";
import {
  applyAnthropicThinking,
  planThinking,
  toBedrockThinking,
  type ThinkingPlanInput,
} from "../../src/agent-session.js";
import { buildRequestBody } from "../../src/bedrock-client.js";

function plan(overrides: Partial<ThinkingPlanInput> = {}) {
  return planThinking({
    model: "claude-opus-4-8",
    provider: "anthropic",
    configuredMaxTokens: 8192,
    ceiling: null,
    thinkingEnabled: true,
    budgetTokens: 10_000,
    effort: "high",
    temperature: 0.7,
    ...overrides,
  });
}

/** The Messages-API body an Anthropic-direct / Bedrock-Mantle request would carry. */
function messagesBody(overrides: Partial<ThinkingPlanInput> = {}): Record<string, unknown> {
  const p = plan(overrides);
  const body: Record<string, unknown> = { max_tokens: p.maxTokens };
  if (p.temperature !== undefined) body["temperature"] = p.temperature;
  applyAnthropicThinking(body, p.thinking);
  return body;
}

describe("adaptive-era models (Claude 4.6+)", () => {
  it("sends thinking.adaptive and an effort rung — never budget_tokens", () => {
    const body = messagesBody({ model: "claude-opus-4-8", effort: "xhigh" });
    expect(body["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(body["output_config"]).toEqual({ effort: "xhigh" });
    expect(JSON.stringify(body)).not.toContain("budget_tokens");
  });

  it("opts into summarized display so the reasoning panel isn't blank", () => {
    // The modern generation defaults display to "omitted" — thinking blocks arrive with empty text.
    expect(messagesBody({ model: "claude-sonnet-5" })["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    // The 4.6 pair already defaults to summarized, so the field is left off.
    expect(messagesBody({ model: "claude-sonnet-4-6" })["thinking"]).toEqual({ type: "adaptive" });
  });

  it("omits temperature entirely on the modern generation, thinking on or off", () => {
    expect(messagesBody({ model: "claude-opus-4-8", thinkingEnabled: true })["temperature"]).toBeUndefined();
    expect(messagesBody({ model: "claude-opus-4-8", thinkingEnabled: false })["temperature"]).toBeUndefined();
    expect(messagesBody({ model: "claude-sonnet-5", thinkingEnabled: false })["temperature"]).toBeUndefined();
  });

  it("clamps an effort rung the model doesn't have rather than sending it", () => {
    expect(messagesBody({ model: "claude-sonnet-4-6", effort: "xhigh" })["output_config"]).toEqual({ effort: "high" });
  });

  /** max_tokens is only clamped — there is no budget to make room for, so the bump that used to
   *  walk the request over the provider ceiling never runs on this path. */
  it("does not inflate max_tokens — adaptive has no budget constraint", () => {
    const p = plan({ model: "claude-opus-4-8", configuredMaxTokens: 8192, ceiling: 64_000, effort: "max" });
    expect(p.maxTokens).toBe(8192);
  });
});

describe("turning thinking off", () => {
  /** Omitting the field is NOT "off" on Sonnet 5 — it runs adaptive anyway. Off has to be stated. */
  it("sends an explicit disabled on adaptive models", () => {
    expect(messagesBody({ model: "claude-sonnet-5", thinkingEnabled: false })["thinking"]).toEqual({ type: "disabled" });
    expect(messagesBody({ model: "claude-opus-4-8", thinkingEnabled: false })["thinking"]).toEqual({ type: "disabled" });
  });

  it("omits the field on Fable/Mythos, which think unconditionally and 400 on disabled", () => {
    expect(messagesBody({ model: "claude-fable-5", thinkingEnabled: false })["thinking"]).toBeUndefined();
  });

  it("omits the field on budget-era models, where absent already means off", () => {
    const body = messagesBody({ model: "claude-sonnet-4-5", thinkingEnabled: false });
    expect(body["thinking"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.7); // sampling still allowed there
  });
});

describe("budget-era models (Claude 3.7 – 4.5)", () => {
  it("sends thinking.enabled with a token budget — never adaptive", () => {
    const body = messagesBody({ model: "claude-sonnet-4-5", budgetTokens: 10_000 });
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 10_000 });
    expect(body["output_config"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("adaptive");
  });

  it("raises max_tokens above the budget, then keeps it under the provider ceiling", () => {
    // The regression that started the 64000 death-spiral: the slider's maximum is exactly Bedrock
    // Claude's hard limit, so a bump of budget + 1024 produced max_tokens 65024 → fatal 400.
    const p = plan({ model: "claude-sonnet-4-5", budgetTokens: 64_000, configuredMaxTokens: 8192, ceiling: 64_000 });
    expect(p.maxTokens).toBeLessThanOrEqual(64_000);
    expect(p.thinking.kind).toBe("budget");
    if (p.thinking.kind === "budget") expect(p.thinking.budgetTokens).toBeLessThan(p.maxTokens);
  });

  it("honours Anthropic's 1024-token budget floor", () => {
    const p = plan({ model: "claude-sonnet-4-5", budgetTokens: 10 });
    expect(p.thinking.kind === "budget" && p.thinking.budgetTokens).toBe(1024);
  });

  it("omits temperature while thinking is on (Anthropic requires 1 or absent)", () => {
    expect(messagesBody({ model: "claude-sonnet-4-5", thinkingEnabled: true })["temperature"]).toBeUndefined();
  });
});

describe("non-Claude models", () => {
  it("never get a thinking block, and keep their temperature", () => {
    const body = messagesBody({ model: "amazon.nova-pro-v1:0", thinkingEnabled: true });
    expect(body["thinking"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.7);
  });
});

describe("Bedrock Converse (additionalModelRequestFields)", () => {
  const creds = { region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" };

  function converseBody(overrides: Partial<ThinkingPlanInput> = {}) {
    const p = plan({ provider: "bedrock", ...overrides });
    return buildRequestBody({
      credentials: creds,
      modelId: overrides.model ?? "claude-opus-4-8",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      thinking: toBedrockThinking(p.thinking),
    });
  }

  it("forwards the adaptive thinking object to the model", () => {
    const body = converseBody({ model: "us.anthropic.claude-opus-4-8-v1:0" });
    expect(body.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
  });

  it("forwards a token budget for a budget-era model", () => {
    const body = converseBody({ model: "anthropic.claude-sonnet-4-5-20250929-v1:0", budgetTokens: 12_000 });
    expect(body.additionalModelRequestFields).toEqual({
      thinking: { type: "enabled", budget_tokens: 12_000 },
    });
  });

  it("omits temperature for a model that rejects sampling parameters", () => {
    const body = converseBody({ model: "anthropic.claude-opus-4-8", thinkingEnabled: false });
    expect(body.inferenceConfig?.temperature).toBeUndefined();
  });

  it("still sends temperature for a model that accepts it", () => {
    const body = converseBody({ model: "anthropic.claude-sonnet-4-5", thinkingEnabled: false, temperature: 0.4 });
    expect(body.inferenceConfig?.temperature).toBe(0.4);
  });

  it("sends no thinking field at all when thinking is off on a budget-era model", () => {
    const body = converseBody({ model: "anthropic.claude-sonnet-4-5", thinkingEnabled: false });
    expect(body.additionalModelRequestFields).toBeUndefined();
  });
});
