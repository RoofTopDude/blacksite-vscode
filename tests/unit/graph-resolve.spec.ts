import { describe, expect, it } from "vitest";
import { buildBasenameIndex, joinPosix, resolveSpecifier, resolveSpecifierTargets } from "../../src/graph/resolve-imports.js";
import { buildCSharpIndex, referencedTypeNames } from "../../src/graph/csharp-index.js";
import { buildAliasTable, parseTsconfig } from "../../src/graph/tsconfig-paths.js";
import { parseGoMod } from "../../src/graph/go-modules.js";
import { extractImports } from "../../src/graph/import-scan.js";

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
  // TS path aliases
  "src/components/Button.tsx",
  "src/lib/util/format.ts",
  "packages/ui/src/index.ts",
  // Go
  "go.mod",
  "cmd/main.go",
  "internal/store/store.go",
  "internal/store/query.go",
  "internal/store/store_test.go",
  "pkg/util/util.go",
  // Java
  "src/main/java/com/acme/app/Main.java",
  "src/main/java/com/acme/app/model/User.java",
  "src/main/java/com/acme/app/util/Strings.java",
  // Kotlin / Scala
  "src/main/kotlin/com/acme/shared/User.kt",
  "src/main/kotlin/com/acme/shared/Formatter.kt",
  "src/main/scala/com/acme/model/Order.scala",
  "src/main/scala/com/acme/shared/Helpers.scala",
  // Dart
  "packages/app/lib/main.dart",
  "packages/app/lib/src/local.dart",
  "packages/shared/lib/src/model.dart",
  // Lua
  "scripts/main.lua",
  "scripts/lib/util.lua",
  "scripts/boot.lua",
  "shared/init.lua",
  // Elixir
  "apps/billing/lib/my_app/router.ex",
  "apps/billing/lib/my_app/accounts/user.ex",
  "apps/billing/lib/my_app/web.ex",
  "apps/billing/lib/my_app/support.exs",
  // Shell
  "scripts/main.sh",
  "scripts/lib/common.sh",
  "shared/env.sh",
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

describe("resolveSpecifier — TS path aliases", () => {
  const aliases = buildAliasTable([
    parseTsconfig("", `{
      "compilerOptions": {
        "baseUrl": "src",
        "paths": {
          "@app/*": ["*"],
          "@ui": ["../packages/ui/src/index.ts"],
          "~/lib/*": ["lib/util/*"]
        }
      }
    }`)!,
  ]);
  const ALIAS_CTX = { byBasename: buildBasenameIndex(FILES), aliases };

  it("resolves a wildcard alias through baseUrl", () => {
    expect(resolveSpecifier("src/app.ts", "@app/components/Button", FILES, ALIAS_CTX)).toBe("src/components/Button.tsx");
  });

  it("resolves an exact (non-wildcard) alias", () => {
    expect(resolveSpecifier("src/app.ts", "@ui", FILES, ALIAS_CTX)).toBe("packages/ui/src/index.ts");
  });

  it("strips a query/hash suffix before matching an exact alias", () => {
    /* "@ui" is an exact (non-wildcard) pattern — without stripping the query
       string first, "@ui?raw" would fail the === comparison and never match,
       even though the equivalent relative import already handles this. */
    expect(resolveSpecifier("src/app.ts", "@ui?raw", FILES, ALIAS_CTX)).toBe("packages/ui/src/index.ts");
  });

  it("remaps a wildcard onto a different subtree", () => {
    expect(resolveSpecifier("src/app.ts", "~/lib/format", FILES, ALIAS_CTX)).toBe("src/lib/util/format.ts");
  });

  it("resolves a bare specifier via baseUrl alone", () => {
    expect(resolveSpecifier("src/app.ts", "components/Button", FILES, ALIAS_CTX)).toBe("src/components/Button.tsx");
  });

  it("returns null for an unaliased bare specifier", () => {
    expect(resolveSpecifier("src/app.ts", "react", FILES, ALIAS_CTX)).toBeNull();
  });

  it("still returns null without an alias table", () => {
    expect(resolveSpecifier("src/app.ts", "@app/components/Button", FILES)).toBeNull();
  });
});

