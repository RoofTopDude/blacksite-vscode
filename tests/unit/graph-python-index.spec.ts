import { describe, expect, it } from "vitest";
import { buildPythonNameIndex, extractPythonTopLevelNames } from "../../src/graph/python-index.js";

describe("extractPythonTopLevelNames", () => {
  it("extracts module-level def and class names", () => {
    const content = `
import os

class UserRecord:
    def load(self):
        pass

def create_user():
    pass

async def fetch_user():
    pass
`;
    expect(extractPythonTopLevelNames(content).sort()).toEqual(["UserRecord", "create_user", "fetch_user"]);
  });

  it("excludes nested/indented definitions (methods, closures)", () => {
    const content = `
def outer():
    def inner():
        pass
    return inner

class Foo:
    def method(self):
        pass
`;
    expect(extractPythonTopLevelNames(content).sort()).toEqual(["Foo", "outer"]);
  });

  it("returns an empty list for a file with no top-level definitions", () => {
    expect(extractPythonTopLevelNames("x = 1\nif x:\n    pass\n")).toEqual([]);
  });
});

describe("buildPythonNameIndex", () => {
  it("indexes only .py files, keyed by normalized path", () => {
    const index = buildPythonNameIndex([
      { path: "app/models/schemas.py", content: "class UserRecord:\n    pass\n" },
      { path: "app/README.md", content: "class NotPython:\n    pass\n" },
    ]);
    expect(index.get("app/models/schemas.py")).toEqual(new Set(["UserRecord"]));
    expect(index.has("app/README.md")).toBe(false);
  });
});
