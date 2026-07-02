import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_CHAR_LIMIT, JSON_ESCAPED_NEWLINE, capToolResult, pageResult, snapToLineEnd,
} from "../../src/tool-result-paging.js";

describe("snapToLineEnd", () => {
  it("returns rawEnd unchanged once it reaches the end of the text", () => {
    expect(snapToLineEnd("abc\ndef", 0, 7)).toBe(7);
    expect(snapToLineEnd("abc\ndef", 0, 100)).toBe(100);
  });

  it("snaps backward to just after the nearest newline before rawEnd", () => {
    // "line1\nline2\nline3" — cutting at index 8 (mid "line2") should snap back to 6 (start of "line2").
    const text = "line1\nline2\nline3";
    expect(snapToLineEnd(text, 0, 8)).toBe(6);
  });

  it("falls back to rawEnd when no newline exists within the lookback window", () => {
    const text = "x".repeat(1000); // one giant line, no newlines at all
    expect(snapToLineEnd(text, 0, 500, "\n", 100)).toBe(500);
  });

  it("never snaps to a position at or before start (must make forward progress)", () => {
    // A newline sits immediately before start; snapping there would produce an empty slice.
    const text = "line1\nline2\nline3";
    // start=6 ("line2" begins here); rawEnd=8 is inside "line2"; the only earlier newline is at 5,
    // which is before start, so there is no valid backward snap — rawEnd is used as-is.
    expect(snapToLineEnd(text, 6, 8)).toBe(8);
  });

  it("respects a custom lookback distance", () => {
    const text = `${"a".repeat(50)}\n${"b".repeat(50)}`;
    // The only newline is at index 50; a lookback of 10 from rawEnd=70 can't reach it.
    expect(snapToLineEnd(text, 0, 70, "\n", 10)).toBe(70);
    // A generous lookback of 500 finds it.
    expect(snapToLineEnd(text, 0, 70, "\n", 500)).toBe(51);
  });

  it("snaps on a custom multi-character boundary instead of a literal newline", () => {
    // JSON.stringify output never contains a literal newline byte — a real newline
    // becomes the two-character escape sequence backslash-n. Snapping must operate on
    // that sequence to be effective on JSON-serialized content.
    const text = String.raw`{"content":"line1\nline2\nline3"}`;
    const firstEscape = text.indexOf(String.raw`\n`);
    const secondEscape = text.indexOf(String.raw`\n`, firstEscape + 1);
    const rawEnd = secondEscape + 4; // a few characters past the second escape, into "line3"
    const end = snapToLineEnd(text, 0, rawEnd, JSON_ESCAPED_NEWLINE);
    expect(end).toBe(secondEscape + 2); // cut right after the escape sequence, not mid-"line3"
    expect(text.slice(0, end).endsWith(JSON_ESCAPED_NEWLINE)).toBe(true);
  });

  it("never splits the boundary sequence itself in half", () => {
    const text = String.raw`{"a":"x\ny"}`; // the only backslash-n sits at a known offset
    const backslashIndex = text.indexOf("\\");
    // Ask to cut exactly between the backslash and the 'n' — snapping must not land there.
    const end = snapToLineEnd(text, 0, backslashIndex + 1, JSON_ESCAPED_NEWLINE);
    expect(text.slice(0, end)).not.toMatch(/\\$/); // never ends on a dangling backslash
  });
});

