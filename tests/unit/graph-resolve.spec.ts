import { describe, expect, it } from "vitest";
import { buildBasenameIndex, joinPosix, resolveSpecifier } from "../../src/graph/resolve-imports.js";

const FILES = new Set([
  "src/a.ts",
  "src/util.ts",
  "src/comp.tsx",
  "src/dir/index.ts",
  "src/data.json",
  "lib/top.ts",
  "pkg/mod.py",
  "pkg/helpers.py",
  "pkg/models/__init__.py",
  "pkg/models/user.py",
  "pkg/models/order.py",
  "other/main.py",
  "styles/site.scss",
  "styles/base.css",
  "styles/_partial.scss",
  // C/C++
  "src/main.c",
  "src/util.h",
  "inc/api.h",
  // Rust
  "src/lib.rs",
  "src/parser.rs",
  "src/net/mod.rs",
  // Ruby
  "lib/a.rb",
  "lib/helper.rb",
  // PHP
  "app/index.php",
  "app/lib/db.php",
  "app/nav.php",
  // Vue / HTML
  "src/App.vue",
  "src/Foo.vue",
  "public/index.html",
  "public/app.js",
  // Razor
  "Views/Home/Index.cshtml",
  "Views/Shared/_Layout.cshtml",
  "Views/Shared/_Nav.cshtml",
  "Pages/Index.razor",
  "Shared/NavMenu.razor",
]);
const CTX = { byBasename: buildBasenameIndex(FILES) };

describe("joinPosix", () => {
  it("collapses relative segments", () => {
    expect(joinPosix("src/deep", "../util")).toBe("src/util");
    expect(joinPosix("src", "./x/./y")).toBe("src/x/y");
  });
  it("returns null when escaping the root", () => {
    expect(joinPosix("src", "../../outside")).toBeNull();
  });
});

describe("resolveSpecifier — TS/JS", () => {
  it("probes extensions and index files", () => {
    expect(resolveSpecifier("src/a.ts", "./util", FILES)).toBe("src/util.ts");
    expect(resolveSpecifier("src/a.ts", "./dir", FILES)).toBe("src/dir/index.ts");
    expect(resolveSpecifier("src/a.ts", "./data.json", FILES)).toBe("src/data.json");
  });

  it("maps NodeNext .js specifiers back to .ts/.tsx sources", () => {
    expect(resolveSpecifier("src/a.ts", "./util.js", FILES)).toBe("src/util.ts");
    expect(resolveSpecifier("src/a.ts", "./comp.js", FILES)).toBe("src/comp.tsx");
  });

  it("resolves parent-relative imports", () => {
    expect(resolveSpecifier("src/dir/index.ts", "../util", FILES)).toBe("src/util.ts");
  });

  it("returns null for bare package specifiers", () => {
    expect(resolveSpecifier("src/a.ts", "react", FILES)).toBeNull();
    expect(resolveSpecifier("src/a.ts", "@scope/pkg", FILES)).toBeNull();
  });

  it("returns null for unresolvable or escaping paths", () => {
    expect(resolveSpecifier("src/a.ts", "./missing", FILES)).toBeNull();
    expect(resolveSpecifier("src/a.ts", "../../../etc/passwd", FILES)).toBeNull();
  });

  it("strips query/hash suffixes", () => {
    expect(resolveSpecifier("src/a.ts", "./util?raw", FILES)).toBe("src/util.ts");
  });
});

describe("resolveSpecifier — Python", () => {
  it("resolves absolute dotted modules from the workspace root", () => {
    expect(resolveSpecifier("other/main.py", "pkg.helpers", FILES)).toBe("pkg/helpers.py");
    expect(resolveSpecifier("other/main.py", "pkg.models", FILES)).toBe("pkg/models/__init__.py");
  });

  it("resolves relative dotted modules", () => {
    expect(resolveSpecifier("pkg/mod.py", ".helpers", FILES)).toBe("pkg/helpers.py");
    expect(resolveSpecifier("pkg/models/user.py", "..helpers", FILES)).toBe("pkg/helpers.py");
  });

  it("returns null for stdlib/unknown modules", () => {
    expect(resolveSpecifier("pkg/mod.py", "os", FILES)).toBeNull();
  });
});

