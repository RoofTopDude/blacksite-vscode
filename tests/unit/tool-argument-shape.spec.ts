import { describe, expect, it } from "vitest";
import { describeExpectedToolShape, unknownToolArguments, validateToolInput } from "../../src/tools/definitions.js";

/* A wrongly shaped call used to get only "text is required. target must be object." and the
   same wrong guess recurred in later sessions. The error now carries the shape that works. */
describe("expected tool argument shape", () => {
  it("shows code_replace's nested target and its required text", () => {
    const shape = describeExpectedToolShape("code_replace")!;
    expect(shape).toMatch(/^\{ target: \{ path: string/);
    expect(shape).toContain("symbol?: string");
    expect(shape).toContain("text: string");
    expect(shape).toContain("endLine?: number");
  });

  it("names arguments the tool does not have", () => {
    const input = { target: "src/a.ts:fetchModels", replacement: "x" };
    expect(validateToolInput("code_replace", input).map((issue) => issue.message).join(" ")).toContain("text is required");
    expect(unknownToolArguments("code_replace", input)).toEqual(["replacement"]);
  });

  it("knows nothing about a tool it has no schema for", () => {
    expect(describeExpectedToolShape("no_such_tool")).toBeUndefined();
    expect(unknownToolArguments("no_such_tool", { a: 1 })).toEqual([]);
  });
});