describe("resolveSpecifierTargets — Go", () => {
  const goModules = [parseGoMod("", "module github.com/acme/app\n\ngo 1.21\n")!];
  const GO_CTX = { goModules };

  it("fans a package import out to its non-test source files", () => {
    const targets = resolveSpecifierTargets("cmd/main.go", "github.com/acme/app/internal/store", FILES, GO_CTX);
    expect(targets).toEqual(expect.arrayContaining(["internal/store/store.go", "internal/store/query.go"]));
    expect(targets).not.toContain("internal/store/store_test.go");
  });

  it("resolves a single-file package", () => {
    expect(resolveSpecifierTargets("cmd/main.go", "github.com/acme/app/pkg/util", FILES, GO_CTX)).toEqual(["pkg/util/util.go"]);
  });

  it("ignores stdlib and third-party imports", () => {
    expect(resolveSpecifierTargets("cmd/main.go", "fmt", FILES, GO_CTX)).toEqual([]);
    expect(resolveSpecifierTargets("cmd/main.go", "github.com/other/lib", FILES, GO_CTX)).toEqual([]);
  });

  it("wraps single-file languages in an array", () => {
    expect(resolveSpecifierTargets("src/a.ts", "./util", FILES)).toEqual(["src/util.ts"]);
    expect(resolveSpecifierTargets("src/a.ts", "react", FILES)).toEqual([]);
  });
});

describe("resolveSpecifier — Java", () => {
  it("resolves a FQCN under a source root by path suffix", () => {
    expect(resolveSpecifier("src/main/java/com/acme/app/Main.java", "com.acme.app.model.User", FILES, CTX))
      .toBe("src/main/java/com/acme/app/model/User.java");
  });

  it("recovers the class from a tagged static import by dropping the member", () => {
    expect(resolveSpecifier("src/main/java/com/acme/app/Main.java", "static:com.acme.app.util.Strings.trim", FILES, CTX))
      .toBe("src/main/java/com/acme/app/util/Strings.java");
  });

  it("does NOT drop a segment for a plain (non-static) import that fails to resolve", () => {
    /* Regression guard: without the "static:" tag, "trim" isn't a member to
       recover from — it's just an unresolvable class, so this must stay null
       rather than wrongly wiring into Strings.java. */
    expect(resolveSpecifier("src/main/java/com/acme/app/Main.java", "com.acme.app.util.Strings.trim", FILES, CTX)).toBeNull();
  });

  it("skips package wildcards and unknown/stdlib classes", () => {
    expect(resolveSpecifier("src/main/java/com/acme/app/Main.java", "com.acme.app.dao.*", FILES, CTX)).toBeNull();
    expect(resolveSpecifier("src/main/java/com/acme/app/Main.java", "java.util.List", FILES, CTX)).toBeNull();
  });
});