describe("resolveSpecifier — styles", () => {
  it("resolves css imports with and without extension", () => {
    expect(resolveSpecifier("styles/site.scss", "./base.css", FILES)).toBe("styles/base.css");
    expect(resolveSpecifier("styles/site.scss", "./base", FILES)).toBe("styles/base.css");
  });
  it("resolves scss partials", () => {
    expect(resolveSpecifier("styles/site.scss", "./partial", FILES)).toBe("styles/_partial.scss");
  });
});

describe("resolveSpecifier — Python submodules", () => {
  it("resolves an imported name as a submodule file", () => {
    expect(resolveSpecifier("other/main.py", "pkg.models.user", FILES)).toBe("pkg/models/user.py");
    expect(resolveSpecifier("pkg/mod.py", ".models.order", FILES)).toBe("pkg/models/order.py");
  });
});

describe("resolveSpecifier — C/C++", () => {
  it("resolves quoted includes relative to the including file", () => {
    expect(resolveSpecifier("src/main.c", "util.h", FILES)).toBe("src/util.h");
    expect(resolveSpecifier("src/main.c", "../inc/api.h", FILES)).toBe("inc/api.h");
  });
  it("returns null for unknown headers", () => {
    expect(resolveSpecifier("src/main.c", "stdio.h", FILES)).toBeNull();
  });
});

describe("resolveSpecifier — Rust / Ruby / PHP / Vue / HTML", () => {
  it("Rust mod: resolves to sibling .rs or dir/mod.rs", () => {
    expect(resolveSpecifier("src/lib.rs", "mod:parser", FILES)).toBe("src/parser.rs");
    expect(resolveSpecifier("src/lib.rs", "mod:net", FILES)).toBe("src/net/mod.rs");
    expect(resolveSpecifier("src/lib.rs", "mod:missing", FILES)).toBeNull();
  });
  it("Ruby require_relative resolves with optional .rb", () => {
    expect(resolveSpecifier("lib/a.rb", "helper", FILES)).toBe("lib/helper.rb");
  });
  it("PHP require resolves dir-relative and root-relative", () => {
    expect(resolveSpecifier("app/index.php", "./nav.php", FILES)).toBe("app/nav.php");
    expect(resolveSpecifier("app/index.php", "app/lib/db.php", FILES)).toBe("app/lib/db.php");
  });
  it("Vue resolves relative component imports", () => {
    expect(resolveSpecifier("src/App.vue", "./Foo.vue", FILES)).toBe("src/Foo.vue");
  });
  it("HTML resolves relative asset references", () => {
    expect(resolveSpecifier("public/index.html", "./app.js", FILES)).toBe("public/app.js");
  });
});

describe("resolveSpecifier — Razor views", () => {
  it("resolves a bare partial/layout name via the basename index, preferring Shared", () => {
    expect(resolveSpecifier("Views/Home/Index.cshtml", "view:_Layout", FILES, CTX)).toBe("Views/Shared/_Layout.cshtml");
    expect(resolveSpecifier("Views/Home/Index.cshtml", "view:_Nav", FILES, CTX)).toBe("Views/Shared/_Nav.cshtml");
  });
  it("resolves a ~/ rooted layout path", () => {
    expect(resolveSpecifier("Views/Home/Index.cshtml", "view:~/Views/Shared/_Layout.cshtml", FILES, CTX)).toBe("Views/Shared/_Layout.cshtml");
  });
  it("resolves a Blazor component tag to its .razor file", () => {
    expect(resolveSpecifier("Pages/Index.razor", "view:NavMenu", FILES, CTX)).toBe("Shared/NavMenu.razor");
  });
  it("returns null for an unknown view and without a basename index", () => {
    expect(resolveSpecifier("Pages/Index.razor", "view:Nonexistent", FILES, CTX)).toBeNull();
    expect(resolveSpecifier("Pages/Index.razor", "view:NavMenu", FILES)).toBeNull();
  });
});

describe("buildBasenameIndex", () => {
  it("maps lowercased basenames to every path carrying them", () => {
    const index = buildBasenameIndex(["a/Foo.ts", "b/foo.ts", "c/bar.ts"]);
    expect(index.get("foo.ts")).toEqual(["a/Foo.ts", "b/foo.ts"]);
    expect(index.get("bar.ts")).toEqual(["c/bar.ts"]);
  });
});
