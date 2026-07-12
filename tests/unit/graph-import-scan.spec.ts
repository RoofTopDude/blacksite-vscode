import { describe, expect, it } from "vitest";
import { extractImports, scanWindows } from "../../src/graph/import-scan.js";

describe("scanWindows", () => {
  it("returns the whole content as one window when it fits", () => {
    expect([...scanWindows("short content", 512_000)]).toEqual(["short content"]);
  });

  it("covers the entire content across overlapping windows", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const windows = [...scanWindows(lines, 200, 60)];
    expect(windows.length).toBeGreaterThan(1);
    /* Every line appears in at least one window — nothing is dropped. */
    for (let i = 0; i < 500; i += 1) expect(windows.some((w) => w.includes(`line ${i}\n`) || w.endsWith(`line ${i}`))).toBe(true);
  });
});

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

  it("still finds an import far past the old 512 KB truncation point (windowed)", () => {
    /* A generated-file scenario: an import near the top, then again after ~2 MB
       of filler. The old code truncated at 512 KB and lost the second one. */
    const filler = `const x = ${JSON.stringify("y".repeat(80))};\n`.repeat(26_000); // ~2.6 MB
    const source = `import { top } from "./top.js";\n${filler}import { deep } from "./deep.js";\n`;
    expect(source.length).toBeGreaterThan(2_000_000);
    const specs = extractImports("src/generated.ts", source);
    expect(specs).toContain("./top.js");
    expect(specs).toContain("./deep.js");
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

  it("Rust captures mod declarations and use statements as mod:/use: specs", () => {
    const specs = extractImports(
      "src/lib.rs",
      "pub mod parser;\nmod util;\nuse crate::net::Client;\npub use self::parser::{Ast, Token};\nuse super::shared as sh;\nuse serde::Serialize;",
    );
    expect(specs).toEqual(expect.arrayContaining([
      "mod:parser", "mod:util",
      "use:crate::net::Client", "use:self::parser", "use:super::shared", "use:serde::Serialize",
    ]));
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

describe("extractImports — Go", () => {
  it("captures single and grouped imports, incl. aliased/blank/dot", () => {
    const source = [
      `package main`,
      `import "fmt"`,
      `import (`,
      `  "github.com/acme/app/internal/store"`,
      `  st "github.com/acme/app/pkg/util"`,
      `  _ "github.com/acme/app/pkg/side"`,
      `  . "github.com/acme/app/pkg/dot"`,
      `)`,
    ].join("\n");
    const specs = extractImports("cmd/main.go", source);
    expect(specs).toEqual(expect.arrayContaining([
      "fmt",
      "github.com/acme/app/internal/store",
      "github.com/acme/app/pkg/util",
      "github.com/acme/app/pkg/side",
      "github.com/acme/app/pkg/dot",
    ]));
  });

  it("does not confuse a struct field named import", () => {
    const specs = extractImports("a.go", `type T struct {\n  data string\n}`);
    expect(specs).toEqual([]);
  });
});

describe("extractImports — Java", () => {
  it("captures class, static, and wildcard imports", () => {
    const source = [
      `package com.acme.app;`,
      `import com.acme.app.model.User;`,
      `import static com.acme.app.util.Strings.trim;`,
      `import com.acme.app.dao.*;`,
      `import java.util.List;`,
    ].join("\n");
    const specs = extractImports("src/main/java/com/acme/app/Main.java", source);
    /* Static imports are tagged "static:" — the resolver only retries with the
       last segment dropped (to recover the class from a static member) for
       imports that were actually static. */
    expect(specs).toEqual(expect.arrayContaining([
      "com.acme.app.model.User",
      "static:com.acme.app.util.Strings.trim",
      "com.acme.app.dao.*",
      "java.util.List",
    ]));
  });
});

describe("extractImports — C#", () => {
  it("captures namespace, alias, and static using directives", () => {
    const source = [
      `global using Acme.App.Models;`,
      `using Json = Acme.App.Util.JsonHelper;`,
      `using static Acme.App.Util.MathEx;`,
      `using System;`,
    ].join("\n");
    const specs = extractImports("src/App.cs", source);
    expect(specs).toEqual(expect.arrayContaining([
      "csharp-ns:Acme.App.Models",
      "csharp-alias:Acme.App.Util.JsonHelper",
      "csharp-type:Acme.App.Util.MathEx",
      "csharp-ns:System",
    ]));
  });

  it("does not confuse `using var` statements with imports", () => {
    const specs = extractImports("src/App.cs", `using var stream = Open();`);
    expect(specs).toEqual([]);
  });
});

describe("extractImports — JS runtime references", () => {
  it("captures require.resolve, import.meta.url worker URLs, importScripts, and jest/vitest mocks", () => {
    const source = [
      `const p = require.resolve("./config");`,
      `const w = new Worker(new URL("./worker.js", import.meta.url));`,
      `importScripts("./a.js", "./b.js");`,
      `jest.mock("./service");`,
      `vi.importActual("../real");`,
    ].join("\n");
    const specs = extractImports("src/app.js", source);
    expect(specs).toEqual(expect.arrayContaining([
      "./config", "./worker.js", "./a.js", "./b.js", "./service", "../real",
    ]));
  });

  it("ignores a `new URL` that is not import.meta.url based", () => {
    expect(extractImports("src/app.js", `const u = new URL("https://x.com/a.js", base);`)).toEqual([]);
  });
});

describe("extractImports — JSON", () => {
  it("captures $ref, extends, references paths, and relative string values", () => {
    const source = JSON.stringify({
      extends: "./tsconfig.base.json",
      references: [{ path: "../shared" }],
      $ref: "./schema.json#/defs/User",
      compilerOptions: { outDir: "./dist" },
      nested: { file: "./data/values.json" },
    });
    const specs = extractImports("packages/app/tsconfig.json", source);
    expect(specs).toEqual(expect.arrayContaining([
      "./tsconfig.base.json", "../shared", "./schema.json", "./dist", "./data/values.json",
    ]));
  });

  it("drops the URL fragment on a $ref", () => {
    expect(extractImports("api/openapi.json", `{ "$ref": "common.json#/components/schemas/Error" }`)).toContain("common.json");
  });

  it("extracts a bare-package extends verbatim (resolution is what drops it)", () => {
    expect(extractImports("tsconfig.json", `{ "extends": "@tsconfig/node18/tsconfig.json" }`))
      .toContain("@tsconfig/node18/tsconfig.json");
  });

  it("captures bare path-looking values (manifest scripts, package entry points)", () => {
    const source = JSON.stringify({
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["src/content.js"], matches: ["https://*/*"] }],
      action: { default_popup: "popup.html" },
      main: "dist/index.js",
      version: "1.2.3",
      homepage: "https://example.com/index.html",
      include: "src/*.ts",
      description: "reads data.json at runtime",
    });
    const specs = extractImports("manifest.json", source);
    expect(specs).toEqual(expect.arrayContaining([
      "background.js", "src/content.js", "popup.html", "dist/index.js",
    ]));
    expect(specs).not.toContain("1.2.3"); // version strings need a letter-led extension
    expect(specs).not.toContain("https://example.com/index.html"); // URLs
    expect(specs).not.toContain("https://*/*");
    expect(specs).not.toContain("src/*.ts"); // globs
    expect(specs).not.toContain("reads data.json at runtime"); // contains spaces
  });

  it("scans .jsonc and .webmanifest files with the same JSON extraction", () => {
    expect(extractImports("app/tsconfig.jsonc", `{ "extends": "./tsconfig.base.json" }`))
      .toContain("./tsconfig.base.json");
    expect(extractImports("public/app.webmanifest", `{ "start_url": "index.html" }`))
      .toContain("index.html");
  });

  it("caps the specs contributed by a giant data blob", () => {
    const entries = Array.from({ length: 600 }, (_, i) => `"asset-${i}.png"`).join(",");
    const specs = extractImports("data.json", `{ "assets": [${entries}] }`);
    expect(specs.length).toBeLessThanOrEqual(400);
  });
});

describe("extractImports — C# own-namespace declarations", () => {
  it("emits the file's own namespace (file-scoped and block) as csharp-ns specs", () => {
    expect(extractImports("src/Orders/OrderService.cs", `namespace Acme.App.Orders;\n\npublic class OrderService { }`))
      .toContain("csharp-ns:Acme.App.Orders");
    expect(extractImports("src/Legacy/Widget.cs", `namespace Acme.Legacy\n{\n  class Widget { }\n}`))
      .toContain("csharp-ns:Acme.Legacy");
  });

  it("does not emit a namespace for indented mentions inside code", () => {
    const specs = extractImports("src/A.cs", `class A { void M() { var s = "namespace Fake.Ns"; } }`);
    expect(specs).toEqual([]);
  });
});

describe("extractImports - additional built-in languages", () => {
  it("captures Kotlin and Scala JVM imports, aliases, and selector groups", () => {
    const kotlin = extractImports("src/App.kt", [
      "import com.acme.shared.User",
      "import com.acme.shared.format as formatUser",
    ].join("\n"));
    expect(kotlin).toEqual(expect.arrayContaining(["com.acme.shared.User", "com.acme.shared.format"]));

    const scala = extractImports("src/App.scala", [
      "import com.acme.model.{User, Order => Purchase}",
      "import _root_.com.acme.shared.Helpers",
    ].join("\n"));
    expect(scala).toEqual(expect.arrayContaining([
      "com.acme.model.User", "com.acme.model.Order", "com.acme.shared.Helpers",
    ]));
  });

  it("captures Dart import/export/part URIs", () => {
    const specs = extractImports("packages/app/lib/main.dart", [
      "import 'package:shared/src/model.dart';",
      "export './src/public.dart';",
      "part 'main.g.dart';",
      "import 'dart:async';",
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining([
      "package:shared/src/model.dart", "./src/public.dart", "main.g.dart", "dart:async",
    ]));
  });

  it("captures Lua module and literal file loaders", () => {
    const specs = extractImports("scripts/main.lua", [
      "local util = require('lib.util')",
      "require \"shared\"",
      "dofile('./boot.lua')",
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining([
      "lua:lib.util", "lua:shared", "lua-file:./boot.lua",
    ]));
  });

  it("captures Elixir module dependencies and literal required files", () => {
    const specs = extractImports("lib/my_app/router.ex", [
      "alias MyApp.{Accounts, Repo}",
      "use MyApp.Web, :controller",
      "Code.require_file(\"support.exs\", __DIR__)",
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining([
      "elixir:MyApp.Accounts", "elixir:MyApp.Repo", "elixir:MyApp.Web", "elixir-file:support.exs",
    ]));
  });

  it("captures literal shell sources and ignores dynamic paths", () => {
    const specs = extractImports("scripts/main.sh", [
      "source \"./lib/common.sh\"",
      ". ../shared/env.sh",
      "# shellcheck source=./lib/generated.sh",
      "source \"$SCRIPT_DIR/dynamic.sh\"",
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining([
      "./lib/common.sh", "../shared/env.sh", "./lib/generated.sh",
    ]));
    expect(specs.some((spec) => spec.includes("dynamic"))).toBe(false);
  });
});

describe("extractImports — manifests & orchestration", () => {
  it("Cargo.toml path deps and workspace members become manifest-dir specs (Issue 7)", () => {
    const specs = extractImports("crates/app/Cargo.toml", [
      "[package]",
      'name = "app"',
      "[dependencies]",
      'core = { path = "../core" }',
      'serde = "1"',
      "[workspace]",
      'members = ["crates/a", "crates/b"]',
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining([
      "manifest-dir:../core", "manifest-dir:crates/a", "manifest-dir:crates/b",
    ]));
    expect(specs.some((spec) => spec.includes("serde"))).toBe(false);
  });

  it("requirements.txt editable installs and includes become manifest-dir/path specs (Issue 7)", () => {
    const specs = extractImports("requirements.txt", [
      "-e ./libs/shared",
      "-r base.txt",
      "requests==2.31.0",
      "-e git+https://example.com/pkg.git#egg=pkg",
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining(["manifest-dir:./libs/shared", "path:base.txt"]));
    expect(specs.some((spec) => spec.includes("git+"))).toBe(false);
  });

  it("Makefile include directives become path specs (Issue 10)", () => {
    const specs = extractImports("Makefile", "include common.mk config/build.mk\n-include $(GENERATED)\n");
    expect(specs).toEqual(expect.arrayContaining(["path:common.mk", "path:config/build.mk"]));
    expect(specs.some((spec) => spec.includes("GENERATED"))).toBe(false);
  });

  it("docker-compose build contexts and file refs become manifest-dir/path specs (Issue 10)", () => {
    const specs = extractImports("docker-compose.yml", [
      "services:",
      "  api:",
      "    build: ./api",
      "  worker:",
      "    build:",
      "      context: ./worker",
      "      dockerfile: Dockerfile.prod",
      "    env_file: ./worker/.env",
    ].join("\n"));
    expect(specs).toEqual(expect.arrayContaining([
      "manifest-dir:./api", "manifest-dir:./worker", "path:Dockerfile.prod", "path:./worker/.env",
    ]));
  });
});
