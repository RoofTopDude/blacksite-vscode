import { describe, expect, it } from "vitest";
import {
  readStr,
  readNum,
  shortText,
  shortPath,
  formatBytes,
  formatDuration,
  formatTokenCount,
  countLabel,
  joinParts,
  diffLineStats,
  toolDisplayName,
  stopReasonLabel,
  toolChangePresentation,
  humanizeWord,
  diagSuffix,
  hostLabel,
  formatClock,
  countLines,
  liveElapsedMs,
  iterationProgressLabel,
} from "../../src/webview/react/lib/format.js";

describe("readStr", () => {
  it("returns trimmed string for string input", () => {
    expect(readStr("  hello  ")).toBe("hello");
    expect(readStr("")).toBe("");
  });
  it("returns empty string for non-string input", () => {
    expect(readStr(null)).toBe("");
    expect(readStr(undefined)).toBe("");
    expect(readStr(42)).toBe("");
    expect(readStr({})).toBe("");
  });
});

describe("readNum", () => {
  it("returns number for finite numeric input", () => {
    expect(readNum(0)).toBe(0);
    expect(readNum(42)).toBe(42);
    expect(readNum(-1.5)).toBe(-1.5);
  });
  it("returns null for non-finite or non-numeric input", () => {
    expect(readNum(NaN)).toBeNull();
    expect(readNum(Infinity)).toBeNull();
    expect(readNum("abc")).toBeNull();
  });
  it("coerces null/undefined to 0 (Number coercion)", () => {
    // Number(null) === 0 and Number(undefined) === NaN
    expect(readNum(null)).toBe(0);
    expect(readNum(undefined)).toBeNull();
  });
  it("coerces numeric strings", () => {
    expect(readNum("42")).toBe(42);
    expect(readNum("3.14")).toBe(3.14);
  });
});

describe("shortText", () => {
  it("returns text as-is when within max", () => {
    expect(shortText("hello", 10)).toBe("hello");
  });
  it("truncates with ellipsis when over max", () => {
    const result = shortText("abcdefghij", 5);
    expect(result).toHaveLength(5);
    expect(result.endsWith("…")).toBe(true);
  });
  it("collapses whitespace", () => {
    expect(shortText("a  b\tc")).toBe("a b c");
  });
  it("returns empty for empty/null input", () => {
    expect(shortText("")).toBe("");
    expect(shortText(null)).toBe("");
  });
});

describe("shortPath", () => {
  it("returns path unchanged when within max", () => {
    expect(shortPath("src/foo.ts", 60)).toBe("src/foo.ts");
  });
  it("normalizes backslashes", () => {
    expect(shortPath("src\\foo.ts", 60)).toBe("src/foo.ts");
  });
  it("abbreviates long paths with ellipsis prefix", () => {
    const long = "a/b/c/d/e/f/g/very-long-filename.ts";
    const result = shortPath(long, 20);
    expect(result.startsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });
  it("returns empty for empty input", () => {
    expect(shortPath("")).toBe("");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(10240)).toBe("10 KB");
  });
  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });
  it("returns empty for zero or negative", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(null)).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(0)).toBe("0ms");
  });
  it("formats seconds", () => {
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(10000)).toBe("10s");
  });
  it("formats minutes and seconds", () => {
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(3600000)).toBe("60m 0s");
  });
  it("returns empty for non-numeric (NaN/Infinity/string)", () => {
    expect(formatDuration(NaN)).toBe("");
    expect(formatDuration(Infinity)).toBe("");
    expect(formatDuration("abc")).toBe("");
  });
});

