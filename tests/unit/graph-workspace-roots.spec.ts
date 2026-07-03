import { describe, expect, it } from "vitest";
import { buildWorkspaceRoots, fromNodeId, toNodeId, type WorkspaceRoot } from "../../src/graph/workspace-roots.js";

describe("buildWorkspaceRoots", () => {
  it("normalizes slashes and trailing separators", () => {
    const roots = buildWorkspaceRoots([{ name: "app", path: "C:\\ws\\app\\" }]);
    expect(roots).toEqual([{ name: "app", path: "C:/ws/app" }]);
  });

  it("de-duplicates colliding folder names", () => {
    const roots = buildWorkspaceRoots([
      { name: "app", path: "/a/app" },
      { name: "app", path: "/b/app" },
    ]);
    expect(roots.map((r) => r.name)).toEqual(["app", "app-2"]);
  });
});

describe("toNodeId / fromNodeId — single root", () => {
  const roots: WorkspaceRoot[] = [{ name: "app", path: "/ws/app" }];

  it("produces a bare relative id (no folder prefix) with one root", () => {
    expect(toNodeId(roots, "/ws/app/src/foo.ts")).toBe("src/foo.ts");
  });

  it("round-trips back to the absolute path", () => {
    expect(fromNodeId(roots, "src/foo.ts")).toBe("/ws/app/src/foo.ts");
  });

  it("returns null for a path outside the root", () => {
    expect(toNodeId(roots, "/elsewhere/foo.ts")).toBeNull();
  });

  it("rejects a transversal escape past the root", () => {
    expect(fromNodeId(roots, "../../etc/passwd")).toBeNull();
  });

  it("matches case-insensitively (Windows-safe)", () => {
    expect(toNodeId(roots, "/WS/APP/src/Foo.ts")).toBe("src/Foo.ts");
  });
});

describe("toNodeId / fromNodeId — multi root", () => {
  const roots: WorkspaceRoot[] = [
    { name: "app-one", path: "/ws/one" },
    { name: "app-two", path: "/ws/two" },
  ];

  it("folder-qualifies ids so files from different roots never collide", () => {
    expect(toNodeId(roots, "/ws/one/src/foo.ts")).toBe("app-one/src/foo.ts");
    expect(toNodeId(roots, "/ws/two/src/foo.ts")).toBe("app-two/src/foo.ts");
  });

  it("round-trips a folder-qualified id back to the right root's absolute path", () => {
    expect(fromNodeId(roots, "app-two/src/foo.ts")).toBe("/ws/two/src/foo.ts");
  });

  it("returns null for an unknown folder prefix", () => {
    expect(fromNodeId(roots, "nope/src/foo.ts")).toBeNull();
  });

  it("returns null for an id with no folder segment", () => {
    expect(fromNodeId(roots, "foo.ts")).toBeNull();
  });

  it("rejects a traversal escape past a specific root", () => {
    expect(fromNodeId(roots, "app-one/../../../etc/passwd")).toBeNull();
  });

  it("returns null for a path outside every root", () => {
    expect(toNodeId(roots, "/elsewhere/foo.ts")).toBeNull();
  });
});
