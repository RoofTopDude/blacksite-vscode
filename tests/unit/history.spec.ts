import { describe, expect, it } from "vitest";
import { firstUserText, historyTitle } from "../../src/webview/react/lib/history.js";

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