describe("liveElapsedMs", () => {
  it("returns null when there is no start time", () => {
    expect(liveElapsedMs(null, null, 1000)).toBeNull();
    expect(liveElapsedMs(undefined, null, 1000)).toBeNull();
  });
  it("measures against now while still running (endedAt unset)", () => {
    expect(liveElapsedMs(1000, null, 1500)).toBe(500);
    expect(liveElapsedMs(1000, null, 4000)).toBe(3000);
  });
  it("ticks upward as `now` advances — this is what makes a running duration live", () => {
    const a = liveElapsedMs(1000, null, 2000);
    const b = liveElapsedMs(1000, null, 3000);
    expect(b).toBeGreaterThan(a!);
  });
  it("freezes at the recorded span once endedAt is set, ignoring further `now` growth", () => {
    expect(liveElapsedMs(1000, 2500, 2500)).toBe(1500);
    expect(liveElapsedMs(1000, 2500, 999999)).toBe(1500);
  });
  it("never returns a negative duration", () => {
    expect(liveElapsedMs(5000, null, 1000)).toBe(0);
  });
});

describe("iterationProgressLabel", () => {
  it("returns empty when there are no iterations yet", () => {
    expect(iterationProgressLabel(0, 40)).toBe("");
    expect(iterationProgressLabel(-1, 40)).toBe("");
  });
  it("formats against a known max", () => {
    expect(iterationProgressLabel(3, 40)).toBe("iteration 3 of 40");
    expect(iterationProgressLabel(1, 1)).toBe("iteration 1 of 1");
  });
  it("falls back to a plain count label when max is unknown", () => {
    expect(iterationProgressLabel(3, undefined)).toBe("3 iterations");
    expect(iterationProgressLabel(1, 0)).toBe("1 iteration");
  });
});

describe("formatTokenCount", () => {
  it("formats small counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });
  it("formats thousands", () => {
    expect(formatTokenCount(1000)).toBe("1K");
    expect(formatTokenCount(4500)).toBe("4.5K");
    expect(formatTokenCount(100000)).toBe("100K");
  });
  it("formats millions", () => {
    expect(formatTokenCount(1000000)).toBe("1M");
    expect(formatTokenCount(2500000)).toBe("2.5M");
  });
  it("returns 0 for falsy", () => {
    expect(formatTokenCount(null)).toBe("0");
    expect(formatTokenCount(0)).toBe("0");
  });
});

describe("countLabel", () => {
  it("uses singular for count of 1", () => {
    expect(countLabel(1, "file")).toBe("1 file");
  });
  it("uses plural (auto) for count != 1", () => {
    expect(countLabel(0, "file")).toBe("0 files");
    expect(countLabel(2, "file")).toBe("2 files");
  });
  it("uses custom plural when provided", () => {
    expect(countLabel(2, "match", "matches")).toBe("2 matches");
  });
});

describe("joinParts", () => {
  it("joins non-empty parts with ·", () => {
    expect(joinParts(["a", "b", "c"])).toBe("a · b · c");
  });
  it("filters out falsy values", () => {
    expect(joinParts(["a", "", null, undefined, false, "b"])).toBe("a · b");
  });
  it("returns empty string for all falsy", () => {
    expect(joinParts([null, undefined, false, ""])).toBe("");
  });
});

describe("countLines", () => {
  it("counts lines correctly", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("single")).toBe(1);
    expect(countLines("")).toBe(0);
  });
  it("handles CRLF", () => {
    expect(countLines("a\r\nb\r\nc")).toBe(3);
  });
});

describe("diffLineStats", () => {
  it("returns zero for identical content", () => {
    const stats = diffLineStats("a\nb\nc", "a\nb\nc");
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(0);
  });
  it("detects pure additions", () => {
    const stats = diffLineStats("a\nb", "a\nb\nc");
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(0);
  });
  it("detects pure deletions", () => {
    const stats = diffLineStats("a\nb\nc", "a\nb");
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(1);
  });
  it("detects mixed changes", () => {
    const stats = diffLineStats("a\nb\nc", "a\nx\nc");
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(1);
  });
  it("handles empty before string (treated as 1 empty line)", () => {
    // "".split("\n") === [""] — one empty line, so going to "a\nb" is +2 adds -1 delete
    const stats = diffLineStats("", "a\nb");
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });
});

describe("humanizeWord", () => {
  it("capitalizes normal words", () => {
    expect(humanizeWord("hello")).toBe("Hello");
  });
  it("maps known abbreviations", () => {
    expect(humanizeWord("mcp")).toBe("MCP");
    expect(humanizeWord("api")).toBe("API");
    expect(humanizeWord("github")).toBe("GitHub");
    expect(humanizeWord("git")).toBe("Git");
  });
  it("returns empty for empty input", () => {
    expect(humanizeWord("")).toBe("");
  });
});

