import { describe, expect, it } from "vitest";
import { normalizeAbsPath, parseGitLog } from "../../src/graph/git-log.js";

describe("parseGitLog", () => {
  it("aggregates churn and keeps the most recent commit time per file", () => {
    const stdout = [
      "commit:1000",
      "",
      "src/a.ts",
      "src/b.ts",
      "",
      "commit:900",
      "",
      "src/a.ts",
      "",
    ].join("\n");
    const stats = parseGitLog(stdout);
    expect(stats.get("src/a.ts")).toEqual({ churn: 2, lastAt: 1000 });
    expect(stats.get("src/b.ts")).toEqual({ churn: 1, lastAt: 1000 });
  });

  it("takes the max commit time even when commits arrive out of order", () => {
    const stdout = ["commit:500", "x.ts", "commit:800", "x.ts", "commit:700", "x.ts"].join("\n");
    expect(parseGitLog(stdout).get("x.ts")).toEqual({ churn: 3, lastAt: 800 });
  });

  it("ignores file lines before the first commit marker and tolerates CRLF", () => {
    const stdout = ["stray.ts", "commit:1000\r", "kept.ts\r", ""].join("\n");
    const stats = parseGitLog(stdout);
    expect(stats.has("stray.ts")).toBe(false);
    expect(stats.get("kept.ts")).toEqual({ churn: 1, lastAt: 1000 });
  });

  it("returns an empty map for empty output", () => {
    expect(parseGitLog("").size).toBe(0);
  });
});

describe("normalizeAbsPath", () => {
  it("converts backslashes to forward slashes (and lowercases on win32)", () => {
    const expected = process.platform === "win32" ? "c:/a/b.ts" : "C:/A/b.ts";
    expect(normalizeAbsPath("C:\\A\\b.ts")).toBe(expected);
  });
});
