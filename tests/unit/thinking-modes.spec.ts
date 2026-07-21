/**
 * The per-model thinking dialect table.
 *
 * Getting this wrong is a hard 400 on every request, in both directions: an adaptive-era model
 * rejects `budget_tokens`, and a budget-era model rejects `adaptive`. The same model also arrives
 * spelled four different ways depending on the provider (`claude-opus-4-8`,
 * `us.anthropic.claude-opus-4-8-v1:0`, `anthropic/claude-opus-4.8`, a Bedrock ARN), so the
 * normalizer carries as much risk as the table itself.
 */
import { describe, expect, it } from "vitest";
import {
  acceptsSamplingParams,
  canDisableThinking,
  CLAUDE_EFFORT_LADDER,
  isFableFamily,
  needsSummarizedDisplay,
  parseClaudeVersion,
  resolveEffort,
  resolveThinkingMode,
  supportedEfforts,
  supportsFastMode,
  supportsTaskBudget,
  supportsThinking,
} from "../../src/thinking-modes.js";

describe("model id normalization", () => {
  it("recognises the same model across every provider's spelling", () => {
    const spellings = [
      "claude-opus-4-8",                                                        // Anthropic
      "anthropic.claude-opus-4-8",                                              // Bedrock Mantle
      "us.anthropic.claude-opus-4-8-v1:0",                                      // Bedrock inference profile
      "eu.anthropic.claude-opus-4-8",                                           // other region
      "anthropic/claude-opus-4.8",                                              // OpenRouter (dots!)
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-8-v1:0",
      "CLAUDE-OPUS-4-8",                                                        // case
    ];
    for (const id of spellings) {
      expect(parseClaudeVersion(id), id).toEqual({ family: "opus", major: 4, minor: 8 });
      expect(resolveThinkingMode(id), id).toBe("adaptive");
    }
  });

  it("strips a dated snapshot suffix", () => {
    expect(parseClaudeVersion("claude-sonnet-4-5-20250929")).toEqual({ family: "sonnet", major: 4, minor: 5 });
  });

  it("parses the legacy version-before-family ids", () => {
    expect(parseClaudeVersion("claude-3-7-sonnet-20250219")).toEqual({ family: "sonnet", major: 3, minor: 7 });
    expect(parseClaudeVersion("anthropic.claude-3-7-sonnet-20250219-v1:0")).toEqual({ family: "sonnet", major: 3, minor: 7 });
  });

  it("returns null for non-Claude models rather than guessing", () => {
    for (const id of ["gpt-5.2", "amazon.nova-pro-v1:0", "meta.llama3-70b", "google/gemini-2.5-pro", ""]) {
      expect(parseClaudeVersion(id), id).toBeNull();
      expect(resolveThinkingMode(id), id).toBe("none");
    }
  });
});

describe("thinking dialect per model", () => {
  const adaptive = [
    "claude-fable-5", "claude-mythos-5",
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-sonnet-5", "claude-sonnet-4-6",
  ];
  const budget = [
    "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0",
    "claude-sonnet-4-5", "claude-sonnet-4-0",
    "claude-haiku-4-5",
    "claude-3-7-sonnet-20250219",
  ];

  it.each(adaptive)("%s uses adaptive thinking", (id) => {
    expect(resolveThinkingMode(id)).toBe("adaptive");
    expect(supportsThinking(id)).toBe(true);
  });

  it.each(budget)("%s uses a token budget", (id) => {
    expect(resolveThinkingMode(id)).toBe("budget");
    expect(supportsThinking(id)).toBe(true);
  });

  it("has no thinking before Claude 3.7", () => {
    expect(resolveThinkingMode("claude-3-5-sonnet-20241022")).toBe("none");
    expect(supportsThinking("claude-3-5-haiku-20241022")).toBe(false);
  });

  /** The table is threshold-shaped so a model released after this code was written lands on the
   *  newest dialect rather than being sent a `budget_tokens` the API would reject. */
  it("assumes the newest dialect for models newer than anything in the table", () => {
    expect(resolveThinkingMode("claude-opus-4-9")).toBe("adaptive");
    expect(resolveThinkingMode("claude-opus-5")).toBe("adaptive");
    expect(resolveThinkingMode("claude-haiku-5")).toBe("adaptive");
    expect(resolveThinkingMode("claude-sonnet-6")).toBe("adaptive");
  });
});

describe("sampling parameters", () => {
  it("are rejected by the modern generation — a 400 even with thinking off", () => {
    for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
      expect(acceptsSamplingParams(id), id).toBe(false);
    }
  });

  it("are still accepted by the 4.6 pair and everything older", () => {
    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-7-sonnet"]) {
      expect(acceptsSamplingParams(id), id).toBe(true);
    }
  });

  it("leaves non-Claude models alone — their provider has its own rules", () => {
    expect(acceptsSamplingParams("gpt-5.2")).toBe(true);
    expect(acceptsSamplingParams("amazon.nova-pro-v1:0")).toBe(true);
  });
});

