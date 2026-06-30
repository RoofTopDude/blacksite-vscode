import { describe, expect, it } from "vitest";
import { isWithinWorkspace, resolveWorkspacePath } from "../../src/workspace-paths.js";

describe("resolveWorkspacePath", () => {
  const root = "C:/repo";

  it("resolves a relative path inside the workspace root", () => {
    expect(resolveWorkspacePath("src/file.ts", [root])).toBe("C:\\repo\\src\\file.ts");
  });

  it("rejects a relative path that escapes the workspace root", () => {
    expect(resolveWorkspacePath("../secret.txt", [root])).toBeNull();
  });

  it("accepts an absolute path inside any workspace root", () => {
    expect(resolveWorkspacePath("C:/repo/src/file.ts", [root, "D:/other"])).toBe("C:\\repo\\src\\file.ts");
  });

  it("rejects an absolute path outside the workspace roots", () => {
    expect(resolveWorkspacePath("C:/outside/file.ts", [root])).toBeNull();
  });
});

describe("isWithinWorkspace", () => {
  it("treats the workspace root itself as in-bounds", () => {
    expect(isWithinWorkspace("C:/repo", ["C:/repo"])).toBe(true);
  });

  it("rejects sibling paths", () => {
    expect(isWithinWorkspace("C:/repo-other/file.ts", ["C:/repo"])).toBe(false);
  });
});
