/**
 * Cross-provider regression suite for the four failure classes that made long agent runs fail —
 * most visibly on Bedrock, but every one of them lives in code shared by all four provider paths
 * (Anthropic direct, Bedrock Converse, Bedrock Mantle, OpenAI/OpenRouter).
 *
 * The Bedrock-specific symptom was never the bug. Bedrock just *reached* these paths constantly,
 * because AWS reports throttles as in-band stream frames rather than pre-stream HTTP statuses.
 * Each describe below pins one class at the shared layer, so a fix can't regress on one provider
 * while holding on another.
 */
import { describe, expect, it } from "vitest";
import {
  fillEmptyMessageContent,
  normalizeForProvider,
  nonEmptyAssistantContent,
  planThinking,
  resolveOutputCeiling,
  normalizeBedrockStopReason,
  normalizeAnthropicStopReason,
  normalizeOpenAIStopReason,
  toBedrockMessages,
  toOpenAIMessages,
} from "../../src/agent-session.js";
import { isRetryableError, ProviderStreamError, StreamIdleTimeoutError } from "../../src/provider-retry.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";

// ── Class 1: a contentless assistant turn must never reach the wire ───────────────────────────

/**
 * The model occasionally returns nothing at all. The harness *deliberately continues* after that
 * (the empty-post-tool recovery answers it with a continuation user message), so the empty turn
 * stays in history and is replayed on every later request. Anthropic rejects `content: []`;
 * Bedrock's own guard turned it into a blank text block, which Converse rejects too. Either way a
 * single empty response bricked the rest of the session with a non-retryable 400.
 *
 * It cannot simply be dropped: Bedrock and Anthropic require strict user/assistant alternation,
 * and removing the assistant turn would leave two consecutive user messages. So it is filled.
 */
