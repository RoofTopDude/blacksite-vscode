import { describe, expect, it } from "vitest";
import { summarizeResult } from "../../src/agent-session.js";

/**
 * summarizeResult is what the MODEL sees as a tool result's one-line summary (distinct from
 * tool-presentation.ts's shellPreview, which is what the user sees in the webview — both
 * needed the same fix, since exitCode: null on a shell_run spawn failure fell through to the
 * generic "OK" fallback in both places).
 */
describe("summarizeResult", () => {
  it("summarizes a real exit code", () => {
    expect(summarizeResult({ ok: true, exitCode: 0 })).toBe("exit 0");
    expect(summarizeResult({ ok: true, exitCode: 1 })).toBe("exit 1");
  });

  it("reports a spawn failure (exitCode: null) instead of falling through to OK", () => {
    expect(summarizeResult({ ok: true, exitCode: null, stderr: "spawn node ENOENT", timedOut: false }))
      .toBe("spawn failed: spawn node ENOENT");
  });

  it("truncates a long stderr in the spawn-failure summary", () => {
    const stderr = "x".repeat(200);
    const summary = summarizeResult({ ok: true, exitCode: null, stderr, timedOut: false });
    expect(summary.startsWith("spawn failed: ")).toBe(true);
    expect(summary.length).toBeLessThan(100);
  });

  it("falls back to a bare label when exitCode is null with no stderr", () => {
    expect(summarizeResult({ ok: true, exitCode: null, stderr: "", timedOut: false })).toBe("spawn failed");
  });

  it("does not treat a timeout kill (also exitCode: null) as a spawn failure", () => {
    expect(summarizeResult({ ok: true, exitCode: null, stderr: "", timedOut: true })).toBe("OK");
  });

  it("still falls through to OK for non-shell results", () => {
    expect(summarizeResult({ ok: true })).toBe("OK");
    expect(summarizeResult(null)).toBe("Done");
  });
});
