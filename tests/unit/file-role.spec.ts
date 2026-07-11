import { describe, expect, it } from "vitest";
import { dominantZoneRole, fileRole, roleCounts } from "../../src/webview/react/lib/graph/file-role.js";
import { DEFAULT_FILTER, graphNodeRadius, visibleNodeIds } from "../../src/webview/react/lib/graph/view-model.js";
import type { GraphNode } from "../../src/webview/react/lib/graph/protocol.js";

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
    expect(fileRole("tests/fixtures/users.json")).toBe("data");
  });

  it("payload JSON reads as data, not config", () => {
    expect(fileRole("src/meta.json")).toBe("data");
    expect(fileRole("app/data.json")).toBe("data");
    expect(fileRole("src/graph/metadata.yaml")).toBe("data");
    expect(fileRole("src/models/weights.meta.json")).toBe("data");
    expect(fileRole("src/api/users.fixture.json")).toBe("data");
    expect(fileRole("locales/en.json")).toBe("data");
    expect(fileRole("db/seeds/accounts.json")).toBe("data");
    expect(fileRole("assets/i18n/de.json")).toBe("data");
  });

  it("known manifests stay config even in data-ish homes", () => {
    expect(fileRole("data/package.json")).toBe("config");
    expect(fileRole("locales/tsconfig.json")).toBe("config");
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

function fileNode(id: string): GraphNode {
  return { id, dir: id.split("/")[0] ?? "", lang: "ts", sizeBytes: 100, inDegree: 1, outDegree: 1, x: 0, y: 0, z: 1 };
}

describe("role filter", () => {
  const nodes: GraphNode[] = [
    fileNode("src/store.ts"),
    fileNode("src/store.spec.ts"),
    fileNode("src/settings.json"),
    { ...fileNode("▤src"), kind: "cluster" },
  ];

  it("ghosts files outside the active roles while aggregates pass", () => {
    const ids = visibleNodeIds(nodes, [], [], { ...DEFAULT_FILTER, roles: ["test"] }, null);
    expect(ids).not.toBeNull();
    expect(ids!.has("src/store.spec.ts")).toBe(true);
    expect(ids!.has("src/store.ts")).toBe(false);
    expect(ids!.has("src/settings.json")).toBe(false);
    expect(ids!.has("▤src")).toBe(true); // cluster super-nodes aggregate mixed roles
  });

  it("is inactive when roles is empty (fast-path null)", () => {
    expect(visibleNodeIds(nodes, [], [], { ...DEFAULT_FILTER }, null)).toBeNull();
  });

  it("roleCounts orders roles by frequency", () => {
    const counts = roleCounts(["a/x.spec.ts", "a/y.spec.ts", "a/z.ts"]);
    expect(counts[0]).toEqual({ role: "test", count: 2 });
    expect(counts[1]).toEqual({ role: "source", count: 1 });
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