describe("toolDisplayName", () => {
  it("returns label for known tool", () => {
    expect(toolDisplayName("shell_run")).toBe("Shell Command");
    expect(toolDisplayName("file_read")).toBe("Read File");
  });
  it("humanizes unknown tool names from underscores", () => {
    expect(toolDisplayName("some_custom_tool")).toBe("Some Custom Tool");
  });
  it("falls back to Tool for empty", () => {
    expect(toolDisplayName("")).toBe("Tool");
  });
});

describe("stopReasonLabel", () => {
  it("maps known stop reasons", () => {
    expect(stopReasonLabel("stop")).toBe("complete");
    expect(stopReasonLabel("end_turn")).toBe("complete");
    expect(stopReasonLabel("max_tokens")).toBe("max tokens");
    expect(stopReasonLabel("max_iterations")).toBe("max iterations");
    expect(stopReasonLabel("tool_use")).toBe("tool loop");
  });
  it("replaces underscores for unknown reasons", () => {
    expect(stopReasonLabel("some_reason")).toBe("some reason");
  });
  it("returns empty for empty input", () => {
    expect(stopReasonLabel("")).toBe("");
    expect(stopReasonLabel(null)).toBe("");
  });
});

describe("diagSuffix", () => {
  it("returns empty when no diagnostics", () => {
    expect(diagSuffix({})).toBe("");
    expect(diagSuffix(null)).toBe("");
  });
  it("reports errors", () => {
    expect(diagSuffix({ diagnostics: { errors: 2 } })).toBe("2 errors");
  });
  it("reports warnings when no errors", () => {
    expect(diagSuffix({ diagnostics: { warnings: 1 } })).toBe("1 warning");
  });
  it("reports no problems", () => {
    expect(diagSuffix({ diagnostics: {} })).toBe("no problems");
  });
});

describe("hostLabel", () => {
  it("extracts hostname and path from URL", () => {
    expect(hostLabel("https://example.com/foo/bar")).toBe("example.com/foo/bar");
  });
  it("falls back to shortText for non-URL", () => {
    expect(hostLabel("not a url")).toBe("not a url");
  });
  it("returns empty for empty input", () => {
    expect(hostLabel("")).toBe("");
  });
});

describe("formatClock", () => {
  it("returns empty for falsy", () => {
    expect(formatClock(0)).toBe("");
    expect(formatClock(null)).toBe("");
  });
  it("returns a time string for a valid timestamp", () => {
    const ts = new Date("2024-01-15T14:30:00Z").getTime();
    const result = formatClock(ts);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("toolChangePresentation", () => {
  it("returns null for unknown tools", () => {
    expect(toolChangePresentation("some_tool", {}, {})).toBeNull();
  });

  it("handles file_edit with diff stats", () => {
    const result = toolChangePresentation("file_edit", { path: "src/foo.ts", oldString: "a\nb", newString: "a\nb\nc" }, {});
    expect(result).not.toBeNull();
    expect(result!.verb).toBe("Editing");
    expect(result!.path).toBe("src/foo.ts");
    expect(result!.additions).toBe(1);
    expect(result!.deletions).toBe(0);
  });

  it("handles file_write with byte count", () => {
    const result = toolChangePresentation("file_write", { path: "src/bar.ts", content: "line1\nline2" }, { bytesWritten: 128 });
    expect(result).not.toBeNull();
    expect(result!.verb).toBe("Writing");
    expect(result!.additions).toBe(2);
    expect(result!.deletions).toBe(0);
  });

  it("handles file_delete", () => {
    const result = toolChangePresentation("file_delete", { path: "src/old.ts" }, {});
    expect(result).not.toBeNull();
    expect(result!.verb).toBe("Deleting");
  });

  it("returns null for file_edit without path", () => {
    expect(toolChangePresentation("file_edit", {}, {})).toBeNull();
  });
});
