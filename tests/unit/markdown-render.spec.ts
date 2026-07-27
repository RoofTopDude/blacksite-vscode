import { describe, expect, it, vi } from "vitest";

// DOMPurify needs a real DOM and this suite runs in the node environment. Sanitizing is
// not what these tests are about — they cover the custom markdown-it renderer rules — so
// the sanitizer is stubbed to a pass-through and the rest of the pipeline stays real.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

const { renderMd } = await import("../../src/webview/react/lib/markdown.js");

const TABLE = [
  "| Setting | What it does |",
  "| --- | --- |",
  "| `blacksite.bedrockApi` | Selects the Bedrock wire format |",
].join("\n");

describe("renderMd tables", () => {
  it("wraps a table in a horizontal scroll container", () => {
    const html = renderMd(TABLE);
    expect(html).toContain('<div class="md-table-scroll"><table>');
    expect(html).toContain("</table></div>");
  });

  it("emits one wrapper per table and leaves them balanced", () => {
    const html = renderMd(`${TABLE}\n\ntext between\n\n${TABLE}`);
    expect(html.match(/md-table-scroll/g)).toHaveLength(2);
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html.match(/<\/table><\/div>/g)).toHaveLength(2);
  });

  it("still renders table content and inline code inside cells", () => {
    const html = renderMd(TABLE);
    expect(html).toContain("<th>Setting</th>");
    expect(html).toContain("<code>blacksite.bedrockApi</code>");
  });

  it("does not wrap non-table markdown", () => {
    expect(renderMd("Just a paragraph.")).not.toContain("md-table-scroll");
  });
});

describe("renderMd fences", () => {
  it("renders a doc fence as an inline document card", () => {
    const html = renderMd("```doc\n# Title\n\nBody text.\n```");
    expect(html).toContain('<div class="doc-block">');
    expect(html).toContain("Title");
  });

  it("gives an ordinary fence a labelled header with a copy action", () => {
    const html = renderMd("```ts\nconst x = 1;\n```");
    expect(html).toContain('<div class="cb">');
    expect(html).toContain('<span class="cb-lang">ts</span>');
    expect(html).toContain('class="cb-copy"');
  });

  it("labels a block it cannot confidently detect as text", () => {
    expect(renderMd("```\nplain\n```")).toContain('<span class="cb-lang">text</span>');
  });
});

/* Reasoning output labels its fences far less consistently than a finished reply does,
   so an unlabelled block still has to arrive highlighted rather than as flat grey text. */
describe("renderMd auto-detects unlabelled code fences", () => {
  const TS = [
    "```",
    "export function resolveBudget(input: SpawnInput): Budget {",
    "  const complexity = normalize(input);",
    "  return { complexity, timeoutSeconds: 240 };",
    "}",
    "```",
  ].join("\n");

  it("highlights an unlabelled block and labels it with what it detected", () => {
    const html = renderMd(TS);
    expect(html).toContain("hljs-");
    expect(html).toMatch(/<span class="cb-lang">\w+ ·<\/span>/);
  });

  it("leaves prose unhighlighted rather than mis-tinting it", () => {
    const html = renderMd("```\nJust some ordinary sentences in a block.\n```");
    expect(html).toContain('<span class="cb-lang">text</span>');
    expect(html).not.toContain("hljs-");
  });

  it("never overrides an explicit language tag", () => {
    const html = renderMd("```python\nvalue = 1\n```");
    expect(html).toContain('<span class="cb-lang">python</span>');
  });

  it("returns a stable result when the same block renders twice (detection is memoised)", () => {
    expect(renderMd(TS)).toBe(renderMd(TS));
  });
});
