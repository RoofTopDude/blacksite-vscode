import { describe, expect, it } from "vitest";
import { docReferences, extractDocLinks, resolveDocByName, resolveDocLink } from "../../src/graph/doc-links.js";
import { buildBasenameIndex } from "../../src/graph/resolve-imports.js";

const FILES = new Set([
  "README.md",
  "docs/guide.md",
  "src/parser.ts",
  "src/util.ts",
  "config/app.yaml",
  "docs/img.png",
]);

describe("extractDocLinks", () => {
  it("captures markdown links, path-shaped inline code, and bare paths", () => {
    const md = [
      "See [the parser](./src/parser.ts) which uses `src/util.ts`.",
      "Config lives in config/app.yaml.",
    ].join("\n");
    const links = extractDocLinks(md);
    expect(links).toEqual(expect.arrayContaining(["./src/parser.ts", "src/util.ts", "config/app.yaml"]));
  });

  it("ignores URLs, anchors, and prose in code spans", () => {
    const md = "[site](https://example.com) [top](#section) `run npm test` `just words`";
    expect(extractDocLinks(md)).toEqual([]);
  });

  it("drops a title after the link target", () => {
    expect(extractDocLinks(`[x](./src/util.ts "the title")`)).toEqual(["./src/util.ts"]);
  });
});

describe("resolveDocLink", () => {
  it("resolves relative to the doc, then workspace-root-relative", () => {
    expect(resolveDocLink("README.md", "./src/parser.ts", FILES)).toBe("src/parser.ts");
    expect(resolveDocLink("docs/guide.md", "../src/util.ts", FILES)).toBe("src/util.ts");
    expect(resolveDocLink("docs/guide.md", "./img.png", FILES)).toBe("docs/img.png");
  });

  it("strips anchors/queries and rejects URLs and misses", () => {
    expect(resolveDocLink("README.md", "src/parser.ts#L20", FILES)).toBe("src/parser.ts");
    expect(resolveDocLink("README.md", "https://example.com/x.ts", FILES)).toBeNull();
    expect(resolveDocLink("README.md", "src/missing.ts", FILES)).toBeNull();
  });
});

describe("docReferences", () => {
  it("returns the resolved, deduped set a doc documents (minus itself)", () => {
    const md = "[parser](./src/parser.ts), `src/util.ts`, and config/app.yaml. Repeat: `src/util.ts`.";
    const refs = docReferences("README.md", md, FILES);
    expect(new Set(refs)).toEqual(new Set(["src/parser.ts", "src/util.ts", "config/app.yaml"]));
  });

  it("drops self-references", () => {
    expect(docReferences("README.md", "[self](./README.md)", FILES)).toEqual([]);
  });

  it("falls back to unambiguous basenames/suffixes for shorthand references", () => {
    const byBasename = buildBasenameIndex(FILES);
    /* Docs usually name files by basename or partial path in inline code. */
    const md = "The `parser.ts` and `src/util.ts` modules. Config: `app.yaml`.";
    const refs = docReferences("docs/guide.md", md, FILES, byBasename);
    expect(new Set(refs)).toEqual(new Set(["src/parser.ts", "src/util.ts", "config/app.yaml"]));
  });
});

describe("resolveDocByName", () => {
  const files = new Set(["a/foo.ts", "b/foo.ts", "src/parser.ts", "lib/graph/protocol.ts"]);
  const idx = buildBasenameIndex(files);

  it("links a bare basename only when exactly one file has it", () => {
    expect(resolveDocByName("parser.ts", idx)).toBe("src/parser.ts");
    expect(resolveDocByName("foo.ts", idx)).toBeNull(); // ambiguous — two matches
  });

  it("links a partial path by unique suffix match", () => {
    expect(resolveDocByName("graph/protocol.ts", idx)).toBe("lib/graph/protocol.ts");
  });

  it("returns null for names no file carries", () => {
    expect(resolveDocByName("nope.ts", idx)).toBeNull();
  });
});
