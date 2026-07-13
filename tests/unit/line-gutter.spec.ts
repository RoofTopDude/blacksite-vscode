import { describe, expect, it } from "vitest";
import { stripLineNumberGutter } from "../../src/line-gutter.js";

/**
 * A model that reconstructs a snippet from a numbered source — file_read with lineNumbers,
 * a file_search hit, a paged tool_output dump, an editor gutter in pasted text — and then
 * sends it back as file_edit's oldString produces a string that can never match the file.
 * This is the detector that lets the edit path recover from it; see diff-edit-service.ts for
 * the verify-against-the-file guard that makes a false positive here inert.
 */

describe("stripLineNumberGutter — recognises real gutters", () => {
  it("strips file_read's own lineNumbers format (padded number + tab)", () => {
    expect(stripLineNumberGutter("     1\tconst a = 1;\n     2\tconst b = 2;"))
      .toBe("const a = 1;\nconst b = 2;");
  });

  it("strips cat -n style numbering", () => {
    expect(stripLineNumberGutter("1\tfoo\n2\tbar")).toBe("foo\nbar");
  });

  it("strips grep-style 'NN: text'", () => {
    expect(stripLineNumberGutter("42: const x = 1;\n43: const y = 2;"))
      .toBe("const x = 1;\nconst y = 2;");
  });

  it("strips editor-gutter pipes", () => {
    expect(stripLineNumberGutter("10 | function a() {\n11 |   return 1;\n12 | }"))
      .toBe("function a() {\n  return 1;\n}");
  });

  it("preserves the code's own leading indentation", () => {
    expect(stripLineNumberGutter("     7\t    if (x) {\n     8\t      go();"))
      .toBe("    if (x) {\n      go();");
  });

  it("preserves a trailing newline", () => {
    expect(stripLineNumberGutter("1\tfoo\n2\tbar\n")).toBe("foo\nbar\n");
  });

  it("handles a numbered blank line inside the block", () => {
    expect(stripLineNumberGutter("1\tfoo\n2\t\n3\tbar")).toBe("foo\n\nbar");
  });

  it("accepts a single numbered line", () => {
    expect(stripLineNumberGutter("     9\treturn true;")).toBe("return true;");
  });
});

describe("stripLineNumberGutter — refuses anything that isn't uniformly a gutter", () => {
  it("returns null for ordinary unnumbered code", () => {
    expect(stripLineNumberGutter("const a = 1;\nconst b = 2;")).toBeNull();
  });

  it("returns null when the numbers don't run consecutively", () => {
    // A real gutter always counts. Non-consecutive digits are content that merely starts with one.
    expect(stripLineNumberGutter("1\tfoo\n7\tbar")).toBeNull();
  });

  it("returns null when only some lines are numbered", () => {
    expect(stripLineNumberGutter("1\tfoo\nbar")).toBeNull();
  });

  it("returns null on a mix of separator styles", () => {
    expect(stripLineNumberGutter("1\tfoo\n2: bar")).toBeNull();
  });

  it("leaves a Markdown ordered list alone ('.' is not a gutter separator)", () => {
    expect(stripLineNumberGutter("1. First\n2. Second")).toBeNull();
  });

  it("leaves bare whitespace-separated content alone (far too common to be a safe signal)", () => {
    expect(stripLineNumberGutter("1 apple\n2 banana")).toBeNull();
  });

  it("refuses to strip a block down to nothing", () => {
    expect(stripLineNumberGutter("1\t\n2\t")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(stripLineNumberGutter("")).toBeNull();
  });

  it("DOES match an object literal with consecutive numeric keys — which is why callers must verify", () => {
    // This is the deliberate false positive the module's contract calls out: on its own,
    // `1: 'one',` is indistinguishable from a gutter. It is only safe because diff-edit-service
    // discards a stripped candidate that isn't actually present in the file.
    expect(stripLineNumberGutter("1: 'one',\n2: 'two',")).toBe("'one',\n'two',");
  });
});
