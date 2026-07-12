import { describe, expect, it } from "vitest";
import {
  appendOpenAIWorkspaceContextTail,
  openRouterSupportsCacheControl,
  withOpenRouterCacheControl,
  toOpenAIMessages,
} from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";

type Part = { type: string; text?: string; cache_control?: { type: string } };

const partsOf = (content: unknown): Part[] => content as Part[];

describe("openRouterSupportsCacheControl", () => {
  it("matches Anthropic and Gemini model ids", () => {
    expect(openRouterSupportsCacheControl("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(openRouterSupportsCacheControl("google/gemini-2.5-pro")).toBe(true);
    expect(openRouterSupportsCacheControl("claude-3-5-haiku")).toBe(true);
  });

  it("rejects models whose providers ignore or auto-handle caching", () => {
    expect(openRouterSupportsCacheControl("openai/gpt-4o")).toBe(false);
    expect(openRouterSupportsCacheControl("meta-llama/llama-3.3-70b-instruct")).toBe(false);
    expect(openRouterSupportsCacheControl("mistralai/mistral-large")).toBe(false);
    // "google" alone must not qualify — Gemma has no cache_control support.
    expect(openRouterSupportsCacheControl("google/gemma-3-27b-it")).toBe(false);
  });
});

describe("appendOpenAIWorkspaceContextTail", () => {
  it("appends the volatile block as a separate trailing user message, past any breakpoints", () => {
    const msgs = withOpenRouterCacheControl(toOpenAIMessages([{ role: "user", content: "task" }], "sys"));
    const out = appendOpenAIWorkspaceContextTail(msgs, "WORKSPACE STATE");
    const last = out[out.length - 1]!;
    expect(last).toEqual({ role: "user", content: "WORKSPACE STATE" });
    // The rolling breakpoint stays on the stable history message, NOT the volatile tail —
    // a breakpoint on per-turn content would cache-write the whole body every request
    // and never get a read hit.
    const marked = out[out.length - 2]!;
    expect((marked.content as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op for empty context or empty history", () => {
    const msgs = toOpenAIMessages([{ role: "user", content: "task" }], "sys");
    expect(appendOpenAIWorkspaceContextTail(msgs, "   ")).toBe(msgs);
    expect(appendOpenAIWorkspaceContextTail([], "ctx")).toEqual([]);
  });
});

describe("withOpenRouterCacheControl", () => {
  const build = (messages: AgentMessage[]) => toOpenAIMessages(messages, "sys prompt");

  it("marks the system message and the last user message with breakpoints", () => {
    const out = withOpenRouterCacheControl(build([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]));

    const system = out.find((m) => m.role === "system")!;
    expect(partsOf(system.content)[0]).toMatchObject({ type: "text", text: "sys prompt", cache_control: { type: "ephemeral" } });

    const users = out.filter((m) => m.role === "user");
    // Only the LAST user message carries the rolling breakpoint.
    expect(users[0]!.content).toBe("first");
    expect(partsOf(users[1]!.content)[0]).toMatchObject({ text: "second", cache_control: { type: "ephemeral" } });
  });

  it("marks the last text part of an already-multipart user message, not image parts", () => {
    const out = withOpenRouterCacheControl([
      { role: "system", content: "s" },
      { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
      ] },
    ]);
    const parts = partsOf(out[1]!.content);
    expect(parts[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(parts[1]).not.toHaveProperty("cache_control");
  });

  it("leaves tool-role messages untouched even when they are last", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "file_read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "data" }] },
    ];
    const out = withOpenRouterCacheControl(build(messages));
    const toolMsg = out.find((m) => m.role === "tool")!;
    expect(typeof toolMsg.content).toBe("string");
    // The rolling breakpoint falls back to the last real user message.
    const userMsg = out.find((m) => m.role === "user")!;
    expect(partsOf(userMsg.content)[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("never mutates the input messages", () => {
    const input = build([{ role: "user", content: "hello" }]);
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    withOpenRouterCacheControl(input);
    expect(input).toEqual(snapshot);
  });
});
