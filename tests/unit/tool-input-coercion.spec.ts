import { describe, expect, it } from "vitest";
import { coerceToolInput, suggestToolName, validateToolInput } from "../../src/tools/definitions.js";

describe("coerceToolInput", () => {
  it("coerces a numeric string into a number field", () => {
    const out = coerceToolInput("shell_run", { command: "npm", timeout: "60000" });
    expect(out["timeout"]).toBe(60000);
  });

  it("coerces 'true'/'false' strings into boolean fields", () => {
    expect(coerceToolInput("shell_run", { command: "x", confirmed: "true" })["confirmed"]).toBe(true);
    expect(coerceToolInput("shell_run", { command: "x", confirmed: "False" })["confirmed"]).toBe(false);
  });

  it("coerces a number into a string field (github issue numbers)", () => {
    const out = coerceToolInput("github_get_issue", { owner: "a", repo: "b", number: 42 });
    expect(out["number"]).toBe("42");
  });

  it("parses a JSON-stringified array for an array field", () => {
    const out = coerceToolInput("shell_run", { command: "npm", args: '["run","build"]' });
    expect(out["args"]).toEqual(["run", "build"]);
  });

  it("parses a JSON-stringified object for an object field", () => {
    const out = coerceToolInput("code_navigate", { target: '{"path":"src/a.ts","symbol":"main"}', kind: "definition" });
    expect(out["target"]).toEqual({ path: "src/a.ts", symbol: "main" });
  });

  it("canonicalizes a wrong-case enum value", () => {
    expect(coerceToolInput("git_op", { op: "Status" })["op"]).toBe("status");
    expect(coerceToolInput("code_navigate", { target: { path: "a.ts" }, kind: "REFERENCES" })["kind"]).toBe("references");
  });

  it("coerces nested array-item fields (browser_run_script steps)", () => {
    const out = coerceToolInput("browser_run_script", {
      steps: [
        { action: "Navigate", url: "https://x.dev", waitFor: "NetworkIdle" },
        { action: "wait", timeoutMs: "500" },
      ],
    });
    const steps = out["steps"] as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ action: "navigate", waitFor: "networkidle" });
    expect(steps[1]).toMatchObject({ action: "wait", timeoutMs: 500 });
  });

  it("coercion output passes validation where the raw input failed", () => {
    const raw = { command: "npm", args: '["test"]', timeout: "1000" };
    expect(validateToolInput("shell_run", raw).length).toBeGreaterThan(0);
    expect(validateToolInput("shell_run", coerceToolInput("shell_run", raw))).toEqual([]);
  });

  it("leaves ambiguous or unknown values untouched for validation to report", () => {
    const out = coerceToolInput("shell_run", { command: "x", timeout: "soon", args: "not json" });
    expect(out["timeout"]).toBe("soon");
    expect(out["args"]).toBe("not json");
  });

  it("leaves an enum value with no case-insensitive match untouched", () => {
    expect(coerceToolInput("git_op", { op: "yank" })["op"]).toBe("yank");
  });

  it("passes through input for an unknown tool without throwing", () => {
    const input = { a: 1 };
    expect(coerceToolInput("no_such_tool", input)).toBe(input);
  });

  it("normalizes null/undefined arguments to empty args instead of throwing", () => {
    // JSON.parse("null") is a known slop pattern for no-arg calls on the OpenAI wire.
    expect(coerceToolInput("memory_read", null as unknown as Record<string, unknown>)).toEqual({});
    expect(coerceToolInput("memory_read", undefined as unknown as Record<string, unknown>)).toEqual({});
  });

  it("passes non-object arguments through for validation to report", () => {
    const arr = [1, 2] as unknown as Record<string, unknown>;
    expect(coerceToolInput("shell_run", arr)).toBe(arr);
    const issues = validateToolInput("shell_run", arr);
    expect(issues).toEqual([{ path: "", kind: "invalid_type", message: "Tool arguments must be a JSON object." }]);
  });

  it("never mutates the original input", () => {
    const input = { command: "npm", timeout: "1000", args: '["x"]' };
    coerceToolInput("shell_run", input);
    expect(input.timeout).toBe("1000");
    expect(input.args).toBe('["x"]');
  });
});

describe("validateToolInput (nested)", () => {
  it("flags a missing required field inside an array item with a qualified path", () => {
    const issues = validateToolInput("file_edit_batch", {
      edits: [
        { path: "a.ts", oldString: "x", newString: "y" },
        { path: "b.ts", oldString: "x" },
      ],
    });
    expect(issues).toEqual([
      { path: "edits[1].newString", kind: "missing_required", message: "edits[1].newString is required." },
    ]);
  });

  it("flags a bad nested enum value", () => {
    // Deliberately a verb the browser adapter will never have. This used to be "hover", which
    // stopped being a useful example once hover became a real action.
    const issues = validateToolInput("browser_run_script", { steps: [{ action: "teleport" }] });
    expect(issues.some((i) => i.path === "steps[0].action" && i.kind === "invalid_enum")).toBe(true);
  });

  it("flags a wrong nested type", () => {
    const issues = validateToolInput("file_edit_batch", { edits: [{ path: 5, oldString: "a", newString: "b" }] });
    expect(issues).toContainEqual({ path: "edits[0].path", kind: "invalid_type", message: "edits[0].path must be string." });
  });

  it("does not descend into free-form object fields with no declared properties", () => {
    expect(validateToolInput("jira_update_issue", { host: "https://j", key: "K-1", fields: { anything: { nested: true } } })).toEqual([]);
  });

  it("accepts a fully valid nested payload", () => {
    expect(validateToolInput("file_edit_batch", { edits: [{ path: "a.ts", oldString: "x", newString: "y", replaceAll: true }] })).toEqual([]);
  });
});

describe("suggestToolName", () => {
  it("suggests the nearest tool for a typo", () => {
    expect(suggestToolName("file_reed")).toBe("file_read");
  });

  it("matches case/punctuation variants exactly", () => {
    expect(suggestToolName("fileRead")).toBe("file_read");
    expect(suggestToolName("Shell_Run")).toBe("shell_run");
    expect(suggestToolName("browser.navigate")).toBe("browser_navigate");
  });

  it("returns undefined for a far-off name rather than a misleading suggestion", () => {
    expect(suggestToolName("summon_kraken")).toBeUndefined();
  });

  it("suggests only from the provided candidate list (the session's advertised tools)", () => {
    // file_read exists globally but isn't advertised here — suggesting it would send the
    // model into a second rejection.
    expect(suggestToolName("file_reed", ["shell_run", "git_op"])).toBeUndefined();
    expect(suggestToolName("shel_run", ["shell_run", "git_op"])).toBe("shell_run");
  });
});
