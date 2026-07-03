import { describe, expect, it } from "vitest";
import { extractImports } from "../../src/graph/import-scan.js";

describe("extractImports — TS/JS", () => {
  it("captures static, re-export, require, and dynamic imports", () => {
    const source = [
      `import { a } from "./util.js";`,
      `import type { T } from "../types";`,
      `import "./side-effect.css";`,
      `export * from "./barrel";`,
      `export { b } from './named';`,
      `const c = require("./legacy");`,
      `const d = await import("./lazy");`,
      `import react from "react";`,
    ].join("\n");
    const specs = extractImports("src/a.ts", source);
    expect(specs).toEqual(expect.arrayContaining([
      "./util.js", "../types", "./side-effect.css", "./barrel", "./named", "./legacy", "./lazy", "react",
    ]));
  });

  it("handles multiline import blocks", () => {
    const source = `import {\n  one,\n  two,\n} from "./multi";\n`;
    expect(extractImports("a.tsx", source)).toContain("./multi");
  });

  it("does not scan non-code languages", () => {
    expect(extractImports("readme.md", `import { x } from "./y";`)).toEqual([]);
  });

  it("dedupes repeated specifiers", () => {
    const source = `import { a } from "./x";\nimport { b } from "./x";`;
    expect(extractImports("a.ts", source)).toEqual(["./x"]);
  });
});

describe("extractImports — Python", () => {
  it("captures import and from-import forms", () => {
    const source = [
      "import os",
      "import a.b as ab, c.d",
      "from ..models import user",
      "from .helpers import thing",
    ].join("\n");
    const specs = extractImports("pkg/mod.py", source);
    expect(specs).toEqual(expect.arrayContaining(["os", "a.b", "c.d", "..models", ".helpers"]));
  });

  it("ignores indented non-import lines mentioning import", () => {
    const specs = extractImports("m.py", `x = "import fake"`);
    expect(specs).toEqual([]);
  });
});

describe("extractImports — CSS", () => {
  it("captures @import and @use", () => {
    const source = `@import "./base.css";\n@import url(./fonts.css);\n@use "sass:math";`;
    const specs = extractImports("styles/site.scss", source);
    expect(specs).toEqual(expect.arrayContaining(["./base.css", "./fonts.css", "sass:math"]));
  });
});
