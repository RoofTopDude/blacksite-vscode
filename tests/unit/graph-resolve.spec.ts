import { describe, expect, it } from "vitest";
import { joinPosix, resolveSpecifier } from "../../src/graph/resolve-imports.js";

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
  "other/main.py",
  "styles/site.scss",
  "styles/base.css",
  "styles/_partial.scss",
]);

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