describe("resolveSpecifierTargets — C#", () => {
  const CSHARP_FILES = new Set([
    "src/cs/Program.cs",
    "src/cs/Models/User.cs",
    "src/cs/Models/Order.cs",
    "src/cs/Util/MathEx.cs",
    "src/cs/Util/JsonHelper.cs",
  ]);
  const CSHARP_CTX = {
    csharp: buildCSharpIndex([
      { path: "src/cs/Program.cs", content: `namespace Acme.App; public class Program {}` },
      { path: "src/cs/Models/User.cs", content: `namespace Acme.App.Models; public class User {}` },
      { path: "src/cs/Models/Order.cs", content: `namespace Acme.App.Models; public record Order;` },
      { path: "src/cs/Util/MathEx.cs", content: `namespace Acme.App.Util; public static class MathEx {}` },
      { path: "src/cs/Util/JsonHelper.cs", content: `namespace Acme.App.Util; public class JsonHelper {}` },
    ]),
  };

  it("fans a namespace using out to every file declared in that namespace", () => {
    const targets = resolveSpecifierTargets("src/cs/Program.cs", "csharp-ns:Acme.App.Models", CSHARP_FILES, CSHARP_CTX).sort();
    expect(targets).toEqual(["src/cs/Models/Order.cs", "src/cs/Models/User.cs"]);
  });

  it("resolves a static using to the declaring type", () => {
    expect(resolveSpecifier("src/cs/Program.cs", "csharp-type:Acme.App.Util.MathEx", CSHARP_FILES, CSHARP_CTX))
      .toBe("src/cs/Util/MathEx.cs");
  });

  it("lets an alias target resolve as a type before falling back to a namespace", () => {
    expect(resolveSpecifierTargets("src/cs/Program.cs", "csharp-alias:Acme.App.Util.JsonHelper", CSHARP_FILES, CSHARP_CTX))
      .toEqual(["src/cs/Util/JsonHelper.cs"]);
  });

  /* A data-layer namespace (EF entities) with many files is exactly what fanned
     out into 600+ imported-by hairballs. With the consuming file's referenced
     type names, a `using` on such a namespace should link only to the types
     actually used, not every file in it. */
  const BIG_NS_FILES = new Set([
    "src/cs/App.cs",
    "src/cs/Data/Ticket.cs", "src/cs/Data/Invoice.cs", "src/cs/Data/Customer.cs",
    "src/cs/Data/Order.cs", "src/cs/Data/Product.cs", "src/cs/Data/Payment.cs", "src/cs/Data/Shipment.cs",
  ]);
  const BIG_NS_CTX = {
    csharp: buildCSharpIndex([
      { path: "src/cs/Data/Ticket.cs", content: `namespace Acme.Data; public class Ticket {}` },
      { path: "src/cs/Data/Invoice.cs", content: `namespace Acme.Data; public class Invoice {}` },
      { path: "src/cs/Data/Customer.cs", content: `namespace Acme.Data; public class Customer {}` },
      { path: "src/cs/Data/Order.cs", content: `namespace Acme.Data; public class Order {}` },
      { path: "src/cs/Data/Product.cs", content: `namespace Acme.Data; public class Product {}` },
      { path: "src/cs/Data/Payment.cs", content: `namespace Acme.Data; public class Payment {}` },
      { path: "src/cs/Data/Shipment.cs", content: `namespace Acme.Data; public class Shipment {}` },
    ]),
  };

  it("scopes a large namespace using to only the referenced types", () => {
    const referenced = referencedTypeNames(`public class App { void Run() { var t = new Ticket(); Invoice inv = Load(); } }`);
    const targets = resolveSpecifierTargets("src/cs/App.cs", "csharp-ns:Acme.Data", BIG_NS_FILES, BIG_NS_CTX, referenced).sort();
    expect(targets).toEqual(["src/cs/Data/Invoice.cs", "src/cs/Data/Ticket.cs"]);
  });

  it("contributes no edge when a large namespace using references none of its types", () => {
    const referenced = referencedTypeNames(`public class App { void Run() { Console.WriteLine("hi"); } }`);
    expect(resolveSpecifierTargets("src/cs/App.cs", "csharp-ns:Acme.Data", BIG_NS_FILES, BIG_NS_CTX, referenced)).toEqual([]);
  });

  it("still fans a large namespace out fully when no reference set is supplied", () => {
    const targets = resolveSpecifierTargets("src/cs/App.cs", "csharp-ns:Acme.Data", BIG_NS_FILES, BIG_NS_CTX).sort();
    expect(targets).toHaveLength(7);
  });
});

describe("resolveSpecifier — JSON config references", () => {
  const JSON_FILES = new Set([
    "packages/app/tsconfig.json",
    "tsconfig.base.json",
    "packages/shared/tsconfig.json",
    "packages/app/schema.json",
  ]);

  it("resolves extends/relative refs to config files", () => {
    expect(resolveSpecifier("packages/app/tsconfig.json", "../../tsconfig.base.json", JSON_FILES)).toBe("tsconfig.base.json");
    expect(resolveSpecifier("packages/app/tsconfig.json", "./schema.json", JSON_FILES)).toBe("packages/app/schema.json");
  });

  it("resolves a tsconfig project reference pointing at a directory", () => {
    expect(resolveSpecifier("packages/app/tsconfig.json", "../shared", JSON_FILES)).toBe("packages/shared/tsconfig.json");
  });

  it("returns null for a bare package extends", () => {
    expect(resolveSpecifier("packages/app/tsconfig.json", "@tsconfig/node18/tsconfig.json", JSON_FILES)).toBeNull();
  });

  const MANIFEST_FILES = new Set([
    "manifest.json",
    "background.js",
    "popup.html",
    "src/content.js",
    ".vscode/settings.json",
    "scripts/gen.js",
    "app/public/app.webmanifest",
    "app/public/index.html",
  ]);

  it("resolves bare sibling paths from a manifest (extension manifests never write ./)", () => {
    expect(resolveSpecifier("manifest.json", "background.js", MANIFEST_FILES)).toBe("background.js");
    expect(resolveSpecifier("manifest.json", "popup.html", MANIFEST_FILES)).toBe("popup.html");
    expect(resolveSpecifier("manifest.json", "src/content.js", MANIFEST_FILES)).toBe("src/content.js");
  });

  it("walks ancestors for a bare path written relative to the workspace root", () => {
    expect(resolveSpecifier(".vscode/settings.json", "scripts/gen.js", MANIFEST_FILES)).toBe("scripts/gen.js");
  });

  it("does not ancestor-walk an explicitly relative path", () => {
    expect(resolveSpecifier(".vscode/settings.json", "./scripts/gen.js", MANIFEST_FILES)).toBeNull();
  });

  it("resolves web-root-absolute paths workspace-root-relative", () => {
    expect(resolveSpecifier("manifest.json", "/popup.html", MANIFEST_FILES)).toBe("popup.html");
  });

  it("dispatches .webmanifest files through the JSON resolver", () => {
    expect(resolveSpecifier("app/public/app.webmanifest", "index.html", MANIFEST_FILES)).toBe("app/public/index.html");
  });
});

