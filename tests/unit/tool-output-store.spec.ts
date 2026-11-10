/*
  Unit coverage for ToolOutputStore: model-facing capping, and tool_output_page /
  tool_output_search over the context archive. agent-session.tool-output-paging.spec.ts drives
  this through a real AgentSession turn; these tests cover the edges that are awkward to reach
  that way. Archive tiers and eviction are covered in context-archive.spec.ts.
*/
import { describe, expect, it } from "vitest";
import { ToolOutputStore } from "../../src/agent/tool-output-store.js";
import { ContextArchive } from "../../src/context/archive.js";
import { DEFAULT_PAGE_CHAR_LIMIT } from "../../src/tool-result-paging.js";

/** Comfortably past the per-result ceiling, so cap() always truncates. */
function oversized(marker: string): string {
  return `${marker}:${"x".repeat(DEFAULT_PAGE_CHAR_LIMIT * 2)}`;
}

describe("ToolOutputStore", () => {
  it("returns small results unchanged and still archives them", () => {
    const store = new ToolOutputStore();
    const small = JSON.stringify({ ok: true, value: "short" });
    expect(store.cap("call_1", small)).toBe(small);
    expect(store.size).toBe(1);
    // A result that fit can be read back too: what makes setting it aside later recoverable.
    expect(store.page({ toolCallId: "call_1" })).toMatchObject({ ok: true, content: small, hasMore: false });
  });

  it("truncates an oversized result and retains the full text for paging", () => {
    const store = new ToolOutputStore();
    const full = oversized("big");
    const capped = store.cap("call_1", full);

    expect(capped.length).toBeLessThan(full.length);
    expect(capped).toContain("tool_output_page");
    expect(store.size).toBe(1);

    const page = store.page({ toolCallId: "call_1", offset: 0, limit: 20 }) as {
      ok: boolean; content: string; totalLength: number; hasMore: boolean; nextOffset: number;
    };
    expect(page.ok).toBe(true);
    expect(page.totalLength).toBe(full.length);
    expect(page.content).toBe(full.slice(0, 20));
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(20);
  });

  it("keeps browser and web results, and results of unknown tools, off disk", () => {
    const puts: Array<{ id: string; persist?: boolean }> = [];
    const archive = new ContextArchive();
    const put = archive.put.bind(archive);
    archive.put = (id, text, toolName, options) => { puts.push({ id, persist: options?.persist }); put(id, text, toolName, options); };
    const store = new ToolOutputStore(archive);
    store.cap("b", "{}", "browser_type");
    store.cap("w", "{}", "web_fetch");
    store.cap("u", "{}");
    store.cap("f", "{}", "file_read");
    expect(puts).toEqual([
      { id: "b", persist: false },
      { id: "w", persist: false },
      { id: "u", persist: false },
      { id: "f", persist: true },
    ]);
  });

  it("at the default limit, cuts after the start as it always has", () => {
    const store = new ToolOutputStore();
    const capped = store.cap("call_1", `${"y".repeat(DEFAULT_PAGE_CHAR_LIMIT)}TAIL`);
    expect(capped).toContain("Output truncated at");
    expect(capped).not.toContain("TAIL");
  });

  it("at any other limit, keeps the start, the end and the error lines, read live", () => {
    let limit = 1_000;
    const store = new ToolOutputStore(new ContextArchive(), () => limit);
    const lines = ["START", ...Array.from({ length: 200 }, (_, i) => (i === 120 ? "Error: boom at line 120" : `ok line ${i}`)), "END"];
    // JSON-escaped newlines, as every stringified result has them.
    const text = lines.join("\\n");
    const capped = store.cap("call_1", text);
    expect(store.inlineLimit).toBe(1_000);
    expect(capped.startsWith("START")).toBe(true);
    expect(capped).toContain("Error: boom at line 120");
    expect(capped).toContain("END");
    expect(capped).toContain("omitted from the middle");
    expect(capped).toContain('toolCallId "call_1"');

    limit = DEFAULT_PAGE_CHAR_LIMIT;
    expect(store.cap("call_2", text)).toBe(text);
  });

  it("no longer stops at the newest 30 truncated results", () => {
    const store = new ToolOutputStore();
    for (let i = 0; i < 40; i++) store.cap(`call_${i}`, oversized(`r${i}`));
    expect(store.size).toBe(40);
    expect((store.page({ toolCallId: "call_0" }) as { ok: boolean }).ok).toBe(true);
  });

  it("reports a useful error for an unknown toolCallId", () => {
    const store = new ToolOutputStore();
    const result = store.page({ toolCallId: "never_stored" }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("never_stored");
    // The message has to say whether eviction could explain it, or a model that hits it has no
    // way to know whether retrying with a different offset could help.
    expect(result.error).toMatch(/memory only|oldest/);
  });

  it("requires toolCallId on page and toolCallId + pattern on search", () => {
    const store = new ToolOutputStore();
    expect(store.page({})).toMatchObject({ ok: false, error: "toolCallId is required." });
    expect(store.search({})).toMatchObject({ ok: false, error: "toolCallId is required." });
    expect(store.search({ toolCallId: "call_1" })).toMatchObject({ ok: false, error: "pattern is required." });
  });

  it("searches within a retained result", () => {
    const store = new ToolOutputStore();
    const full = ["alpha line", "beta line", "gamma needle here", "delta line"].join("\\n")
      + "z".repeat(DEFAULT_PAGE_CHAR_LIMIT * 2);
    store.cap("call_1", full);

    const found = store.search({ toolCallId: "call_1", pattern: "needle" }) as {
      ok: boolean; totalMatches: number; matches: unknown[];
    };
    expect(found.ok).toBe(true);
    expect(found.totalMatches).toBeGreaterThan(0);
    expect(found.matches.length).toBeGreaterThan(0);

    const missing = store.search({ toolCallId: "call_1", pattern: "no-such-text" }) as {
      ok: boolean; totalMatches: number;
    };
    expect(missing.ok).toBe(true);
    expect(missing.totalMatches).toBe(0);
  });
});