describe("effort rungs", () => {
  it("gives the full ladder (incl. xhigh) to the modern generation", () => {
    for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-fable-5"]) {
      expect(supportedEfforts(id), id).toEqual(CLAUDE_EFFORT_LADDER);
    }
  });

  it("omits xhigh on the 4.6 pair — it arrived with Opus 4.7", () => {
    expect(supportedEfforts("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(supportedEfforts("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
  });

  it("gives Opus 4.5 only low/medium/high", () => {
    expect(supportedEfforts("claude-opus-4-5")).toEqual(["low", "medium", "high"]);
  });

  it("gives no effort at all to models where the parameter errors", () => {
    for (const id of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-7-sonnet", "gpt-5.2"]) {
      expect(supportedEfforts(id), id).toEqual([]);
    }
  });
});

describe("resolveEffort", () => {
  it("passes a supported rung through", () => {
    expect(resolveEffort("claude-opus-4-8", "xhigh")).toBe("xhigh");
    expect(resolveEffort("claude-opus-4-8", "max")).toBe("max");
  });

  it("defaults to high when nothing is set — Anthropic's own default", () => {
    expect(resolveEffort("claude-opus-4-8", undefined)).toBe("high");
  });

  /** A persisted "xhigh" from Opus 4.8 must not 400 after switching to Sonnet 4.6, which has no
   *  xhigh rung. Clamp down the ladder rather than sending it. */
  it("clamps a rung the model doesn't have down to the nearest one it does", () => {
    expect(resolveEffort("claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(resolveEffort("claude-opus-4-5", "max")).toBe("high");
    expect(resolveEffort("claude-opus-4-5", "xhigh")).toBe("high");
  });

  it("returns undefined when the model takes no effort parameter", () => {
    expect(resolveEffort("claude-haiku-4-5", "high")).toBeUndefined();
    expect(resolveEffort("gpt-5.2", "high")).toBeUndefined();
  });
});

describe("display and disable rules", () => {
  /** The modern generation defaults display to "omitted": thinking blocks stream with empty text.
   *  Without opting into "summarized" the reasoning panel sits blank while the model thinks. */
  it("needs summarized display on the modern generation only", () => {
    expect(needsSummarizedDisplay("claude-opus-4-8")).toBe(true);
    expect(needsSummarizedDisplay("claude-sonnet-5")).toBe(true);
    expect(needsSummarizedDisplay("claude-fable-5")).toBe(true);
    // The 4.6 pair already defaults to summarized.
    expect(needsSummarizedDisplay("claude-opus-4-6")).toBe(false);
    expect(needsSummarizedDisplay("claude-sonnet-4-6")).toBe(false);
  });

  it("cannot disable thinking on Fable/Mythos — they think unconditionally and 400 on disabled", () => {
    expect(canDisableThinking("claude-fable-5")).toBe(false);
    expect(canDisableThinking("claude-mythos-5")).toBe(false);
  });

  it("can disable thinking everywhere else", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(canDisableThinking(id), id).toBe(true);
    }
  });
});

describe("supportsFastMode (beta, Opus 4.8/4.7 only)", () => {
  it("true for Opus 4.7 and 4.8", () => {
    expect(supportsFastMode("claude-opus-4-8")).toBe(true);
    expect(supportsFastMode("claude-opus-4-7")).toBe(true);
  });

  it("false for older Opus, other families, and Fable — fast mode is Opus-tier only", () => {
    expect(supportsFastMode("claude-opus-4-6")).toBe(false);
    expect(supportsFastMode("claude-opus-4-5")).toBe(false);
    expect(supportsFastMode("claude-sonnet-5")).toBe(false);
    expect(supportsFastMode("claude-haiku-4-5")).toBe(false);
    expect(supportsFastMode("claude-fable-5")).toBe(false);
  });

  it("false for a non-Claude or unrecognized id", () => {
    expect(supportsFastMode("gpt-5.1")).toBe(false);
    expect(supportsFastMode(undefined)).toBe(false);
  });
});

describe("supportsTaskBudget (beta, Fable5/Sonnet5/Opus4.8/4.7)", () => {
  it("true for the documented eligible set", () => {
    for (const id of ["claude-fable-5", "claude-mythos-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect(supportsTaskBudget(id), id).toBe(true);
    }
  });

  it("false for Sonnet 4.6, Haiku, and older Opus — not eligible per the docs", () => {
    for (const id of ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6", "claude-opus-4-5"]) {
      expect(supportsTaskBudget(id), id).toBe(false);
    }
  });
});

describe("isFableFamily", () => {
  it("true for Fable 5 and Mythos 5, across provider spellings", () => {
    expect(isFableFamily("claude-fable-5")).toBe(true);
    expect(isFableFamily("claude-mythos-5")).toBe(true);
    expect(isFableFamily("anthropic.claude-fable-5")).toBe(true);
    expect(isFableFamily("us.anthropic.claude-fable-5")).toBe(true);
  });

  it("false for every other Claude family and non-Claude ids", () => {
    expect(isFableFamily("claude-opus-4-8")).toBe(false);
    expect(isFableFamily("claude-sonnet-5")).toBe(false);
    expect(isFableFamily("gpt-5.1")).toBe(false);
    expect(isFableFamily(undefined)).toBe(false);
  });
});