describe("capToolResult", () => {
  it("passes content through unchanged when within the ceiling", () => {
    const result = capToolResult("short content", "toolu_1", 100);
    expect(result).toEqual({ content: "short content", overflowed: false });
  });

  it("passes content through unchanged at exactly the ceiling", () => {
    const content = "x".repeat(100);
    const result = capToolResult(content, "toolu_1", 100);
    expect(result.overflowed).toBe(false);
    expect(result.content).toBe(content);
  });

  it("caps content over the ceiling and appends a notice with the toolCallId and resume offset", () => {
    const content = "line\n".repeat(50); // 250 chars, 50 lines of 5 chars each
    const result = capToolResult(content, "toolu_abc123", 100);
    expect(result.overflowed).toBe(true);
    expect(result.content).toContain('toolCallId "toolu_abc123"');
    expect(result.content).toContain("tool_output_page");
    // Cut snaps to a line boundary (a multiple of 5) at or before the 100-char ceiling.
    const noticeMatch = /offset (\d+)/.exec(result.content);
    expect(noticeMatch).not.toBeNull();
    const offset = Number(noticeMatch![1]);
    expect(offset).toBeLessThanOrEqual(100);
    expect(offset % 5).toBe(0);
    expect(result.content.startsWith(content.slice(0, offset))).toBe(true);
  });

  it("reports accurate remaining/total counts in the notice", () => {
    const content = "a".repeat(30000); // no newlines — cut lands exactly at the ceiling
    const result = capToolResult(content, "toolu_x", DEFAULT_PAGE_CHAR_LIMIT);
    expect(result.content).toContain(`of ${content.length.toLocaleString()} characters`);
    expect(result.content).toContain(`${(content.length - DEFAULT_PAGE_CHAR_LIMIT).toLocaleString()} remain`);
  });

  it("uses the default ceiling when none is provided", () => {
    const underDefault = "x".repeat(DEFAULT_PAGE_CHAR_LIMIT);
    expect(capToolResult(underDefault, "id").overflowed).toBe(false);
    const overDefault = "x".repeat(DEFAULT_PAGE_CHAR_LIMIT + 1);
    expect(capToolResult(overDefault, "id").overflowed).toBe(true);
  });
});

describe("pageResult", () => {
  it("returns the first slice from offset 0", () => {
    const text = "0123456789";
    const page = pageResult(text, 0, 5);
    expect(page.content).toBe("01234");
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(5);
  });

  it("returns the final slice with hasMore false and nextOffset null", () => {
    const text = "0123456789";
    const page = pageResult(text, 5, 100);
    expect(page.content).toBe("56789");
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
    expect(page.totalLength).toBe(10);
  });

  it("clamps an out-of-range offset into [0, length]", () => {
    const text = "hello";
    expect(pageResult(text, -50, 10).offset).toBe(0);
    expect(pageResult(text, 5000, 10).offset).toBe(5);
    expect(pageResult(text, 5000, 10).content).toBe("");
  });

  it("guards against a zero or negative limit by making at least one character of progress", () => {
    const page = pageResult("hello", 0, 0);
    expect(page.content.length).toBeGreaterThan(0);
  });

  it("snaps the end to a line boundary mid-document", () => {
    const text = "line1\nline2\nline3\nline4";
    const page = pageResult(text, 0, 8); // raw cutoff lands inside "line2"
    expect(page.content).toBe("line1\n");
    expect(page.nextOffset).toBe(6);
  });

  it("chains losslessly: concatenating every page reconstructs the original text exactly", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line number ${i}`);
    const original = lines.join("\n");
    let offset = 0;
    let reconstructed = "";
    let pages = 0;
    for (;;) {
      const page = pageResult(original, offset, 777); // an oddball limit, deliberately not line-aligned
      reconstructed += page.content;
      pages += 1;
      if (!page.hasMore) break;
      offset = page.nextOffset!;
      expect(pages).toBeLessThan(1000); // safety valve against an infinite loop bug
    }
    expect(reconstructed).toBe(original);
    expect(pages).toBeGreaterThan(1); // sanity: the text actually needed multiple pages
  });

  it("uses the default page limit when none is provided", () => {
    const text = "x".repeat(DEFAULT_PAGE_CHAR_LIMIT + 10);
    const page = pageResult(text, 0);
    expect(page.content.length).toBe(DEFAULT_PAGE_CHAR_LIMIT);
  });
});
