import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import {
  MermaidCodeLensProvider,
  OPEN_DIAGRAM_COMMAND,
  diagramSourceFromEditor,
  openDiagramSource,
  parseSaveRequest,
} from "../../src/diagrams/diagram-viewer.js";
import {
  NATIVE_MERMAID_PREVIEW_EXTENSIONS,
  extendMarkdownItWithMermaid,
} from "../../src/diagrams/markdown-preview-mermaid.js";
import { MAX_DIAGRAM_SOURCE_CHARS } from "../../src/shared/mermaid-source.js";

type MockWorkspace = typeof vscode.workspace & { __setConfig(key: string, value: unknown): void; __clearConfig(): void };
type MockExtensions = typeof vscode.extensions & { __setInstalled(ids: string[]): void };
const mockWorkspace = vscode.workspace as MockWorkspace;
const mockExtensions = vscode.extensions as MockExtensions;

afterEach(() => {
  mockWorkspace.__clearConfig();
  mockExtensions.__setInstalled([]);
});

describe("openDiagramSource", () => {
  it("accepts diagram source and refuses anything else a webview could send", () => {
    expect(openDiagramSource("flowchart TD\n A --> B")).toBe("flowchart TD\n A --> B");
    expect(openDiagramSource("")).toBeUndefined();
    expect(openDiagramSource("   \n ")).toBeUndefined();
    expect(openDiagramSource(42)).toBeUndefined();
    expect(openDiagramSource({ source: "x" })).toBeUndefined();
    expect(openDiagramSource("x".repeat(MAX_DIAGRAM_SOURCE_CHARS + 1))).toBeUndefined();
  });
});

describe("parseSaveRequest", () => {
  it("accepts an SVG or PNG export and keeps a clean file name", () => {
    expect(parseSaveRequest({ format: "svg", fileName: "request-flow.svg", data: "<svg/>" }))
      .toEqual({ format: "svg", fileName: "request-flow.svg", data: "<svg/>" });
    expect(parseSaveRequest({ format: "png", fileName: "flow.svg", data: "iVBOR" })?.fileName).toBe("flow.png");
  });

  it("reduces a file name to a bare name, so the dialog cannot be aimed elsewhere", () => {
    expect(parseSaveRequest({ format: "svg", fileName: "../../etc/passwd", data: "<svg/>" })?.fileName).toBe("passwd.svg");
    expect(parseSaveRequest({ format: "svg", fileName: "C:\\Users\\x\\evil name!.svg", data: "<svg/>" })?.fileName).toMatch(/^[\w.-]+\.svg$/);
    expect(parseSaveRequest({ format: "svg", data: "<svg/>" })?.fileName).toBe("diagram.svg");
  });

  it("refuses unknown formats and empty payloads", () => {
    expect(parseSaveRequest({ format: "pdf", fileName: "x", data: "x" })).toBeUndefined();
    expect(parseSaveRequest({ format: "svg", fileName: "x", data: "" })).toBeUndefined();
    expect(parseSaveRequest({ format: "png", fileName: "x" })).toBeUndefined();
  });
});

function editor(text: string, options: { line?: number; selected?: string; fileName?: string; languageId?: string } = {}): vscode.TextEditor {
  return {
    document: {
      getText: (range?: unknown) => (range ? options.selected ?? "" : text),
      fileName: options.fileName ?? "/work/README.md",
      languageId: options.languageId ?? "markdown",
    },
    selection: { isEmpty: !options.selected, active: { line: options.line ?? 0 } },
  } as unknown as vscode.TextEditor;
}

const README = ["# Title", "", "```mermaid", "flowchart TD", "  A --> B", "```", "", "prose"].join("\n");

describe("diagramSourceFromEditor", () => {
  it("prefers a selection", () => {
    expect(diagramSourceFromEditor(editor(README, { selected: "sequenceDiagram\n A->>B: hi", line: 3 }))).toBe("sequenceDiagram\n A->>B: hi");
  });

  it("takes the fence under the cursor", () => {
    expect(diagramSourceFromEditor(editor(README, { line: 4 }))).toBe("flowchart TD\n  A --> B");
    expect(diagramSourceFromEditor(editor(README, { line: 7 }))).toBeUndefined();
  });

  it("takes a whole .mmd file", () => {
    expect(diagramSourceFromEditor(editor("graph LR\n A-->B", { fileName: "/work/flow.mmd", languageId: "plaintext" }))).toBe("graph LR\n A-->B");
  });

  it("has nothing to offer without an editor", () => {
    expect(diagramSourceFromEditor(undefined)).toBeUndefined();
  });
});

describe("MermaidCodeLensProvider", () => {
  it("puts an Open diagram lens on each Mermaid fence, carrying its source", () => {
    const provider = new MermaidCodeLensProvider();
    const lenses = provider.provideCodeLenses({ getText: () => `${README}\n\n\`\`\`mermaid\npie title Pets\n\`\`\`` } as unknown as vscode.TextDocument);
    expect(lenses).toHaveLength(2);
    expect(lenses[0]!.range.start.line).toBe(2);
    expect(lenses[0]!.command).toMatchObject({ command: OPEN_DIAGRAM_COMMAND, arguments: [{ source: "flowchart TD\n  A --> B" }] });
    expect(lenses[1]!.range.start.line).toBe(9);
    provider.dispose();
  });

  it("offers nothing when the setting is off, or for an empty fence", () => {
    const provider = new MermaidCodeLensProvider();
    expect(provider.provideCodeLenses({ getText: () => "```mermaid\n\n```" } as unknown as vscode.TextDocument)).toEqual([]);
    mockWorkspace.__setConfig("blacksite.diagrams.codeLens", false);
    expect(provider.provideCodeLenses({ getText: () => README } as unknown as vscode.TextDocument)).toEqual([]);
    provider.dispose();
  });
});

describe("extendMarkdownItWithMermaid", () => {
  const FENCE = "```mermaid\nflowchart TD\n  A --> B\n```\n\n```ts\nconst x = 1;\n```";

  it("marks Mermaid fences for the preview script when VS Code has no renderer of its own", () => {
    const html = extendMarkdownItWithMermaid(new MarkdownIt()).render(FENCE);
    expect(html).toContain('<div class="blacksite-mermaid"><pre><code class="language-mermaid">flowchart TD\n  A --&gt; B\n</code></pre>\n</div>');
    // Other fences are untouched.
    expect(html.match(/blacksite-mermaid/g)).toHaveLength(1);
  });

  it("leaves the preview alone when a native Mermaid renderer is installed, so nothing draws twice", () => {
    for (const id of NATIVE_MERMAID_PREVIEW_EXTENSIONS) {
      mockExtensions.__setInstalled([id]);
      expect(extendMarkdownItWithMermaid(new MarkdownIt()).render(FENCE), id).not.toContain("blacksite-mermaid");
    }
  });
});