describe("contentless turns (all providers)", () => {
  const emptyAssistantTurn: AgentMessage[] = [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [] },
    { role: "user", content: "[Internal continuation] Continue working on the current task." },
  ];

  it("fills an empty assistant turn instead of dropping it — alternation must survive", () => {
    const out = fillEmptyMessageContent(emptyAssistantTurn);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1]!.content).not.toHaveLength(0);
  });

  it("the placeholder is non-blank — a blank text block is itself a 400", () => {
    const [msg] = fillEmptyMessageContent([{ role: "assistant", content: [] }]);
    const block = (msg!.content as Array<{ type: string; text: string }>)[0]!;
    expect(block.type).toBe("text");
    expect(block.text.trim().length).toBeGreaterThan(0);
  });

  it("treats a whitespace-only text block as contentless", () => {
    const [msg] = fillEmptyMessageContent([{ role: "assistant", content: [{ type: "text", text: "   \n  " }] }]);
    const block = (msg!.content as Array<{ text: string }>)[0]!;
    expect(block.text.trim().length).toBeGreaterThan(0);
  });

  it("treats an unsigned-thinking-only turn as contentless (both adapters drop unsigned blocks)", () => {
    const [msg] = fillEmptyMessageContent([
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned, will be stripped" }] },
    ]);
    const blocks = msg!.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text!.trim().length).toBeGreaterThan(0);
  });

  it("leaves a turn that carries real content completely alone", () => {
    const withToolUse: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } }] },
    ];
    expect(fillEmptyMessageContent(withToolUse)).toEqual(withToolUse);

    const signedThinking: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "reasoned", signature: "sig" }] },
    ];
    expect(fillEmptyMessageContent(signedThinking)).toEqual(signedThinking);
  });

  it("nonEmptyAssistantContent stops the bad shape being recorded in the first place", () => {
    expect(nonEmptyAssistantContent([])).toHaveLength(1);
    const kept = [{ type: "text" as const, text: "hi" }];
    expect(nonEmptyAssistantContent(kept)).toBe(kept);
  });

  it("normalizeForProvider applies the repair, so every provider path inherits it", () => {
    const out = normalizeForProvider(emptyAssistantTurn);
    const assistant = out.find((m) => m.role === "assistant")!;
    expect(assistant.content).not.toHaveLength(0);
  });

  it("serializes to a wire-valid Bedrock message — no blank text block", () => {
    const bedrock = toBedrockMessages(normalizeForProvider(emptyAssistantTurn));
    for (const msg of bedrock) {
      expect(msg.content.length).toBeGreaterThan(0);
      for (const block of msg.content) {
        if ("text" in block) expect(block.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("serializes to a wire-valid OpenAI message list", () => {
    const oai = toOpenAIMessages(normalizeForProvider(emptyAssistantTurn), "system");
    for (const msg of oai) {
      if (msg.role === "assistant" && !msg.tool_calls) {
        expect(String(msg.content ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ── Class 2: mid-stream failures must be classified, not blindly fatal ────────────────────────

/**
 * `_fetchWithRetry` only covers the pre-stream phase, so a failure reported *inside* a 200 stream
 * used to be thrown straight to the turn's terminal handler. ProviderStreamError carries the
 * retryability decision from the adapter that recognised the wire shape; the retry loop reads it
 * through isRetryableError, so this wiring is what turns a Bedrock throttle from a dead run into
 * a backoff.
 */
describe("mid-stream failure classification", () => {
  it("routes a retryable ProviderStreamError through isRetryableError", () => {
    expect(isRetryableError(new ProviderStreamError("throttled", true))).toBe(true);
  });

  it("keeps a fatal ProviderStreamError fatal — retrying a broken request just burns attempts", () => {
    expect(isRetryableError(new ProviderStreamError("validation failed", false))).toBe(false);
  });

  it("still treats a stalled stream as retryable", () => {
    expect(isRetryableError(new StreamIdleTimeoutError())).toBe(true);
  });

  it("does not retry a user cancellation", () => {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    expect(isRetryableError(abort)).toBe(false);
  });
});

// ── Class 3: refusals are terminal, not truncated turns ───────────────────────────────────────

/**
 * Every provider has a "declined on content grounds" stop reason, and every normalizer used to
 * dump them into `protocol_violation`. The loop reads protocol_violation as a cut-off response
 * and runs truncation recovery: revert the turn, double the output budget, re-ask. Against a
 * refusal that spends the whole auto-continue allowance re-provoking the same refusal — and on
 * Bedrock the doubling walks max_tokens toward the 64000 ceiling, which is how the original
 * death-spiral started.
 */
describe("refusal stop reasons (all providers)", () => {
  it("maps Bedrock guardrail/content-filter stops to refusal, not protocol_violation", () => {
    expect(normalizeBedrockStopReason("guardrail_intervened")).toBe("refusal");
    expect(normalizeBedrockStopReason("content_filtered")).toBe("refusal");
  });

  it("maps the Anthropic refusal stop to refusal", () => {
    expect(normalizeAnthropicStopReason("refusal")).toBe("refusal");
  });

  it("maps the OpenAI content_filter finish reason to refusal", () => {
    expect(normalizeOpenAIStopReason("content_filter")).toBe("refusal");
  });

  it("does not treat Anthropic's pause_turn as a malformed turn", () => {
    expect(normalizeAnthropicStopReason("pause_turn")).toBe("end_turn");
  });

  it("still reports a genuinely unknown stop reason as protocol_violation", () => {
    expect(normalizeBedrockStopReason("something_new")).toBe("protocol_violation");
    expect(normalizeAnthropicStopReason("something_new")).toBe("protocol_violation");
    expect(normalizeOpenAIStopReason("something_new")).toBe("protocol_violation");
  });

  it("keeps the ordinary stop reasons intact across every provider", () => {
    expect(normalizeBedrockStopReason("tool_use")).toBe("tool_use");
    expect(normalizeBedrockStopReason("max_tokens")).toBe("max_tokens");
    expect(normalizeBedrockStopReason("end_turn")).toBe("end_turn");
    expect(normalizeAnthropicStopReason("tool_use")).toBe("tool_use");
    expect(normalizeAnthropicStopReason("max_tokens")).toBe("max_tokens");
    expect(normalizeOpenAIStopReason("tool_calls")).toBe("tool_use");
    expect(normalizeOpenAIStopReason("length")).toBe("max_tokens");
    expect(normalizeOpenAIStopReason("stop")).toBe("end_turn");
  });
});

// ── Class 4: the thinking budget must not escape the output ceiling ───────────────────────────

/**
 * The output-ceiling half of the thinking plan. Uses a budget-era model (Sonnet 4.5) because the
 * bump-then-clamp interaction only exists for the token-budget dialect — adaptive thinking has no
 * budget to make room for. The dialect selection itself lives in thinking-request-shape.spec.ts.
 */
describe("thinking budget vs. the provider output ceiling", () => {
  const BEDROCK_CEILING = resolveOutputCeiling("anthropic.claude-sonnet-4-5", "bedrock");

  function budgetPlan(budgetTokens: number, configuredMaxTokens = 8192, ceiling = BEDROCK_CEILING) {
    const p = planThinking({
      model: "anthropic.claude-sonnet-4-5",
      provider: "bedrock",
      configuredMaxTokens,
      ceiling,
      thinkingEnabled: true,
      budgetTokens,
      effort: undefined,
      temperature: undefined,
    });
    return { maxTokens: p.maxTokens, budgetTokens: p.thinking.kind === "budget" ? p.thinking.budgetTokens : undefined };
  }

  it("knows Bedrock Claude's hard 64000 output ceiling", () => {
    expect(BEDROCK_CEILING).toBe(64_000);
  });

  /**
   * The exact configuration that 400'd every request: the thinking slider's maximum (64000) is
   * also Bedrock Claude's hard limit, so bumping max_tokens to budget + 1024 produced 65024.
   */
  it("never exceeds the ceiling when the budget is dialled to the slider maximum", () => {
    const { maxTokens, budgetTokens } = budgetPlan(64_000);
    expect(maxTokens).toBeLessThanOrEqual(64_000);
    expect(budgetTokens!).toBeLessThan(maxTokens);
  });

  it("keeps budget strictly below max_tokens after the clamp bites", () => {
    for (const budget of [60_000, 62_976, 63_000, 64_000, 100_000]) {
      const { maxTokens, budgetTokens } = budgetPlan(budget);
      expect(maxTokens, `budget=${budget}`).toBeLessThanOrEqual(64_000);
      expect(budgetTokens!, `budget=${budget}`).toBeLessThan(maxTokens);
    }
  });

  it("still raises max_tokens to fit a budget that comfortably fits under the ceiling", () => {
    const { maxTokens, budgetTokens } = budgetPlan(10_000);
    expect(budgetTokens).toBe(10_000);
    expect(maxTokens).toBe(11_024);
  });

  it("honours Anthropic's 1024-token budget floor", () => {
    expect(budgetPlan(10, 8192, null).budgetTokens).toBe(1024);
  });

  it("clamps a configured max_tokens that is already over the ceiling", () => {
    const p = planThinking({
      model: "anthropic.claude-sonnet-4-5", provider: "bedrock",
      configuredMaxTokens: 65_536, ceiling: BEDROCK_CEILING,
      thinkingEnabled: false, budgetTokens: 10_000, effort: undefined, temperature: undefined,
    });
    expect(p.maxTokens).toBe(64_000);
  });

  it("leaves the bump unclamped when the provider ceiling is unknown", () => {
    const { maxTokens, budgetTokens } = budgetPlan(64_000, 8192, null);
    expect(maxTokens).toBe(65_024);
    expect(budgetTokens).toBe(64_000);
  });

  /** OpenRouter's inverse bug: it set reasoning.max_tokens from the budget but never raised
   *  max_tokens, so the default 10000 budget against the default 8192 max_tokens 400'd on any
   *  routed Claude model (which requires max_tokens > budget_tokens). */
  it("gives OpenRouter a max_tokens above the reasoning budget", () => {
    const p = planThinking({
      model: "anthropic/claude-sonnet-4.5", provider: "openrouter",
      configuredMaxTokens: 8192, ceiling: resolveOutputCeiling("anthropic/claude-sonnet-4.5", "openrouter"),
      thinkingEnabled: true, budgetTokens: 10_000, effort: undefined, temperature: undefined,
    });
    expect(p.thinking.kind).toBe("budget");
    if (p.thinking.kind === "budget") expect(p.thinking.budgetTokens).toBeLessThan(p.maxTokens);
  });
});
