import { describe, expect, it } from "vitest";
import { validateToolInput } from "../../src/tools/definitions.js";

describe("validateToolInput", () => {
  it("flags a missing required field", () => {
    const issues = validateToolInput("shell_run", {});
    expect(issues).toEqual([{ path: "command", kind: "missing_required", message: "command is required." }]);
  });

  it("treats a blank string in a required field as missing", () => {
    const issues = validateToolInput("shell_run", { command: "   " });
    expect(issues.some((i) => i.path === "command" && i.kind === "missing_required")).toBe(true);
  });

  it("flags a wrong top-level type", () => {
    const issues = validateToolInput("shell_run", { command: "npm", args: "run build" });
    expect(issues).toContainEqual({ path: "args", kind: "invalid_type", message: "args must be array." });
  });

  it("accepts a well-formed call with no issues", () => {
    expect(validateToolInput("shell_run", { command: "npm", args: ["run", "build"] })).toEqual([]);
  });

  it("enforces an enum-constrained field", () => {
    const issues = validateToolInput("subagent_spawn", { task: "do it", complexity: "medium" });
    expect(issues).toContainEqual({
      path: "complexity",
      kind: "invalid_enum",
      message: "complexity must be one of: auto, standard, complex, deep.",
    });
  });

  it("accepts a valid enum value", () => {
    expect(validateToolInput("subagent_spawn", { task: "do it", complexity: "deep" })).toEqual([]);
  });

  it("returns no issues for an unknown tool (name errors are handled at dispatch, not here)", () => {
    expect(validateToolInput("totally_made_up_tool", { anything: 1 })).toEqual([]);
  });
});
