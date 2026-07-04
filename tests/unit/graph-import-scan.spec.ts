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
  it("captures import and from-import forms plus imported submodules", () => {
    const source = [
      "import os",
      "import a.b as ab, c.d",
      "from ..models import user",
      "from .helpers import thing, other as o",
    ].join("\n");
    const specs = extractImports("pkg/mod.py", source);
    /* Enhanced: each imported name is also offered as a submodule (mod.name). */
    expect(specs).toEqual(expect.arrayContaining([
      "os", "a.b", "c.d",
      "..models", "..models.user",
      ".helpers", ".helpers.thing", ".helpers.other",
    ]));
  });

  it("handles `from . import sub` and one-line paren groups", () => {
    const specs = extractImports("pkg/mod.py", "from . import sibling\nfrom .x import (a, b)");
    expect(specs).toEqual(expect.arrayContaining([".sibling", ".x", ".x.a", ".x.b"]));
  });

  it("skips star imports' names", () => {
    const specs = extractImports("m.py", "from pkg import *");
    expect(specs).toEqual(["pkg"]);
  });

  it("ignores indented non-import lines mentioning import", () => {
    const specs = extractImports("m.py", `x = "import fake"`);
    expect(specs).toEqual([]);
  });
});

describe("extractImports — more languages", () => {
  it("C/C++ captures quoted includes only, not system headers", () => {
    const specs = extractImports("src/main.c", `#include "util.h"\n#include <stdio.h>\n# include  "../inc/a.h"`);
    expect(specs).toEqual(expect.arrayContaining(["util.h", "../inc/a.h"]));
    expect(specs).not.toContain("stdio.h");
  });

  it("Rust captures mod declarations as mod: specs", () => {
    const specs = extractImports("src/lib.rs", "pub mod parser;\nmod util;\nuse crate::x;");
    expect(specs).toEqual(expect.arrayContaining(["mod:parser", "mod:util"]));
  });

  it("Ruby captures require_relative and relative require", () => {
    const specs = extractImports("lib/a.rb", `require_relative "helper"\nrequire "./sib"\nrequire "json"`);
    expect(specs).toEqual(expect.arrayContaining(["helper", "./sib"]));
    expect(specs).not.toContain("json");
  });

  it("PHP captures require/include with _once variants", () => {
    const specs = extractImports("app/a.php", `require_once 'lib/db.php';\ninclude "./nav.php";`);
    expect(specs).toEqual(expect.arrayContaining(["lib/db.php", "./nav.php"]));
  });

  it("HTML captures relative src/href but drops absolute URLs", () => {
    const specs = extractImports("public/index.html", `<script src="./app.js"></script><link href="https://cdn/x.css"><link href="styles.css">`);
    expect(specs).toEqual(expect.arrayContaining(["./app.js", "styles.css"]));
    expect(specs).not.toContain("https://cdn/x.css");
  });

  it("Vue/Svelte scan the embedded script for ES imports", () => {
    const specs = extractImports("src/App.vue", `<script>import Foo from "./Foo.vue";</script>`);
    expect(specs).toContain("./Foo.vue");
  });
});

describe("extractImports — Razor / Blazor", () => {
  it("captures Layout, partials, and view components as view: specs", () => {
    const source = [
      `@{ Layout = "_Layout"; }`,
      `@await Html.PartialAsync("_Nav")`,
      `<partial name="_Footer" />`,
      `@await Component.InvokeAsync("Cart")`,
    ].join("\n");
    const specs = extractImports("Views/Home/Index.cshtml", source);
    expect(specs).toEqual(expect.arrayContaining(["view:_Layout", "view:_Nav", "view:_Footer", "view:Cart"]));
  });

  it("captures Blazor PascalCase component tags in .razor only", () => {
    const razor = extractImports("Pages/Index.razor", `<NavMenu /><EditForm Model="x"><input /></EditForm>`);
    expect(razor).toEqual(expect.arrayContaining(["view:NavMenu", "view:EditForm"]));
    /* Plain HTML tags are not components. */
    expect(razor).not.toContain("view:input");
    const cshtml = extractImports("Views/Home/Index.cshtml", `<NavMenu />`);
    expect(cshtml).not.toContain("view:NavMenu");
  });
});

describe("extractImports — CSS", () => {
  it("captures @import and @use", () => {
    const source = `@import "./base.css";\n@import url(./fonts.css);\n@use "sass:math";`;
    const specs = extractImports("styles/site.scss", source);
    expect(specs).toEqual(expect.arrayContaining(["./base.css", "./fonts.css", "sass:math"]));
  });
});
