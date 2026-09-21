import { describe, expect, it } from "vitest";
import {
  diffTargetPaths,
  isDiffableText,
  lineDiffStats,
  summarizeSnapshotPair,
} from "../../src/edit-diff-stats.js";

describe("lineDiffStats", () => {
  it("reports nothing for identical text", () => {
    expect(lineDiffStats("a\nb\n", "a\nb\n")).toEqual({ additions: 0, deletions: 0, firstChangedLine: 0 });
  });

  it("counts a one-line replacement and points at it", () => {
    const stats = lineDiffStats("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(stats).toEqual({ additions: 1, deletions: 1, firstChangedLine: 2 });
  });

  it("counts a pure insertion with no deletions", () => {
    const stats = lineDiffStats("one\ntwo\n", "one\ninserted\ntwo\n");
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(0);
    expect(stats.firstChangedLine).toBe(2);
  });

  it("counts a pure deletion with no additions", () => {
    const stats = lineDiffStats("one\ngone\ntwo\n", "one\ntwo\n");
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(1);
    expect(stats.firstChangedLine).toBe(2);
  });

  it("ignores line-ending convention so a CRLF file is not reported as wholly rewritten", () => {
    expect(lineDiffStats("a\r\nb\r\n", "a\nb\n")).toEqual({ additions: 0, deletions: 0, firstChangedLine: 0 });
  });

  it("points at the first change when a file is edited in several places", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n");
    const after = ["a", "B", "c", "D", "e"].join("\n");
    expect(lineDiffStats(before, after).firstChangedLine).toBe(2);
  });

  it("keeps the reported line inside a file that lost its tail", () => {
    const stats = lineDiffStats("a\nb\nc\n", "a\n");
    expect(stats.firstChangedLine).toBeGreaterThan(0);
    // "a\n" splits to ["a", ""] — two lines — so the pointer must not exceed 2.
    expect(stats.firstChangedLine).toBeLessThanOrEqual(2);
  });
});

describe("diffTargetPaths", () => {
  it("names the file a surgical edit is about to change", () => {
    expect(diffTargetPaths("file_edit", { path: "src/a.ts", oldString: "x", newString: "y" })).toEqual(["src/a.ts"]);
  });

  it("names every file of a batch, deduplicated", () => {
    const paths = diffTargetPaths("file_edit_batch", {
      edits: [
        { path: "src/a.ts", oldString: "1", newString: "2" },
        { path: "src/b.ts", oldString: "1", newString: "2" },
        { path: "src/a.ts", oldString: "3", newString: "4" },
      ],
    });
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names both ends of a move, since the pair is the change", () => {
    expect(diffTargetPaths("file_move", { source: "src/a.ts", destination: "src/b.ts" }))
      .toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("covers whole-file writes and deletes", () => {
    expect(diffTargetPaths("file_write", { path: "src/new.ts", content: "x" })).toEqual(["src/new.ts"]);
    expect(diffTargetPaths("file_delete", { path: "src/old.ts" })).toEqual(["src/old.ts"]);
  });

  it("reads a symbol-targeted edit's path out of target.path", () => {
    expect(diffTargetPaths("code_replace", { target: { path: "src/a.ts", symbol: "foo" } })).toEqual(["src/a.ts"]);
  });

  it("returns nothing for reads, shells, and navigation — no snapshot is worth taking", () => {
    expect(diffTargetPaths("file_read", { path: "src/a.ts" })).toEqual([]);
    expect(diffTargetPaths("shell_run", { command: "npm", cwd: "." })).toEqual([]);
    expect(diffTargetPaths("code_navigate", { target: { path: "src/a.ts" } })).toEqual([]);
    expect(diffTargetPaths("file_edit", undefined)).toEqual([]);
  });
});

describe("isDiffableText", () => {
  it("accepts source text", () => {
    expect(isDiffableText("const a = 1;\n")).toBe(true);
  });

  it("rejects content with a NUL byte, which no text diff can render", () => {
    expect(isDiffableText(`png${String.fromCharCode(0)}data`)).toBe(false);
  });
});

describe("summarizeSnapshotPair", () => {
  it("reports a creation when there was no file before", () => {
    expect(summarizeSnapshotPair("src/new.ts", null, "a\nb")).toEqual({
      path: "src/new.ts", additions: 2, deletions: 0, kind: "created", line: 0,
    });
  });

  it("reports a deletion when the file is gone after", () => {
    expect(summarizeSnapshotPair("src/old.ts", "a\nb", null)).toEqual({
      path: "src/old.ts", additions: 0, deletions: 2, kind: "deleted", line: 0,
    });
  });

  it("reports a modification with a line to jump to", () => {
    expect(summarizeSnapshotPair("src/a.ts", "one\ntwo", "one\nTWO")).toEqual({
      path: "src/a.ts", additions: 1, deletions: 1, kind: "modified", line: 2,
    });
  });

  it("reports nothing when the bytes did not change — a rejected or failed edit", () => {
    expect(summarizeSnapshotPair("src/a.ts", "same", "same")).toBeNull();
  });

  it("reports nothing for a file that never existed on either side", () => {
    expect(summarizeSnapshotPair("src/ghost.ts", null, null)).toBeNull();
  });
});