/* The indexer's real path: extractImports(...) → resolveSpecifierTargets(...).
   These drive both halves together so a mismatch between what extraction emits
   and what resolution expects would surface. */
describe("extract → resolve integration", () => {
  const aliases = buildAliasTable([
    parseTsconfig("", `{ "compilerOptions": { "baseUrl": "src", "paths": { "@app/*": ["*"] } } }`)!,
  ]);
  const goModules = [parseGoMod("", "module github.com/acme/app\n")!];
  const ctx = { byBasename: buildBasenameIndex(FILES), aliases, goModules };
  const edgesFor = (from: string, content: string): string[] => {
    const out = new Set<string>();
    for (const spec of extractImports(from, content)) {
      for (const to of resolveSpecifierTargets(from, spec, FILES, ctx)) if (to !== from) out.add(to);
    }
    return [...out].sort();
  };

  it("wires a TS aliased import to a real file", () => {
    expect(edgesFor("src/app.ts", `import { Button } from "@app/components/Button";`))
      .toEqual(["src/components/Button.tsx"]);
  });

  it("wires a Go grouped import to its package files", () => {
    const edges = edgesFor("cmd/main.go", `import (\n  "fmt"\n  "github.com/acme/app/internal/store"\n)`);
    expect(edges).toEqual(["internal/store/query.go", "internal/store/store.go"]);
  });

  it("wires a Java class import to its file", () => {
    expect(edgesFor("src/main/java/com/acme/app/Main.java", `import com.acme.app.model.User;`))
      .toEqual(["src/main/java/com/acme/app/model/User.java"]);
  });

  it("wires C# using directives into file-level map edges", () => {
    const csharpFiles = new Set([
      ...FILES,
      "src/cs/Program.cs",
      "src/cs/Models/User.cs",
      "src/cs/Util/MathEx.cs",
    ]);
    const csharpCtx = {
      ...ctx,
      csharp: buildCSharpIndex([
        { path: "src/cs/Program.cs", content: `namespace Acme.App; public class Program {}` },
        { path: "src/cs/Models/User.cs", content: `namespace Acme.App.Models; public class User {}` },
        { path: "src/cs/Util/MathEx.cs", content: `namespace Acme.App.Util; public static class MathEx {}` },
      ]),
    };
    const out = new Set<string>();
    for (const spec of extractImports("src/cs/Program.cs", `using Acme.App.Models;\nusing static Acme.App.Util.MathEx;`)) {
      for (const to of resolveSpecifierTargets("src/cs/Program.cs", spec, csharpFiles, csharpCtx)) if (to !== "src/cs/Program.cs") out.add(to);
    }
    expect([...out].sort()).toEqual(["src/cs/Models/User.cs", "src/cs/Util/MathEx.cs"]);
  });

  it("wires same-namespace C# usage with no using directive at all", () => {
    const csharpFiles = new Set([
      "src/cs/Orders/OrderService.cs",
      "src/cs/Orders/OrderValidator.cs",
      "src/cs/Orders/Order.cs",
    ]);
    const csharpCtx = {
      csharp: buildCSharpIndex([
        { path: "src/cs/Orders/OrderService.cs", content: `namespace Acme.Orders; public class OrderService {}` },
        { path: "src/cs/Orders/OrderValidator.cs", content: `namespace Acme.Orders; public class OrderValidator {}` },
        { path: "src/cs/Orders/Order.cs", content: `namespace Acme.Orders; public class Order {}` },
      ]),
    };
    const source = `namespace Acme.Orders;\n\npublic class OrderService {\n  public bool Check(Order order) => new OrderValidator().Validate(order);\n}`;
    const referenced = referencedTypeNames(source);
    const out = new Set<string>();
    for (const spec of extractImports("src/cs/Orders/OrderService.cs", source)) {
      for (const to of resolveSpecifierTargets("src/cs/Orders/OrderService.cs", spec, csharpFiles, csharpCtx, referenced)) {
        if (to !== "src/cs/Orders/OrderService.cs") out.add(to);
      }
    }
    expect([...out].sort()).toEqual(["src/cs/Orders/Order.cs", "src/cs/Orders/OrderValidator.cs"]);
  });
});

