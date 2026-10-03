import { describe, expect, it } from "vitest";
import {
  MAX_DIAGRAM_SOURCE_CHARS,
  describeMermaid,
  diagramDisplayTitle,
  diagramFileStem,
  findMermaidFences,
  mermaidFenceAt,
} from "../../src/shared/mermaid-source.js";

const DOC = [
  "# Design",              // 0
  "",                      // 1
  "```mermaid",            // 2
  "flowchart TD",          // 3
  "  A --> B",             // 4
  "```",                   // 5
  "",                      // 6
  "```ts",                 // 7
  "const x = 1;",          // 8
  "```",                   // 9
  "",                      // 10
  "~~~~ Mermaid extra",    // 11
  "sequenceDiagram",       // 12
  "  A->>B: hi",           // 13
  "~~~~",                  // 14
].join("\n");

describe("findMermaidFences", () => {
  it("finds backtick and tilde fences with their line span, whatever the case of the tag", () => {
    expect(findMermaidFences(DOC)).toEqual([
      { source: "flowchart TD\n  A --> B", startLine: 2, endLine: 5 },
      { source: "sequenceDiagram\n  A->>B: hi", startLine: 11, endLine: 14 },
    ]);
  });

  it("skips a Mermaid example quoted inside another fence", () => {
    const text = ["````markdown", "```mermaid", "flowchart TD", "```", "````"].join("\n");
    expect(findMermaidFences(text)).toEqual([]);
  });

  it("requires a closing fence of the same character, at least as long as the opening", () => {
    const text = ["````mermaid", "flowchart TD", "```", "  A --> B", "````"].join("\n");
    expect(findMermaidFences(text)).toEqual([{ source: "flowchart TD\n```\n  A --> B", startLine: 0, endLine: 4 }]);
  });

  it("runs an unclosed fence to the end of the document", () => {
    const text = ["intro", "```mermaid", "flowchart TD", "  A --> B"].join("\n");
    expect(findMermaidFences(text)).toEqual([{ source: "flowchart TD\n  A --> B", startLine: 1, endLine: 3 }]);
  });

  it("removes the opening fence's indentation from the body, and handles CRLF", () => {
    const text = "  ```mermaid\r\n  flowchart TD\r\n    A --> B\r\n  ```";
    expect(findMermaidFences(text)).toEqual([{ source: "flowchart TD\n  A --> B", startLine: 0, endLine: 3 }]);
  });

  it("does not treat four-space-indented text or a backtick info string as a fence", () => {
    expect(findMermaidFences("    ```mermaid\n    flowchart TD\n    ```")).toEqual([]);
    expect(findMermaidFences("```mermaid `x`\nflowchart TD\n```")).toEqual([]);
  });
});

describe("mermaidFenceAt", () => {
  it("returns the fence whose block contains the line, fences included", () => {
    expect(mermaidFenceAt(DOC, 2)?.startLine).toBe(2);
    expect(mermaidFenceAt(DOC, 4)?.startLine).toBe(2);
    expect(mermaidFenceAt(DOC, 5)?.startLine).toBe(2);
    expect(mermaidFenceAt(DOC, 13)?.startLine).toBe(11);
  });

  it("returns nothing outside a Mermaid fence", () => {
    expect(mermaidFenceAt(DOC, 0)).toBeUndefined();
    expect(mermaidFenceAt(DOC, 8)).toBeUndefined();
  });
});

describe("describeMermaid", () => {
  it("names the diagram type from its first meaningful line", () => {
    expect(describeMermaid("%% a comment\n\nsequenceDiagram\n  A->>B: hi").kind).toBe("Sequence diagram");
    expect(describeMermaid("graph LR\n A-->B").kind).toBe("Flowchart");
    expect(describeMermaid("stateDiagram-v2\n [*] --> A").kind).toBe("State diagram");
    expect(describeMermaid("erDiagram\n A ||--o{ B : has").kind).toBe("Entity relationship diagram");
    expect(describeMermaid("ishikawa-beta\n  Slow").kind).toBe("Fishbone diagram");
    expect(describeMermaid("venn-beta\n  set A[\"A\"]").kind).toBe("Venn diagram");
    expect(describeMermaid("treeView-beta\n\"src\"").kind).toBe("Tree view");
    expect(describeMermaid("cynefin-beta\n  title Where").kind).toBe("Cynefin diagram");
    expect(describeMermaid("railroad-ebnf-beta\n  a = b;").kind).toBe("Railroad diagram");
    expect(describeMermaid("eventmodeling\ntf 01 cmd Add").kind).toBe("Event model");
    expect(describeMermaid("swimlane-beta\n  lane A").kind).toBe("Swimlane diagram");
    expect(describeMermaid("wardley-beta\ntitle Map").kind).toBe("Wardley map");
    expect(describeMermaid("not a diagram").kind).toBe("Diagram");
  });

  it("takes the title from front matter", () => {
    expect(describeMermaid("---\ntitle: \"Request flow\"\n---\nflowchart TD\n A-->B")).toEqual({ kind: "Flowchart", title: "Request flow" });
  });

  it("takes a title keyword only in diagram types whose grammar has one", () => {
    expect(describeMermaid("gantt\n  title Release plan\n  section A").title).toBe("Release plan");
    expect(describeMermaid("pie title Pets adopted\n  \"Dogs\" : 386").title).toBe("Pets adopted");
    // In a flowchart, `title` is just a node id.
    expect(describeMermaid("flowchart TD\n  title --> body").title).toBeUndefined();
  });

  it("accepts accTitle in any diagram type", () => {
    expect(describeMermaid("flowchart TD\n  accTitle: Login flow\n  A --> B").title).toBe("Login flow");
  });
});

describe("display title and file stem", () => {
  it("combine the title and kind, or fall back to the kind", () => {
    expect(diagramDisplayTitle("---\ntitle: Request flow\n---\nflowchart TD")).toBe("Request flow · Flowchart");
    expect(diagramDisplayTitle("sequenceDiagram")).toBe("Sequence diagram");
  });

  it("slug the title into a safe file name", () => {
    expect(diagramFileStem("---\ntitle: Agent ↔ Host: request/response!\n---\nflowchart TD")).toBe("agent-host-request-response");
    expect(diagramFileStem("sequenceDiagram")).toBe("sequence-diagram");
    expect(diagramFileStem("---\ntitle: ∑∑∑\n---\nflowchart TD")).toBe("diagram");
  });

  it("agree with Mermaid's own limit on source size", () => {
    expect(MAX_DIAGRAM_SOURCE_CHARS).toBe(50_000);
  });
});
