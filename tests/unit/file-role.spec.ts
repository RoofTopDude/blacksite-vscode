import { describe, expect, it } from "vitest";
import { dominantZoneRole, fileRole } from "../../src/webview/react/lib/graph/file-role.js";
import { graphNodeRadius } from "../../src/webview/react/lib/graph/view-model.js";

describe("fileRole", () => {
  it("classifies test files by name marker and by directory", () => {
    expect(fileRole("src/lib/chat-model.spec.ts")).toBe("test");
    expect(fileRole("src/lib/chat-model.test.tsx")).toBe("test");
    expect(fileRole("pkg/server/main_test.go")).toBe("test");
    expect(fileRole("tests/unit/tool-icons.spec.ts")).toBe("test");
    expect(fileRole("src/__tests__/helpers.ts")).toBe("test");
    expect(fileRole("app/test_models.py")).toBe("test");
  });

  it("test markers beat every other signal", () => {
    expect(fileRole("src/foo.config.spec.ts")).toBe("test");
    expect(fileRole("tests/index.ts")).toBe("test");
  });

  it("data fixtures inside test dirs stay data", () => {
    expect(fileRole("tests/fixtures/users.csv")).toBe("data");
  });

  it("classifies declarations and type modules", () => {
    expect(fileRole("src/global.d.ts")).toBe("types");
    expect(fileRole("src/lib/types.ts")).toBe("types");
    expect(fileRole("src/types/protocol.ts")).toBe("types");
    expect(fileRole("index.d.ts")).toBe("types"); // declarations beat entry naming
  });

  it("classifies config by rc/manifest/dir/extension", () => {
    expect(fileRole(".eslintrc")).toBe("config");
    expect(fileRole(".prettierrc.json")).toBe("config");
    expect(fileRole("vite.config.mjs")).toBe("config");
    expect(fileRole("package.json")).toBe("config");
    expect(fileRole("apps/web/tsconfig.build.json")).toBe("config");
    expect(fileRole(".vscode/settings.json")).toBe("config");
    expect(fileRole("deploy/values.yaml")).toBe("config");
    expect(fileRole("Dockerfile")).toBe("config");
  });

  it("classifies docs, styles, data, and assets", () => {
    expect(fileRole("README.md")).toBe("docs");
    expect(fileRole("docs/setup/install.html")).toBe("docs");
    expect(fileRole("src/webview/react/theme.css")).toBe("styles");
    expect(fileRole("db/migrations/001-init.sql")).toBe("data");
    expect(fileRole("public/logo.svg")).toBe("assets");
  });

  it("classifies entry/barrel modules, leaving other code as source", () => {
    expect(fileRole("src/index.ts")).toBe("entry");
    expect(fileRole("src/main.py")).toBe("entry");
    expect(fileRole("src/extension.ts")).toBe("entry");
    expect(fileRole("src/agent-session.ts")).toBe("source");
    expect(fileRole("src/lib/store.ts")).toBe("source");
  });
});

describe("dominantZoneRole", () => {
  it("names a clear non-source majority", () => {
    expect(dominantZoneRole([
      "tests/a.spec.ts", "tests/b.spec.ts", "tests/c.spec.ts", "tests/helper.ts",
    ])).toBe("test");
  });

  it("returns null for mixed or source-dominated groups", () => {
    expect(dominantZoneRole(["src/a.ts", "src/b.ts", "src/a.spec.ts"])).toBeNull();
    expect(dominantZoneRole([])).toBeNull();
  });
});

describe("graphNodeRadius with sizeBytes", () => {
  const base = { inDegree: 4, outDegree: 4 };

  it("larger files render larger at equal connectivity", () => {
    const small = graphNodeRadius({ ...base, sizeBytes: 1024 });
    const large = graphNodeRadius({ ...base, sizeBytes: 200 * 1024 });
    expect(large).toBeGreaterThan(small);
  });

  it("size contribution is capped so bulk never outshouts connectivity", () => {
    const monster = graphNodeRadius({ ...base, sizeBytes: 50 * 1024 * 1024 });
    const plain = graphNodeRadius(base);
    expect(monster - plain).toBeLessThanOrEqual(3.5);
  });

  it("degree-only signature still works and aggregates ignore size", () => {
    const cluster = graphNodeRadius({ inDegree: 4, outDegree: 4, sizeBytes: 10 * 1024 * 1024, kind: "cluster" });
    expect(cluster).toBe(graphNodeRadius(base));
  });
});
