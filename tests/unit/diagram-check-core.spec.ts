import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { errorLine, loadMermaidParser, tidyError, type MermaidParser } from "../../src/diagrams/diagram-check-core.js";

/* Mermaid's real parser, from the same standalone build the VSIX ships for the Markdown-preview
   fallback, under linkedom. This installs `window` and `document` as globals, which is why it
   lives in a worker in the product and why this file is the only place that loads it. */

let parser: MermaidParser;

beforeAll(() => {
  parser = loadMermaidParser(path.resolve("node_modules/mermaid/dist/mermaid.min.js"));
}, 60_000);

describe("errorLine and tidyError", () => {
  it("reads the line out of Mermaid's messages", () => {
    expect(errorLine("Parse error on line 3:\n...")).toBe(3);
    expect(errorLine("Parsing failed: Lexer error on line 12, column 4: nope")).toBe(12);
    expect(errorLine("No diagram type detected")).toBeUndefined();
  });

  it("bounds an error and replaces an empty one", () => {
    expect(tidyError("")).toBe("Mermaid could not parse this diagram.");
    expect(tidyError("x".repeat(2000)).length).toBeLessThan(710);
  });
});

describe("loadMermaidParser", () => {
  it("accepts valid diagrams of many kinds", async () => {
    const valid = [
      "flowchart TD\n  A[\"parse(input)\"] --> B{ok?}",
      "sequenceDiagram\n  autonumber\n  box Web\n    participant UI\n  end\n  UI->>Host: send",
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running",
      "pie showData title Pets\n  \"Dogs\" : 4\n  \"Cats\" : 2",
      "xychart-beta\n  x-axis [a, b]\n  y-axis \"n\" 0 --> 10\n  bar [1, 2]",
      "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  T :t1, 2026-01-01, 3d",
      "---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A --> B",
      "ishikawa-beta\n  Slow\n    Code\n      Imports",
      "venn-beta\n  set A[\"A\"]\n  set B[\"B\"]\n  union A,B[\"AB\"]",
    ];
    for (const source of valid) expect(await parser.parse(source), source).toMatchObject({ ok: true });
  });

  it("names the diagram type it detected", async () => {
    expect(await parser.parse("pie\n \"a\" : 1")).toMatchObject({ ok: true, diagramType: "pie" });
  });

  it("rejects a syntax error and names the line the parser gave up on", async () => {
    const result = await parser.parse("flowchart TD\n  A --> B\n  C --> --> D\n  E --> F");
    expect(result).toMatchObject({ ok: false, line: 3 });
    expect(result.error).toMatch(/Parse error on line 3/);
  });

  it("can blame the line after the mistake, which is why the tools show an excerpt", async () => {
    // An unclosed bracket on line 2 is only noticed when the source ends, on line 3.
    expect(await parser.parse("flowchart TD\n  A[unclosed --> B")).toMatchObject({ ok: false, line: 3 });
  });

  it("rejects text that is not a diagram, and an empty diagram", async () => {
    expect(await parser.parse("this is prose")).toMatchObject({ ok: false });
    expect(await parser.parse("")).toMatchObject({ ok: false });
  });

  it("rejects a bad value in a typed diagram", async () => {
    expect(await parser.parse("pie\n \"a\" : lots")).toMatchObject({ ok: false });
  });
});