describe("resolveSpecifier - additional built-in languages", () => {
  it("resolves Kotlin and Scala FQCNs across mixed JVM source roots", () => {
    expect(resolveSpecifier(
      "src/main/kotlin/com/acme/App.kt",
      "com.acme.shared.User",
      FILES,
      CTX,
    )).toBe("src/main/kotlin/com/acme/shared/User.kt");
    /* A member/nested-type import gets one containing-type retry. */
    expect(resolveSpecifier(
      "src/main/kotlin/com/acme/App.kt",
      "com.acme.shared.Formatter.format",
      FILES,
      CTX,
    )).toBe("src/main/kotlin/com/acme/shared/Formatter.kt");
    expect(resolveSpecifier(
      "src/main/scala/com/acme/App.scala",
      "com.acme.model.Order",
      FILES,
      CTX,
    )).toBe("src/main/scala/com/acme/model/Order.scala");
  });

  it("resolves Dart relative and workspace package URIs but not SDK URIs", () => {
    expect(resolveSpecifier("packages/app/lib/main.dart", "./src/local.dart", FILES, CTX))
      .toBe("packages/app/lib/src/local.dart");
    expect(resolveSpecifier("packages/app/lib/main.dart", "package:shared/src/model.dart", FILES, CTX))
      .toBe("packages/shared/lib/src/model.dart");
    expect(resolveSpecifier("packages/app/lib/main.dart", "dart:async", FILES, CTX)).toBeNull();
  });

  it("resolves Lua dotted modules, init modules, and literal file loaders", () => {
    expect(resolveSpecifier("scripts/main.lua", "lua:lib.util", FILES, CTX)).toBe("scripts/lib/util.lua");
    expect(resolveSpecifier("scripts/main.lua", "lua:shared", FILES, CTX)).toBe("shared/init.lua");
    expect(resolveSpecifier("scripts/main.lua", "lua-file:./boot.lua", FILES, CTX)).toBe("scripts/boot.lua");
  });

  it("resolves Elixir modules by snake-cased source suffix and literal files", () => {
    expect(resolveSpecifier(
      "apps/billing/lib/my_app/router.ex",
      "elixir:MyApp.Accounts.User",
      FILES,
      CTX,
    )).toBe("apps/billing/lib/my_app/accounts/user.ex");
    expect(resolveSpecifier(
      "apps/billing/lib/my_app/router.ex",
      "elixir:MyApp.Accounts.User.Profile",
      FILES,
      CTX,
    )).toBe("apps/billing/lib/my_app/accounts/user.ex");
    expect(resolveSpecifier(
      "apps/billing/lib/my_app/router.ex",
      "elixir-file:support.exs",
      FILES,
      CTX,
    )).toBe("apps/billing/lib/my_app/support.exs");
  });

  it("resolves shell source paths locally and from the workspace root", () => {
    expect(resolveSpecifier("scripts/main.sh", "./lib/common.sh", FILES, CTX)).toBe("scripts/lib/common.sh");
    expect(resolveSpecifier("scripts/main.sh", "shared/env", FILES, CTX)).toBe("shared/env.sh");
    expect(resolveSpecifier("scripts/main.sh", "$SCRIPT_DIR/private.sh", FILES, CTX)).toBeNull();
  });
});
