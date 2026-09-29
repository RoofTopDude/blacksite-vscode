import { describe, expect, it } from "vitest";
import { firstUserText, groupHistory, historyBucket, historyTitle } from "../../src/webview/react/lib/history.js";

describe("firstUserText", () => {
  it("returns the first user string message", () => {
    expect(firstUserText([{ role: "assistant", content: "hi" }, { role: "user", content: "hello" }])).toBe("hello");
  });
  it("reads the first text block of a structured user message", () => {
    expect(firstUserText([{ role: "user", content: [{ type: "tool_result" }, { type: "text", text: "block" }] }])).toBe("block");
  });
  it("returns empty string when there is no user text", () => {
    expect(firstUserText([])).toBe("");
    expect(firstUserText(undefined)).toBe("");
    expect(firstUserText([{ role: "assistant", content: "x" }])).toBe("");
  });
});

describe("historyTitle", () => {
  it("prefers the backend firstMessage summary (the list payload has no messages array)", () => {
    expect(historyTitle({ sessionId: "s1", firstMessage: "Fix the build" })).toBe("Fix the build");
  });
  it("falls back to deriving from inline messages", () => {
    expect(historyTitle({ sessionId: "s1", messages: [{ role: "user", content: "derive me" }] })).toBe("derive me");
  });
  it("uses a generic label only when nothing else is available", () => {
    expect(historyTitle({ sessionId: "s1" })).toBe("Conversation");
    expect(historyTitle({ sessionId: "s1", firstMessage: "   " })).toBe("Conversation");
  });
});

describe("historyBucket", () => {
  // Local noon, so the calendar-day boundaries don't depend on the machine's timezone.
  const now = new Date(2026, 8, 26, 12, 0, 0).getTime();
  const at = (days: number, hour = 12) => new Date(2026, 8, 26 - days, hour).getTime();

  it("buckets by calendar day, not by 24-hour distance", () => {
    expect(historyBucket(at(0, 0), now)).toBe("Today");
    expect(historyBucket(at(1, 23), now)).toBe("Yesterday");
    expect(historyBucket(at(1, 0), now)).toBe("Yesterday");
    expect(historyBucket(at(6), now)).toBe("Previous 7 days");
    expect(historyBucket(at(7), now)).toBe("Earlier");
  });
  it("treats a session with no timestamp as old", () => {
    expect(historyBucket(undefined, now)).toBe("Earlier");
  });
});

describe("groupHistory", () => {
  it("groups sessions under their bucket in feed order", () => {
    const now = new Date(2026, 8, 26, 12).getTime();
    const day = 86_400_000;
    const groups = groupHistory([
      { sessionId: "a", updatedAt: now - 1000 },
      { sessionId: "b", updatedAt: now - 2000 },
      { sessionId: "c", updatedAt: now - day },
      { sessionId: "d", createdAt: now - 30 * day },
    ], now);
    expect(groups.map((g) => [g.bucket, g.sessions.map((s) => s.sessionId)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier", ["d"]],
    ]);
  });
});
