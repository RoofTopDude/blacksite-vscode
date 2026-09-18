/*
  Unit coverage for ToolOutputStore, the overflow retention behind tool_output_page and
  tool_output_search. agent-session.tool-output-paging.spec.ts already drives this through a
  real AgentSession turn; these tests cover the edges that are awkward to reach that way —
  eviction under the entry cap, and the not-found paths — now that the store is its own object.
*/
import { describe, expect, it } from "vitest";
import { ToolOutputStore, RESULT_OVERFLOW_MAX_ENTRIES } from "../../src/agent/tool-output-store.js";
import { DEFAULT_PAGE_CHAR_LIMIT } from "../../src/tool-result-paging.js";

/** Comfortably past the per-result ceiling, so cap() always overflows and retains. */
function oversized(marker: string): string {
  return `${marker}:${"x".repeat(DEFAULT_PAGE_CHAR_LIMIT * 2)}`;
}

describe("ToolOutputStore", () => {
  it("returns small results unchanged and retains nothing", () => {
    const store = new ToolOutputStore();
    const small = JSON.stringify({ ok: true, value: "short" });
    expect(store.cap("call_1", small)).toBe(small);
    expect(store.size).toBe(0);
  });

  it("truncates an oversized result and retains the full text for paging", () => {
    const store = new ToolOutputStore();
    const full = oversized("big");
    const capped = store.cap("call_1", full);

    expect(capped.length).toBeLessThan(full.length);
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

  it("evicts the oldest retained result once the entry cap is reached", () => {
    const store = new ToolOutputStore(3);
    for (const id of ["a", "b", "c"]) store.cap(id, oversized(id));
    expect(store.size).toBe(3);

    store.cap("d", oversized("d"));
    expect(store.size).toBe(3);

    // "a" was the oldest insertion, so it is the one that went.
    expect((store.page({ toolCallId: "a" }) as { ok: boolean }).ok).toBe(false);
    for (const id of ["b", "c", "d"]) {
      expect((store.page({ toolCallId: id }) as { ok: boolean }).ok).toBe(true);
    }
  });

  it("reports a useful error for an unknown toolCallId", () => {
    const store = new ToolOutputStore();
    const result = store.page({ toolCallId: "never_stored" }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("never_stored");
    // The message has to explain the eviction cap, or a model that hits it has no way to know
    // whether retrying with a different offset could help.
    expect(result.error).toContain(String(RESULT_OVERFLOW_MAX_ENTRIES));
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

  it("defaults its entry cap to RESULT_OVERFLOW_MAX_ENTRIES", () => {
    const store = new ToolOutputStore();
    for (let i = 0; i < RESULT_OVERFLOW_MAX_ENTRIES + 5; i++) store.cap(`call_${i}`, oversized(`r${i}`));
    expect(store.size).toBe(RESULT_OVERFLOW_MAX_ENTRIES);
  });
});
