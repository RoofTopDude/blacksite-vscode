import { describe, expect, it } from "vitest";
import {
  buildPythonSourceRoots,
  buildRustCrateIndex,
  buildWorkspacePackageIndex,
  parseCargoFacts,
  parsePackageJsonFacts,
  parsePythonProjectFacts,
  sourceTwins,
  splitPackageSpecifier,
  subpathTargets,
  workspacePackageCandidates,
} from "../../src/graph/workspace-packages.js";
import { resolveSpecifier } from "../../src/graph/resolve-imports.js";
import { buildResolveContextFromFacts } from "../../src/graph/scan-pipeline.js";
import { extractFileFacts, type FileFacts } from "../../src/graph/file-facts.js";

describe("package specifiers and export maps", () => {
  it("splits scoped and unscoped specifiers", () => {
    expect(splitPackageSpecifier("@acme/ui")).toEqual({ name: "@acme/ui", subpath: "." });
    expect(splitPackageSpecifier("@acme/ui/button/index")).toEqual({ name: "@acme/ui", subpath: "./button/index" });
    expect(splitPackageSpecifier("lodash/fp")).toEqual({ name: "lodash", subpath: "./fp" });
    expect(splitPackageSpecifier("./local")).toBeNull();
    expect(splitPackageSpecifier("node:fs")).toBeNull();
  });

  it("prefers source-ish conditions and substitutes * patterns", () => {
    const exports = {
      ".": { import: "./dist/index.mjs", types: "./dist/index.d.ts", source: "./src/index.ts" },
      "./widgets/*": { default: "./dist/widgets/*.js" },
    };
    expect(subpathTargets(exports, ".")[0]).toBe("./src/index.ts");
    expect(subpathTargets(exports, "./widgets/card")).toEqual(["./dist/widgets/card.js"]);
    expect(subpathTargets("./main.js", ".")).toEqual(["./main.js"]);
    expect(subpathTargets(exports, "./missing")).toEqual([]);
  });

  it("maps build output back to its source twin", () => {
    expect(sourceTwins("packages/ui/dist/widgets/card.js")).toContain("packages/ui/src/widgets/card");
    expect(sourceTwins("lib/index.d.ts")).toContain("src/index");
  });
});

describe("workspace package resolution", () => {
  const files = new Set([
    "web/src/app.ts",
    "shared/package.json",
    "shared/src/index.ts",
    "shared/src/format/date.ts",
    "shared/src/internal/secret.ts",
  ]);
  const pkg = parsePackageJsonFacts("shared/package.json", JSON.stringify({
    name: "@acme/shared",
    main: "dist/index.js",
    exports: { ".": "./dist/index.js", "./format/*": "./dist/format/*.js" },
    imports: { "#internal/*": "./src/internal/*.ts" },
  }))!;
  const index = buildWorkspacePackageIndex([pkg]);

  it("resolves a bare import of a workspace package to its source entry", () => {
    const hits = workspacePackageCandidates("web/src/app.ts", "@acme/shared", index);
    expect(hits).toContain("shared/src/index");
  });

  it("resolves through the full resolver, across folders (multi-root style ids)", () => {
    const ctx = { workspacePackages: index };
    expect(resolveSpecifier("web/src/app.ts", "@acme/shared", files, ctx)).toBe("shared/src/index.ts");
    expect(resolveSpecifier("web/src/app.ts", "@acme/shared/format/date", files, ctx)).toBe("shared/src/format/date.ts");
  });

  it("resolves # subpath imports within the owning package only", () => {
    const ctx = { workspacePackages: index };
    expect(resolveSpecifier("shared/src/index.ts", "#internal/secret", files, ctx)).toBe("shared/src/internal/secret.ts");
    expect(resolveSpecifier("web/src/app.ts", "#internal/secret", files, ctx)).toBeNull();
  });

  it("never resolves a registry package the workspace does not declare", () => {
    expect(resolveSpecifier("web/src/app.ts", "react", files, { workspacePackages: index })).toBeNull();
  });
});

describe("Rust sibling crates", () => {
  it("resolves `use other_crate::module` to the sibling crate's module file", () => {
    const crate = parseCargoFacts("crates/shared-types/Cargo.toml", "[package]\nname = \"shared-types\"\nversion = \"0.1.0\"\n")!;
    expect(crate.name).toBe("shared-types");
    const rustCrates = buildRustCrateIndex([crate]);
    expect(rustCrates.get("shared_types")).toBe("crates/shared-types/src");
    const files = new Set(["crates/app/src/main.rs", "crates/shared-types/src/lib.rs", "crates/shared-types/src/model.rs"]);
    expect(resolveSpecifier("crates/app/src/main.rs", "use:shared_types::model::User", files, { rustCrates }))
      .toBe("crates/shared-types/src/model.rs");
    expect(resolveSpecifier("crates/app/src/main.rs", "use:serde::Serialize", files, { rustCrates })).toBeNull();
  });
});

describe("Python source roots and multi-root absolute modules", () => {
  it("reads setuptools `where` and resolves absolute modules under it", () => {
    const facts = parsePythonProjectFacts("svc/pyproject.toml", "[tool.setuptools.packages.find]\nwhere = [\"lib\"]\n");
    const roots = buildPythonSourceRoots([facts]);
    expect(roots).toContain("svc/lib");
    const files = new Set(["svc/lib/billing/core.py", "svc/app.py", "other/billing/core.py"]);
    expect(resolveSpecifier("svc/app.py", "billing.core", files, { pythonSourceRoots: roots })).toBe("svc/lib/billing/core.py");
  });

  it("prefers the importing file's own workspace folder in a multi-root workspace", () => {
    const files = new Set(["api/models/user.py", "api/main.py", "worker/models/user.py"]);
    expect(resolveSpecifier("api/main.py", "models.user", files, { rootNames: ["api", "worker"] })).toBe("api/models/user.py");
    expect(resolveSpecifier("worker/main.py", "models.user", files, { rootNames: ["api", "worker"] })).toBe("worker/models/user.py");
  });

  it("resolves web-root-absolute JSON references inside the importing folder", () => {
    const files = new Set(["site/manifest.json", "site/icons/icon.png", "docs/icons/icon.png"]);
    expect(resolveSpecifier("site/manifest.json", "/icons/icon.png", files, { rootNames: ["site", "docs"] })).toBe("site/icons/icon.png");
  });
});

describe("resolve context from facts", () => {
  it("builds workspace packages, crates, and aliases from per-file facts", () => {
    const facts = new Map<string, FileFacts>([
      ["shared/package.json", extractFileFacts("shared/package.json", JSON.stringify({ name: "@acme/shared" }), 1, 10)],
      ["web/tsconfig.json", extractFileFacts("web/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }), 1, 10)],
      ["web/src/a.ts", extractFileFacts("web/src/a.ts", "import x from '@acme/shared';\nimport y from '@web/b';\n", 1, 10)],
      ["web/src/b.ts", extractFileFacts("web/src/b.ts", "export const y = 1;\n", 1, 10)],
      ["shared/src/index.ts", extractFileFacts("shared/src/index.ts", "export const x = 1;\n", 1, 10)],
    ]);
    const fileSet = new Set(facts.keys());
    const ctx = buildResolveContextFromFacts(facts, fileSet);
    expect(ctx.workspacePackages?.byName.has("@acme/shared")).toBe(true);
    expect(resolveSpecifier("web/src/a.ts", "@acme/shared", fileSet, ctx)).toBe("shared/src/index.ts");
    expect(resolveSpecifier("web/src/a.ts", "@web/b", fileSet, ctx)).toBe("web/src/b.ts");
  });
});
