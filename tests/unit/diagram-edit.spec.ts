import { describe, expect, it } from "vitest";
import {
  MAX_EDITS_PER_CALL,
  applyDiagramEdits,
  diagramFileName,
  excerptAround,
  normalizeSource,
  numberedLines,
} from "../../src/diagrams/diagram-edit.js";

const BASE = ["flowchart TD", "  A[Start] --> B[Parse]", "  B --> C[Run]", "  C --> D[Done]"].join("\n");

function applied(edits: Parameters<typeof applyDiagramEdits>[1], source = BASE): string {
  const result = applyDiagramEdits(source, edits);
  if (!result.ok) throw new Error(result.error);
  return result.source;
}

describe("applyDiagramEdits: find and replace", () => {
  it("replaces exact text once and reports the line", () => {
    const result = applyDiagramEdits(BASE, [{ find: "B[Parse]", replace: "B[Parse input]" }]);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.source).toContain("A[Start] --> B[Parse input]");
      expect(result.summary).toEqual(["Edit 1: replaced 1 occurrence at line 2."]);
    }
  });

  it("refuses text that is not there, and says how to find the right text", () => {
    const result = applyDiagramEdits(BASE, [{ find: "Z --> Q", replace: "x" }]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/not found.*diagram_read.*Nothing was changed/);
  });

  it("refuses an ambiguous match, listing the lines, unless all is set", () => {
    const source = "flowchart TD\n  A --> B\n  C --> B\n  D --> B";
    const ambiguous = applyDiagramEdits(source, [{ find: "--> B", replace: "--> X" }]);
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous.ok) expect(ambiguous.error).toMatch(/matches 3 places \(lines 2, 3, 4\)/);
    expect(applied([{ find: "--> B", replace: "--> X", all: true }], source)).toBe("flowchart TD\n  A --> X\n  C --> X\n  D --> X");
  });

  it("deletes with an empty replacement, and honours a trailing newline in find", () => {
    expect(applied([{ find: "  B --> C[Run]\n", replace: "" }])).toBe("flowchart TD\n  A[Start] --> B[Parse]\n  C --> D[Done]");
  });

  it("requires replace alongside find, and a non-empty find", () => {
    expect(applyDiagramEdits(BASE, [{ find: "A" }])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, [{ find: "", replace: "x" }])).toMatchObject({ ok: false });
  });
});

describe("applyDiagramEdits: line edits", () => {
  it("replaces an inclusive line range", () => {
    expect(applied([{ fromLine: 2, toLine: 3, replace: "  A --> D" }])).toBe("flowchart TD\n  A --> D\n  C --> D[Done]");
  });

  it("treats a single fromLine as one line, and an empty replace as a deletion", () => {
    expect(applied([{ fromLine: 3, replace: "" }])).toBe("flowchart TD\n  A[Start] --> B[Parse]\n  C --> D[Done]");
  });

  it("does not turn a trailing newline in the replacement into a blank line", () => {
    expect(applied([{ fromLine: 4, replace: "  C --> E[Other]\n" }])).toBe("flowchart TD\n  A[Start] --> B[Parse]\n  B --> C[Run]\n  C --> E[Other]");
  });

  it("rejects ranges outside the diagram", () => {
    expect(applyDiagramEdits(BASE, [{ fromLine: 0, replace: "x" }])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, [{ fromLine: 3, toLine: 9, replace: "x" }])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, [{ fromLine: 3, toLine: 2, replace: "x" }])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, [{ fromLine: 1.5, replace: "x" }])).toMatchObject({ ok: false });
  });

  it("inserts after a line, and at the top with 0", () => {
    expect(applied([{ afterLine: 2, insert: "  A --> E[Extra]\n  E --> B" }])).toBe(
      "flowchart TD\n  A[Start] --> B[Parse]\n  A --> E[Extra]\n  E --> B\n  B --> C[Run]\n  C --> D[Done]",
    );
    expect(applied([{ afterLine: 0, insert: "%% header" }]).split("\n")[0]).toBe("%% header");
    expect(applyDiagramEdits(BASE, [{ afterLine: 9, insert: "x" }])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, [{ afterLine: 1, insert: "" }])).toMatchObject({ ok: false });
  });
});

describe("applyDiagramEdits: a batch", () => {
  it("applies edits in order, each to the result of the one before", () => {
    // After the insert, "C --> D[Done]" is on line 5, so the second edit's line numbers see that.
    const result = applied([
      { afterLine: 2, insert: "  A --> E" },
      { fromLine: 5, replace: "  C --> D[Finished]" },
    ]);
    expect(result).toBe("flowchart TD\n  A[Start] --> B[Parse]\n  A --> E\n  B --> C[Run]\n  C --> D[Finished]");
  });

  it("applies none of them when one fails", () => {
    const result = applyDiagramEdits(BASE, [
      { find: "B[Parse]", replace: "B[Parse input]" },
      { find: "nope", replace: "x" },
    ]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/^Edit 2:/);
  });

  it("refuses an empty batch, an unrecognised edit, and a batch over the limit", () => {
    expect(applyDiagramEdits(BASE, [])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, [{}])).toMatchObject({ ok: false });
    expect(applyDiagramEdits(BASE, Array.from({ length: MAX_EDITS_PER_CALL + 1 }, () => ({ find: "A", replace: "A" })))).toMatchObject({ ok: false });
  });

  it("folds CRLF in the source and in the edits", () => {
    expect(applied([{ find: "A[Start]\r\n", replace: "A[Begin]\r\n" }], BASE.replace(/\n/g, "\r\n").replace("A[Start] --> B[Parse]", "A[Start]\r\n  A --> B[Parse]")))
      .toContain("A[Begin]\n  A --> B[Parse]");
  });
});

describe("reading and naming", () => {
  it("normalizeSource folds line endings and drops trailing blank lines", () => {
    expect(normalizeSource("a\r\nb\r\n\r\n")).toBe("a\nb");
  });

  it("numberedLines pads the numbers and pages", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const view = numberedLines(text, 9, 11);
    expect(view).toMatchObject({ from: 9, to: 11, total: 12 });
    expect(view.text.split("\n")[0]).toBe(" 9  line 9");
    const paged = numberedLines(Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n"));
    expect(paged.to).toBe(400);
    expect(paged.total).toBe(1000);
  });

  it("excerptAround shows the neighbours of a line", () => {
    expect(excerptAround("a\nb\nc\nd\ne\nf", 3).split("\n")).toEqual(["1  a", "2  b", "3  c", "4  d", "5  e"]);
  });

  it("diagramFileName makes a safe .mmd name and refuses an empty one", () => {
    expect(diagramFileName("Request Flow")).toBe("request-flow.mmd");
    expect(diagramFileName("../../etc/passwd")).toBe("etc-passwd.mmd");
    expect(diagramFileName("flow.mmd")).toBe("flow.mmd");
    expect(diagramFileName("flow.mermaid")).toBe("flow.mmd");
    expect(diagramFileName("  ***  ")).toBeUndefined();
    expect(diagramFileName("x".repeat(200))!.length).toBeLessThanOrEqual(64 + 4);
  });
});
