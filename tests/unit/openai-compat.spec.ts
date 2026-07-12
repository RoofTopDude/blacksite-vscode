import { describe, expect, it } from "vitest";
import { resolveReasoningEffort, supportedReasoningEfforts } from "../../src/agent-session.js";
import {
  effectiveReasoningEffort,
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

  it("gives newer 5.x models (incl. 5.6) and future majors the full ladder", () => {
    const full = ["none", "minimal", "low", "medium", "high", "xhigh"];
    expect(supportedReasoningEfforts("gpt-5.6")).toEqual(full);
    expect(supportedReasoningEfforts("gpt-5.2-codex")).toEqual(full);
    expect(supportedReasoningEfforts("gpt-6")).toEqual(full);
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
    expect(resolveReasoningEffort("o3", "medium")).toBe("medium");
  });

  it("clamps a too-deep rung down to the nearest supported one", () => {
    expect(resolveReasoningEffort("gpt-5.1", "xhigh")).toBe("high");
    expect(resolveReasoningEffort("o3-mini", "xhigh")).toBe("high");
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
