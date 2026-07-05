import { describe, expect, it } from "vitest";
import { buildGoDirIndex, parseGoMod, resolveGoImport } from "../../src/graph/go-modules.js";

describe("parseGoMod", () => {
  it("reads the module path and records the config dir", () => {
    expect(parseGoMod("services/api", "module github.com/acme/api\n\ngo 1.22\n"))
      .toEqual({ root: "services/api", module: "github.com/acme/api" });
  });

  it("returns null without a module line", () => {
    expect(parseGoMod("", "go 1.22\nrequire github.com/x/y v1.0.0\n")).toBeNull();
  });
});

const FILES = new Set([
  "cmd/main.go",
  "internal/store/store.go",
  "internal/store/query.go",
  "internal/store/store_test.go",
  "pkg/util/util.go",
  "vendored/only_test.go",
]);
const MODULES = [{ root: "", module: "github.com/acme/app" }];

describe("resolveGoImport", () => {
  it("fans a package import out to its non-test source files", () => {
    const targets = resolveGoImport("cmd/main.go", "github.com/acme/app/internal/store", FILES, MODULES);
    expect(targets.sort()).toEqual(["internal/store/query.go", "internal/store/store.go"]);
  });

  it("excludes the importing file itself", () => {
    const targets = resolveGoImport("internal/store/store.go", "github.com/acme/app/internal/store", FILES, MODULES);
    expect(targets).toEqual(["internal/store/query.go"]);
  });

  it("falls back to test files only when a package has no source files", () => {
    expect(resolveGoImport("cmd/main.go", "github.com/acme/app/vendored", FILES, MODULES))
      .toEqual(["vendored/only_test.go"]);
  });

  it("ignores stdlib and third-party imports", () => {
    expect(resolveGoImport("cmd/main.go", "fmt", FILES, MODULES)).toEqual([]);
    expect(resolveGoImport("cmd/main.go", "github.com/other/lib/x", FILES, MODULES)).toEqual([]);
  });

  it("prefers the most specific module in a monorepo", () => {
    const files = new Set(["a/x.go", "b/api/y.go"]);
    const modules = [
      { root: "", module: "github.com/acme/app" },
      { root: "b/api", module: "github.com/acme/app/api" },
    ];
    /* The nested module owns the import; it must resolve under b/api, not a/. */
    expect(resolveGoImport("cmd/main.go", "github.com/acme/app/api", files, modules)).toEqual(["b/api/y.go"]);
  });

  it("produces identical results whether or not a precomputed dir index is supplied", () => {
    const dirIndex = buildGoDirIndex(FILES);
    const withIndex = resolveGoImport("cmd/main.go", "github.com/acme/app/internal/store", FILES, MODULES, dirIndex).sort();
    const withoutIndex = resolveGoImport("cmd/main.go", "github.com/acme/app/internal/store", FILES, MODULES).sort();
    expect(withIndex).toEqual(withoutIndex);
    expect(withIndex).toEqual(["internal/store/query.go", "internal/store/store.go"]);
  });

  it("dir index fast path still excludes the importing file and falls back to tests", () => {
    const dirIndex = buildGoDirIndex(FILES);
    expect(resolveGoImport("internal/store/store.go", "github.com/acme/app/internal/store", FILES, MODULES, dirIndex))
      .toEqual(["internal/store/query.go"]);
    expect(resolveGoImport("cmd/main.go", "github.com/acme/app/vendored", FILES, MODULES, dirIndex))
      .toEqual(["vendored/only_test.go"]);
  });
});

describe("buildGoDirIndex", () => {
  it("groups .go files by directory and ignores non-.go files", () => {
    const index = buildGoDirIndex(["a/x.go", "a/y.go", "a/readme.md", "b/z.go"]);
    expect(index.get("a")?.sort()).toEqual(["a/x.go", "a/y.go"]);
    expect(index.get("b")).toEqual(["b/z.go"]);
    expect(index.has("")).toBe(false);
  });

  it("keys root-level files under the empty-string directory", () => {
    const index = buildGoDirIndex(["main.go"]);
    expect(index.get("")).toEqual(["main.go"]);
  });
});
