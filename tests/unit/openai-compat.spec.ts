import { describe, expect, it } from "vitest";
import { resolveReasoningEffort, supportedReasoningEfforts, toOpenRouterReasoningEffort } from "../../src/agent-session.js";
import type { OpenAIReasoningEffort } from "../../src/agent-session.js";
import {
  effectiveOpenRouterEffort,
  effectiveReasoningEffort,
  isOpenRouterReasoningModel,
  supportedReasoningEfforts as webviewSupportedEfforts,
} from "../../src/webview/react/components/settings/helpers.js";

describe("supportedReasoningEfforts", () => {
  it("gives o-series models the classic three rungs", () => {
    expect(supportedReasoningEfforts("o3-mini")).toEqual(["low", "medium", "high"]);
    expect(supportedReasoningEfforts("o4-mini-high")).toEqual(["low", "medium", "high"]);
  });

  it("gives gpt-5 base the minimal rung but not none/xhigh", () => {
    expect(supportedReasoningEfforts("gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
    expect(supportedReasoningEfforts("gpt-5-mini")).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("gives gpt-5.1 the none rung, and codex-max additionally xhigh", () => {
    expect(supportedReasoningEfforts("gpt-5.1")).toEqual(["none", "low", "medium", "high"]);
    expect(supportedReasoningEfforts("gpt-5.1-codex-max")).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  it("gives gpt-5.6 and later none/low/medium/high/xhigh/max — no minimal", () => {
    // Confirmed: minimal was dropped at 5.1 and never came back; 5.6 added "max" as the
    // new top rung above xhigh. "ultra" is a separate multi-agent orchestration mode, not
    // a reasoning_effort value, and must never appear here.
    const ladder = ["none", "low", "medium", "high", "xhigh", "max"];
    expect(supportedReasoningEfforts("gpt-5.6")).toEqual(ladder);
    expect(supportedReasoningEfforts("gpt-5.6-terra")).toEqual(ladder);
    expect(supportedReasoningEfforts("gpt-5.6-luna")).toEqual(ladder);
    expect(supportedReasoningEfforts("gpt-5.6-sol")).toEqual(ladder);
    expect(supportedReasoningEfforts("gpt-5.2-codex")).toEqual(ladder);
    expect(supportedReasoningEfforts("gpt-6")).toEqual(ladder);
    expect(ladder).not.toContain("ultra");
    expect(ladder).not.toContain("minimal");
  });

  it("webview mirror agrees with the host table", () => {
    for (const model of ["o3-mini", "gpt-5", "gpt-5.1", "gpt-5.1-codex-max", "gpt-5.6", "gpt-6"]) {
      expect(webviewSupportedEfforts(model)).toEqual(supportedReasoningEfforts(model));
    }
  });
});

describe("resolveReasoningEffort", () => {
  it("passes a supported rung through unchanged", () => {
    expect(resolveReasoningEffort("gpt-5.6", "xhigh")).toBe("xhigh");
    expect(resolveReasoningEffort("gpt-5.6", "max")).toBe("max");
    expect(resolveReasoningEffort("o3", "medium")).toBe("medium");
  });

  it("clamps a too-deep rung down to the nearest supported one", () => {
    expect(resolveReasoningEffort("gpt-5.1", "xhigh")).toBe("high");
    expect(resolveReasoningEffort("gpt-5.1", "max")).toBe("high");
    expect(resolveReasoningEffort("o3-mini", "xhigh")).toBe("high");
    expect(resolveReasoningEffort("o3-mini", "max")).toBe("high");
  });

  it("clamps a too-shallow rung to the nearest supported one", () => {
    // 5.1 replaced "minimal" with "none" — nearest shallower rung.
    expect(resolveReasoningEffort("gpt-5.1", "minimal")).toBe("none");
    // o-series has nothing below low: nearest deeper rung wins.
    expect(resolveReasoningEffort("o3-mini", "none")).toBe("low");
    expect(resolveReasoningEffort("o3-mini", "minimal")).toBe("low");
  });

  it("returns undefined when no effort was requested", () => {
    expect(resolveReasoningEffort("gpt-5.6", undefined)).toBeUndefined();
  });
});

describe("effectiveReasoningEffort (webview display value)", () => {
  it("keeps a persisted rung the model supports", () => {
    expect(effectiveReasoningEffort("gpt-5.6", "xhigh")).toBe("xhigh");
  });

  it("falls back to medium when the persisted rung isn't supported by the model", () => {
    expect(effectiveReasoningEffort("o3-mini", "xhigh")).toBe("medium");
    expect(effectiveReasoningEffort("gpt-5", undefined)).toBe("medium");
  });
});

describe("toOpenRouterReasoningEffort (unified reasoning param vocabulary)", () => {
  it("collapses the full OpenAI ladder onto low/medium/high", () => {
    expect(toOpenRouterReasoningEffort("minimal")).toBe("low");
    expect(toOpenRouterReasoningEffort("low")).toBe("low");
    expect(toOpenRouterReasoningEffort("medium")).toBe("medium");
    expect(toOpenRouterReasoningEffort("high")).toBe("high");
    expect(toOpenRouterReasoningEffort("xhigh")).toBe("high");
    expect(toOpenRouterReasoningEffort("max")).toBe("high");
  });

  it("returns undefined for 'none' — the unified param enables reasoning, so off = send nothing", () => {
    expect(toOpenRouterReasoningEffort("none")).toBeUndefined();
  });

  it("webview display mirror agrees with the host mapping on every rung", () => {
    const ladder: OpenAIReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const effort of ladder) {
      expect(effectiveOpenRouterEffort(effort)).toBe(toOpenRouterReasoningEffort(effort) ?? "none");
    }
    expect(effectiveOpenRouterEffort(undefined)).toBe("none");
  });
});

describe("isOpenRouterReasoningModel (which OR models get the effort control)", () => {
  const info = (supportsThinking: boolean) => ({
    id: "x", name: "x", supportsThinking, source: "api" as const,
  });

  it("true for non-Claude reasoning models, by id heuristic or catalog flag", () => {
    expect(isOpenRouterReasoningModel("openai/gpt-5.1", null)).toBe(true);
    expect(isOpenRouterReasoningModel("openai/o3", null)).toBe(true);
    expect(isOpenRouterReasoningModel("google/gemini-2.5-pro", info(true))).toBe(true);
    expect(isOpenRouterReasoningModel("deepseek/deepseek-r1", info(true))).toBe(true);
  });

  it("false for Claude-routed models — their reasoning rides the thinking toggle", () => {
    expect(isOpenRouterReasoningModel("anthropic/claude-sonnet-4.6", info(true))).toBe(false);
    expect(isOpenRouterReasoningModel("anthropic/claude-opus-4.8", null)).toBe(false);
  });

  it("false for plain non-reasoning models", () => {
    expect(isOpenRouterReasoningModel("openai/gpt-4o", info(false))).toBe(false);
    expect(isOpenRouterReasoningModel("meta-llama/llama-3.1-70b-instruct", info(false))).toBe(false);
  });
});
