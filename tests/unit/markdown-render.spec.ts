import { describe, expect, it, vi } from "vitest";

// DOMPurify needs a real DOM and this suite runs in the node environment. Sanitizing is
// not what these tests are about — they cover the custom markdown-it renderer rules — so
// the sanitizer is stubbed to a pass-through and the rest of the pipeline stays real.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

const {
  renderMd,
  renderMdInline,
  boundMarkdown,
  SANITIZE_CONFIG,
  INLINE_SANITIZE_CONFIG,
} = await import("../../src/webview/react/lib/markdown.js");

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

describe("renderMd images", () => {
  it("tags inline images with the lightbox/fade-in class and lazy-loads them", () => {
    const html = renderMd("![a screenshot](data:image/png;base64,AA==)");
    expect(html).toContain('class="md-img"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("turns remote images into inert text so model output cannot emit tracking beacons", () => {
    const html = renderMd("![build result](https://attacker.example/pixel?id=user)");
    expect(html).toContain("Remote image blocked for privacy");
    expect(html).toContain("build result");
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain("<img");
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

/* The inline variant backs plan/ticket fields the store normalizes with `cleanText`, which
   collapses all whitespace — so those fields cannot hold block structure, and rendering them
   through the block engine would advertise a capability the store does not have. */
describe("renderMdInline", () => {
  it("keeps emphasis, code spans, and links", () => {
    const html = renderMdInline("**bold**, `code`, and [a link](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });

  it("emits no paragraph wrapper, unlike the block renderer", () => {
    expect(renderMdInline("plain text")).not.toContain("<p>");
    expect(renderMd("plain text")).toContain("<p>");
  });

  it("does not parse headings, lists, or fences as block structure", () => {
    const html = renderMdInline("# Heading\n- item\n```ts\ncode\n```");
    for (const tag of ["<h1", "<ul", "<li", "<pre", "<div"]) {
      expect(html, `"${tag}" must not survive an inline render`).not.toContain(tag);
    }
  });

  it("still marks a workspace file link for the open-in-editor delegation", () => {
    const html = renderMdInline("see [retry](src/provider-retry.ts#L118)");
    expect(html).toContain('class="file-link"');
    expect(html).toContain('data-file-open="src/provider-retry.ts"');
    expect(html).toContain('data-file-line="118"');
  });
});

/* These two configs are what actually constrain the sanitizer at runtime; this suite stubs
   DOMPurify out, so the configuration is asserted directly rather than through its output. */
describe("sanitize configuration", () => {
  const BLOCK_TAGS = [
    "p", "div", "pre", "blockquote", "ul", "ol", "li", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td",
    "dl", "dt", "dd", "details", "summary", "input", "label", "img",
  ];

  /* The stub above means no test here can watch the sanitizer remove something, so the two
     halves are compared directly instead: an element the renderer emits but the config omits
     is dropped at runtime and hoisted to bare text, which looks like a rendering bug rather
     than a sanitizer one — that is how the copy button spent its life as an inert label. */
  it("allows every element and attribute the renderer itself emits", () => {
    const html = renderMd([
      "```ts\nexport const total = sum(values);\n```",
      "```\nunlabelled block\n```",
      TABLE,
      "- [ ] a task list item",
      "![alt text](diagram.png)",
      "see [retry](src/provider-retry.ts#L118) and [docs](https://example.com)",
      "Term\n: Definition",
      "==marked==, ^sup^, ~sub~, > quote",
    ].join("\n\n"));

    for (const [, tag] of html.matchAll(/<([a-z][a-z0-9]*)\b/gi)) {
      expect(SANITIZE_CONFIG.ALLOWED_TAGS, `renderMd emits <${tag}>`).toContain(tag.toLowerCase());
    }
    for (const [, attr] of html.matchAll(/\s([a-z][a-z-]*)=/gi)) {
      expect(SANITIZE_CONFIG.ALLOWED_ATTR, `renderMd emits ${attr}=`).toContain(attr.toLowerCase());
    }
  });

  it("allows no block-level element in the inline config", () => {
    for (const tag of BLOCK_TAGS) {
      expect(INLINE_SANITIZE_CONFIG.ALLOWED_TAGS, `"${tag}" must not be inline-renderable`).not.toContain(tag);
    }
  });

  it("keeps the inline config a strict subset of the block config", () => {
    for (const tag of INLINE_SANITIZE_CONFIG.ALLOWED_TAGS) {
      expect(SANITIZE_CONFIG.ALLOWED_TAGS).toContain(tag);
    }
    expect(INLINE_SANITIZE_CONFIG.ALLOWED_TAGS.length).toBeLessThan(SANITIZE_CONFIG.ALLOWED_TAGS.length);
  });

  it("cannot introduce an image inline, since a collapsed line should not carry one", () => {
    expect(INLINE_SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain("img");
    expect(INLINE_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain("src");
  });

  it("permits no event-handler, style, script, or iframe in either config", () => {
    for (const config of [SANITIZE_CONFIG, INLINE_SANITIZE_CONFIG]) {
      for (const attr of config.ALLOWED_ATTR) {
        expect(attr.startsWith("on"), `"${attr}" would be an event handler`).toBe(false);
      }
      expect(config.ALLOWED_ATTR).not.toContain("style");
      expect(config.ALLOWED_TAGS).not.toContain("script");
      expect(config.ALLOWED_TAGS).not.toContain("iframe");
    }
  });
});

/* Plan documents run to 50,000 characters; the panel expansion is a bounded preview and the
   editor is where a document that long is actually read. */
describe("boundMarkdown", () => {
  it("returns short input untouched and unflagged", () => {
    const result = boundMarkdown("# Title\n\nBody.", 8_000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("# Title\n\nBody.");
    expect(result.totalChars).toBe("# Title\n\nBody.".length);
  });

  it("treats a zero or negative budget as no bound", () => {
    const raw = "x".repeat(500);
    expect(boundMarkdown(raw, 0).truncated).toBe(false);
    expect(boundMarkdown(raw, -1).text).toBe(raw);
  });

  it("reports the full source length when it truncates", () => {
    const raw = "word ".repeat(400);
    const result = boundMarkdown(raw, 100);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(raw.length);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("prefers a paragraph break near the limit over cutting mid-word", () => {
    const result = boundMarkdown(`${"a".repeat(80)}\n\n${"b".repeat(200)}`, 100);
    expect(result.text).toBe("a".repeat(80));
  });

  it("falls back to a hard cut when no break sits late enough to be worth using", () => {
    // The only newline is at index 4, far below the 75% floor — honouring it would throw
    // away almost the whole budget to save a partial word.
    const result = boundMarkdown(`head\n${"z".repeat(300)}`, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(75);
  });

  it("closes a fence left open by the cut", () => {
    const raw = `intro\n\n\`\`\`ts\n${"const x = 1;\n".repeat(40)}`;
    const result = boundMarkdown(raw, 120);
    expect(result.truncated).toBe(true);
    const fences = result.text.match(/^```/gm) ?? [];
    expect(fences.length % 2, "an odd fence count would swallow the notice and everything after it").toBe(0);
    expect(result.text.endsWith("```")).toBe(true);
  });

  it("leaves an already-balanced fence alone", () => {
    const result = boundMarkdown(`\`\`\`\ncode\n\`\`\`\n\n${"tail ".repeat(200)}`, 60);
    expect((result.text.match(/^```/gm) ?? []).length).toBe(2);
  });

  it("does not leave trailing whitespace at the cut", () => {
    const result = boundMarkdown("word ".repeat(200), 100);
    expect(result.text).toBe(result.text.trimEnd());
  });
});
