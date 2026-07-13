import { describe, expect, it } from "vitest";
import { findWhitespaceTolerantMatch, resolveNewString, resolveOldString } from "../../src/diff-edit-service.js";

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

/**
 * A model that rebuilds a snippet from a numbered source (a lineNumbers file_read, a file_search
 * hit, a paged output dump) sends back an oldString the file cannot contain. Recovering from that
 * is only safe because a de-guttered candidate must be *found in the file* before it is adopted —
 * see the false-positive case below, which is exactly what that rule protects.
 */
describe("resolveOldString — line-number gutter recovery", () => {
  const file = "function add(a, b) {\n  return a + b;\n}\n";

  it("recovers an oldString that carries a line-number gutter", () => {
    const res = resolveOldString(file, "     2\t  return a + b;");
    expect(res.count).toBe(1);
    expect(res.old).toBe("  return a + b;");
    expect(res.deguttered).toBe(true);
  });

  it("recovers a grep-style 'NN: ' prefixed oldString", () => {
    const res = resolveOldString(file, "1: function add(a, b) {\n2:   return a + b;");
    expect(res.count).toBe(1);
    expect(res.old).toBe("function add(a, b) {\n  return a + b;");
    expect(res.deguttered).toBe(true);
  });

  it("prefers an exact match and does not report a repair when none was needed", () => {
    const res = resolveOldString(file, "  return a + b;");
    expect(res.count).toBe(1);
    expect(res.deguttered).toBe(false);
  });

  it("combines gutter-stripping with whitespace tolerance", () => {
    // Numbered AND the indentation drifted (tab vs the file's two spaces).
    const res = resolveOldString(file, "     2\t\treturn a + b;");
    expect(res.count).toBe(1);
    expect(res.old).toBe("  return a + b;");
    expect(res.deguttered).toBe(true);
  });

  it("never adopts a de-guttered candidate that isn't in the file (the false-positive guard)", () => {
    // `1: 'one',` looks exactly like a gutter but is really an object literal. Because the
    // stripped form ('one',) does not appear in this file, the candidate is discarded and the
    // edit fails honestly instead of being redirected somewhere it was never meant to go.
    const res = resolveOldString(file, "1: 'one',\n2: 'two',");
    expect(res.count).toBe(0);
    expect(res.deguttered).toBe(false);
  });

  it("leaves a genuine numeric-key object literal editable as-is", () => {
    const config = "const m = {\n1: 'one',\n2: 'two',\n};\n";
    const res = resolveOldString(config, "1: 'one',\n2: 'two',");
    // The exact match wins outright, so nothing is ever stripped.
    expect(res.count).toBe(1);
    expect(res.old).toBe("1: 'one',\n2: 'two',");
    expect(res.deguttered).toBe(false);
  });
});

describe("resolveNewString — don't write line numbers into the file", () => {
  it("strips the gutter from newString when oldString needed stripping", () => {
    // Otherwise the edit 'succeeds' while writing "     1\tconst a = 1;" into the source.
    expect(resolveNewString("     1\tconst a = 1;\n     2\tconst b = 2;", true))
      .toBe("const a = 1;\nconst b = 2;");
  });

  it("leaves newString untouched when oldString matched the file as-is", () => {
    // Not gated on this, a legitimately numbered replacement would be silently mangled.
    expect(resolveNewString("1: 'one',\n2: 'two',", false)).toBe("1: 'one',\n2: 'two',");
  });

  it("leaves an unnumbered newString alone even when a repair happened", () => {
    expect(resolveNewString("const a = 1;", true)).toBe("const a = 1;");
  });
});
