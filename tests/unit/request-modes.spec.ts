import { describe, expect, it } from "vitest";
import {
  buildRequestModePrompt,
  isRequestMode,
  resolveRequestMode,
} from "../../src/request-modes.js";

describe("request modes", () => {
  it("accepts only supported protocol values", () => {
    expect(isRequestMode("auto")).toBe(true);
    expect(isRequestMode("plan")).toBe(true);
    expect(isRequestMode("research")).toBe(false);
    expect(isRequestMode(null)).toBe(false);
  });

  it("honors explicit modes and conservatively routes Auto", () => {
    expect(resolveRequestMode("plan", "implement this now")).toBe("plan");
    expect(resolveRequestMode("auto", "Create an implementation plan, but do not implement it.")).toBe("plan");
    expect(resolveRequestMode("auto", "Please plan how this migration should be implemented.")).toBe("plan");
    expect(resolveRequestMode("auto", "Review this diff for regressions and test gaps.")).toBe("review");
    expect(resolveRequestMode("auto", "Debug the crash and fix the root cause.")).toBe("debug");
    expect(resolveRequestMode("auto", "Review the code and resolve any bugs you find.")).toBe("debug");
    expect(resolveRequestMode("auto", "Explain how this module works.")).toBe("general");
  });

  it("gives planning a research, questioning, and durable-artifact contract", () => {
    const prompt = buildRequestModePrompt("plan");
    expect(prompt).toContain("Stay read-only");
    expect(prompt).toContain("question_card");
    expect(prompt).toContain("plan_doc_write");
    expect(prompt).toContain("every consequential phase");
    expect(prompt).toContain("acceptance criteria");
    expect(prompt).toContain("art-direction forks");
    expect(prompt).toContain("WebGL/WebGPU");
    expect(prompt).toContain("do not lower the ambition");
  });

  it("keeps review and debug behavior materially distinct", () => {
    const review = buildRequestModePrompt("review");
    const debug = buildRequestModePrompt("debug");
    expect(review).toContain("Default to read-only analysis");
    expect(review).toContain("findings ordered by severity");
    expect(debug).toContain("ranked hypothesis set");
    expect(debug).toContain("regression test");
    expect(buildRequestModePrompt("general")).toBe("");
  });
});
