import { describe, expect, it } from "vitest";
import {
  buildAnthropicSystemBlocks, resolveAnthropicBetaExtras, withOpenRouterCacheControl,
  withRollingCacheBreakpoint,
} from "../../src/agent-session.js";

// Beta-feature wiring: fast mode, task budgets, context editing, and Fable's refusal fallback
// are each a beta header + a body field, gated per model family and per surface (Anthropic-direct
// vs Bedrock Mantle). Getting a gate wrong either silently no-ops the feature or sends a param a
// model/surface rejects with a 400 on every turn — so each gate gets its own pinned case.

describe("resolveAnthropicBetaExtras", () => {
  it("returns nothing when no beta feature is opted into", () => {
    const extras = resolveAnthropicBetaExtras("claude-opus-4-8", {}, false);
    expect(extras.betas).toEqual([]);
    expect(extras.bodyExtras).toEqual({});
    expect(extras.taskBudgetTokens).toBeUndefined();
  });

  describe("fast mode", () => {
    it("enables on an eligible Opus 4.8/4.7 model, Anthropic-direct only", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { fastMode: true }, false);
      expect(extras.bodyExtras["speed"]).toBe("fast");
      expect(extras.betas).toContain("fast-mode-2026-02-01");
    });

    it("no-ops on an ineligible model (Sonnet, Haiku, Fable, older Opus)", () => {
      for (const model of ["claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5", "claude-opus-4-6"]) {
        const extras = resolveAnthropicBetaExtras(model, { fastMode: true }, false);
        expect(extras.bodyExtras["speed"]).toBeUndefined();
        expect(extras.betas).not.toContain("fast-mode-2026-02-01");
      }
    });

    it("no-ops on Mantle even for an eligible model — first-party API only", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { fastMode: true }, true);
      expect(extras.bodyExtras["speed"]).toBeUndefined();
      expect(extras.betas).not.toContain("fast-mode-2026-02-01");
    });
  });

  describe("task budget", () => {
    it("clamps up to the 20,000-token minimum and sets the beta header, Anthropic-direct only", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { taskBudgetTokens: 5000 }, false);
      expect(extras.taskBudgetTokens).toBe(20_000);
      expect(extras.betas).toContain("task-budgets-2026-03-13");
    });

    it("passes a larger value through unchanged", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { taskBudgetTokens: 64_000 }, false);
      expect(extras.taskBudgetTokens).toBe(64_000);
    });

    it("is eligible on Fable 5, Sonnet 5, Opus 4.8/4.7 — not Sonnet 4.6, Haiku, or older Opus", () => {
      for (const model of ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
        expect(resolveAnthropicBetaExtras(model, { taskBudgetTokens: 30_000 }, false).taskBudgetTokens).toBe(30_000);
      }
      for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"]) {
        expect(resolveAnthropicBetaExtras(model, { taskBudgetTokens: 30_000 }, false).taskBudgetTokens).toBeUndefined();
      }
    });

    it("no-ops on Mantle — not available on Amazon Bedrock", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { taskBudgetTokens: 30_000 }, true);
      expect(extras.taskBudgetTokens).toBeUndefined();
      expect(extras.betas).not.toContain("task-budgets-2026-03-13");
    });
  });

  describe("context editing", () => {
    it("sets context_management.edits and the beta header on both Anthropic-direct and Mantle", () => {
      for (const isMantle of [false, true]) {
        const extras = resolveAnthropicBetaExtras("claude-sonnet-5", { contextEditingEnabled: true }, isMantle);
        expect(extras.bodyExtras["context_management"]).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }] });
        expect(extras.betas).toContain("context-management-2025-06-27");
      }
    });

    it("is model-independent — no eligibility gate", () => {
      const extras = resolveAnthropicBetaExtras("claude-3-7-sonnet-20250219", { contextEditingEnabled: true }, false);
      expect(extras.bodyExtras["context_management"]).toBeDefined();
    });
  });

  describe("compaction", () => {
    it("sets the compact_20260112 edit with the trigger and beta header, on both surfaces", () => {
      for (const isMantle of [false, true]) {
        const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { compactionTriggerTokens: 100_000 }, isMantle);
        expect(extras.bodyExtras["context_management"]).toEqual({
          edits: [{
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 100_000 },
            pause_after_compaction: false,
            instructions: null,
          }],
        });
        expect(extras.betas).toContain("compact-2026-01-12");
      }
    });

    it("clamps up to the 50,000-token minimum", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", { compactionTriggerTokens: 10_000 }, false);
      expect(extras.bodyExtras["context_management"]).toMatchObject({ edits: [{ trigger: { value: 50_000 } }] });
    });

    it("is model-independent — no eligibility gate", () => {
      const extras = resolveAnthropicBetaExtras("claude-3-7-sonnet-20250219", { compactionTriggerTokens: 80_000 }, false);
      expect(extras.bodyExtras["context_management"]).toBeDefined();
    });

    // Regression: context editing and compaction both target context_management.edits. A plain
    // `bodyExtras["context_management"] = {...}` assignment per feature (rather than building
    // one shared array) would make the second toggle silently overwrite the first, so a session
    // with both on would only ever get whichever was written last — no error, just one of the
    // two features quietly doing nothing.
    it("coexists with context editing in ONE context_management.edits array — neither silently overwrites the other", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", {
        contextEditingEnabled: true,
        compactionTriggerTokens: 100_000,
      }, false);
      const edits = (extras.bodyExtras["context_management"] as { edits: Array<Record<string, unknown>> }).edits;
      expect(edits).toHaveLength(2);
      expect(edits.map((e) => e["type"])).toEqual(["clear_tool_uses_20250919", "compact_20260112"]);
      expect(extras.betas).toContain("context-management-2025-06-27");
      expect(extras.betas).toContain("compact-2026-01-12");
    });
  });

  describe("refusal fallback", () => {
    it("defaults on for Fable/Mythos models, Anthropic-direct only", () => {
      for (const model of ["claude-fable-5", "claude-mythos-5"]) {
        const extras = resolveAnthropicBetaExtras(model, {}, false);
        expect(extras.bodyExtras["fallbacks"]).toEqual([{ model: "claude-opus-4-8" }]);
        expect(extras.betas).toContain("server-side-fallback-2026-06-01");
      }
    });

    it("explicit false disables it", () => {
      const extras = resolveAnthropicBetaExtras("claude-fable-5", { refusalFallbackEnabled: false }, false);
      expect(extras.bodyExtras["fallbacks"]).toBeUndefined();
      expect(extras.betas).not.toContain("server-side-fallback-2026-06-01");
    });

    it("no-ops on a non-Fable model even when nothing disables it", () => {
      const extras = resolveAnthropicBetaExtras("claude-opus-4-8", {}, false);
      expect(extras.bodyExtras["fallbacks"]).toBeUndefined();
    });

    it("no-ops on Mantle for a Fable model — server-side param unavailable there", () => {
      const extras = resolveAnthropicBetaExtras("claude-fable-5", {}, true);
      expect(extras.bodyExtras["fallbacks"]).toBeUndefined();
      expect(extras.betas).not.toContain("server-side-fallback-2026-06-01");
    });

    it("recognizes the Bedrock Mantle id decoration (anthropic.claude-fable-5)", () => {
      // isFableFamily must still fire through the normal Claude-id normalizer even though this
      // path never sends the fallback (Mantle is excluded) — this pins that recognition doesn't
      // silently break for the Mantle-catalog id shape.
      const extras = resolveAnthropicBetaExtras("anthropic.claude-fable-5", {}, false);
      expect(extras.bodyExtras["fallbacks"]).toEqual([{ model: "claude-opus-4-8" }]);
    });
  });

  it("combines multiple features into one beta header list and body", () => {
    const extras = resolveAnthropicBetaExtras("claude-opus-4-8", {
      fastMode: true,
      taskBudgetTokens: 40_000,
      contextEditingEnabled: true,
    }, false);
    expect(extras.betas.sort()).toEqual([
      "context-management-2025-06-27",
      "fast-mode-2026-02-01",
      "task-budgets-2026-03-13",
    ].sort());
    expect(extras.bodyExtras["speed"]).toBe("fast");
    expect(extras.taskBudgetTokens).toBe(40_000);
  });
});

describe("cache TTL threading", () => {
  it("system blocks default to the bare ephemeral shape (no ttl field) with no cacheTtl arg", () => {
    const blocks = buildAnthropicSystemBlocks("system prompt", "");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("system blocks add ttl:1h only when explicitly requested", () => {
    const blocks = buildAnthropicSystemBlocks("system prompt", "", "1h");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("'5m' is byte-identical to the default (no ttl field)", () => {
    const blocks = buildAnthropicSystemBlocks("system prompt", "", "5m");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("the rolling message breakpoint honors the ttl too", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const out = withRollingCacheBreakpoint(messages, "1h");
    const content = out[0]!.content as unknown as Array<{ cache_control?: unknown }>;
    expect(content[content.length - 1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("the OpenRouter cache breakpoint honors the ttl too", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const out = withOpenRouterCacheControl(messages, "1h");
    const content = out[0]!.content as unknown as Array<{ cache_control?: unknown }>;
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
