import { describe, expect, it } from "vitest";
import { activityIntent, activityToTraces } from "../../src/graph/trace-extract.js";

describe("activityToTraces", () => {
  it("maps file tools to their kinds", () => {
    expect(activityToTraces("file_read", { path: "src/a.ts" })).toEqual([{ path: "src/a.ts", kind: "read" }]);
    expect(activityToTraces("file_write", { path: "src\\b.ts" })).toEqual([{ path: "src/b.ts", kind: "write" }]);
    expect(activityToTraces("file_delete", { path: "src/c.ts" })).toEqual([{ path: "src/c.ts", kind: "write" }]);
    expect(activityToTraces("file_edit", { path: "src/d.ts", oldString: "x" })).toEqual([{ path: "src/d.ts", kind: "edit" }]);
    expect(activityToTraces("json_edit", { path: "package.json", operations: [] })).toEqual([{ path: "package.json", kind: "edit" }]);
    // code_insert/code_replace address their file via target.path, never a top-level path.
    expect(activityToTraces("code_insert", { target: { path: "src/e.ts" }, position: "after", text: "x" }))
      .toEqual([{ path: "src/e.ts", kind: "edit" }]);
    expect(activityToTraces("code_replace", { target: { path: "src/f.ts", symbol: "foo" }, text: "x" }))
      .toEqual([{ path: "src/f.ts", kind: "edit" }]);
  });

  it("fans out file_edit_batch to every edit path", () => {
    const traces = activityToTraces("file_edit_batch", {
      edits: [{ path: "a.ts" }, { path: "b.ts" }, { bad: true }, null],
    });
    expect(traces).toEqual([
      { path: "a.ts", kind: "edit" },
      { path: "b.ts", kind: "edit" },
    ]);
  });

  it("fans out code_replace_batch to every edit's target.path", () => {
    const traces = activityToTraces("code_replace_batch", {
      edits: [{ target: { path: "a.ts", symbol: "foo" }, text: "x" }, { target: { path: "b.ts" }, text: "y" }, { bad: true }, null],
    });
    expect(traces).toEqual([
      { path: "a.ts", kind: "edit" },
      { path: "b.ts", kind: "edit" },
    ]);
  });

  /* A rename is the file op with the most structural meaning on the map, and it was the
     one the map never lit up for — both ends matter, so the node leaving and the node
     arriving are traced. */
  it("traces both ends of a move or copy", () => {
    expect(activityToTraces("file_move", { source: "src/a.ts", destination: "src/b.ts" })).toEqual([
      { path: "src/a.ts", kind: "write" },
      { path: "src/b.ts", kind: "write" },
    ]);
    expect(activityToTraces("file_copy", { source: "src/a.ts", destination: "src/c.ts" })).toEqual([
      { path: "src/a.ts", kind: "write" },
      { path: "src/c.ts", kind: "write" },
    ]);
    expect(activityToTraces("file_mkdir", { path: "src/new" })).toEqual([{ path: "src/new", kind: "write" }]);
  });

  it("maps shell/git tools to shell traces on cwd/path", () => {
    expect(activityToTraces("shell_run", { command: "npm", cwd: "apps/x" })).toEqual([{ path: "apps/x", kind: "shell" }]);
    expect(activityToTraces("process_start", { cwd: "apps/y" })).toEqual([{ path: "apps/y", kind: "shell" }]);
    expect(activityToTraces("git_op", { op: "status", cwd: "repo" })).toEqual([{ path: "repo", kind: "shell" }]);
  });

  it("maps code-intel tools to nav traces", () => {
    expect(activityToTraces("code_navigate", { kind: "definition", target: { path: "src/a.ts" } }))
      .toEqual([{ path: "src/a.ts", kind: "nav" }]);
    expect(activityToTraces("code_symbols", { path: "src/b.ts" })).toEqual([{ path: "src/b.ts", kind: "nav" }]);
    expect(activityToTraces("code_format", { path: "src/c.ts" })).toEqual([{ path: "src/c.ts", kind: "nav" }]);
    expect(activityToTraces("code_hierarchy", { kind: "supertypes", target: { path: "src/d.ts" } }))
      .toEqual([{ path: "src/d.ts", kind: "nav" }]);
    expect(activityToTraces("code_inlay_hints", { path: "src/e.ts" })).toEqual([{ path: "src/e.ts", kind: "nav" }]);
  });

  it("returns nothing for unknown tools, missing paths, or bad input", () => {
    expect(activityToTraces("plan_create", { title: "x" })).toEqual([]);
    expect(activityToTraces("file_read", {})).toEqual([]);
    expect(activityToTraces("file_read", undefined)).toEqual([]);
    expect(activityToTraces("code_navigate", { kind: "definition", target: { symbol: "Foo" } })).toEqual([]);
  });
});

describe("activityIntent", () => {
  it("surfaces the shell command (binary + first args)", () => {
    expect(activityIntent("shell_run", { command: "npm", args: ["run", "test", "ignored"] })).toBe("npm run test");
    expect(activityIntent("process_start", { command: "vite", args: ["--watch"] })).toBe("vite --watch");
  });

  it("surfaces the git op", () => {
    expect(activityIntent("git_op", { op: "commit", cwd: "repo" })).toBe("commit");
    expect(activityIntent("git_op", { branch: "main" })).toBe("main");
  });

  it("names the destination of a move, which the source path alone doesn't convey", () => {
    expect(activityIntent("file_move", { source: "src/a.ts", destination: "src/graph/b.ts" })).toBe("b.ts");
    expect(activityIntent("file_copy", { source: "src/a.ts", destination: "src/c.ts" })).toBe("c.ts");
  });

  it("summarizes a batch edit by file count", () => {
    expect(activityIntent("file_edit_batch", { edits: [{ path: "a" }, { path: "b" }, { path: "c" }] })).toBe("3 files");
  });

  it("surfaces a code-nav symbol or kind", () => {
    expect(activityIntent("code_navigate", { kind: "references", target: { symbol: "Foo" } })).toBe("Foo");
    expect(activityIntent("code_navigate", { kind: "definition", target: { path: "a.ts" } })).toBe("definition");
  });

  it("returns empty when the file name already says enough, or input is bad", () => {
    expect(activityIntent("file_read", { path: "src/a.ts" })).toBe("");
    expect(activityIntent("file_edit", { path: "src/a.ts" })).toBe("");
    expect(activityIntent("shell_run", undefined)).toBe("");
  });
});
