import { describe, expect, it } from "vitest";
import { findWhitespaceTolerantMatch } from "../../src/diff-edit-service.js";

// Regression for the recurring "oldString was not found" failures — the cause was
// cosmetic whitespace drift, not genuinely absent code.
describe("findWhitespaceTolerantMatch", () => {
  const file = "function add(a, b) {\n\treturn a + b;\n}\n";

  it("matches across tab/space indentation differences", () => {
    // oldString uses spaces where the file uses a tab.
    const match = findWhitespaceTolerantMatch(file, "function add(a, b) {\n    return a + b;\n}");
    expect(match).toBe("function add(a, b) {\n\treturn a + b;\n}");
  });

  it("matches across trailing-whitespace and final-newline differences", () => {
    const match = findWhitespaceTolerantMatch(file, "\treturn a + b;   ");
    expect(match).toBe("\treturn a + b;");
  });

  it("returns null when the region is genuinely absent", () => {
    expect(findWhitespaceTolerantMatch(file, "return a - b;")).toBeNull();
  });

  it("refuses an ambiguous match rather than risk editing the wrong place", () => {
    const dup = "x = 1;\nx = 1;\n";
    expect(findWhitespaceTolerantMatch(dup, "x = 1;")).toBeNull();
  });

  it("ignores an empty needle", () => {
    expect(findWhitespaceTolerantMatch(file, "")).toBeNull();
  });
});
