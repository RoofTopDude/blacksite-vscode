import { describe, expect, it } from "vitest";
import type { ContextItem, ContextClass } from "../../src/context/model.js";
import type { LedgerSnapshot } from "../../src/context/ledger.js";
import { CONTEXT_CLASSES } from "../../src/context/model.js";
import { planAging, tokensFrom, STUB_TOKEN_ESTIMATE } from "../../src/context/policy.js";
import { buildSetAsideStub, isSetAside, outcomeLine } from "../../src/context/stubs.js";
import { capToolResultKeepingEnds } from "../../src/tool-result-paging.js";

function result(id: string, messageIndex: number, tokens: number, extra: Partial<ContextItem> = {}): ContextItem {
  return {
    id, class: "tool-result", chars: tokens * 4, tokens, stability: "session",
    recall: { kind: "archive", id }, pinned: false, messageIndex, ...extra,
  };
}

function snapshot(items: ContextItem[]): LedgerSnapshot {
  const byClass = Object.fromEntries(CONTEXT_CLASSES.map((cls) => [cls, { items: 0, chars: 0, tokens: 0 }])) as Record<ContextClass, { items: number; chars: number; tokens: number }>;
  let total = 0;
  for (const item of items) {
    byClass[item.class].items += 1;
    byClass[item.class].tokens += item.tokens;
    total += item.tokens;
  }
  return { items, byClass, estimatedTokens: total, calibratedTokens: total };
}

const base = { recentStart: 10, alreadySetAside: new Set<string>(), force: true };

describe("planAging", () => {
  const items = [
    result("old-big", 1, 8_000),
    result("superseded", 3, 2_000, { supersededBy: "newer" }),
    result("old-small", 2, 300),
    result("pinned", 4, 9_000, { pinned: true }),
    result("no-way-back", 5, 9_000, { recall: { kind: "none" } }),
    result("recent", 11, 9_000),
    result("mid", 6, 4_000),
  ];

  it("takes superseded results first, then older and larger ones, until the target", () => {
    const decision = planAging(snapshot(items), { ...base, currentTokens: 50_000, targetTokens: 40_000 });
    expect(decision.setAside.map((candidate) => candidate.id)).toEqual(["superseded", "old-big", "mid"]);
    expect(decision.setAside[0]).toMatchObject({ reason: "superseded", supersededBy: "newer" });
    expect(decision.freedTokens).toBe(2_000 + 8_000 + 4_000 - 3 * STUB_TOKEN_ESTIMATE);
    expect(decision.worthIt).toBe(true);
  });

  it("never touches pinned items, the recent window, results with no way back, or small ones", () => {
    const decision = planAging(snapshot(items), { ...base, currentTokens: 500_000, targetTokens: 0 });
    const ids = decision.setAside.map((candidate) => candidate.id);
    for (const id of ["pinned", "recent", "no-way-back", "old-small"]) expect(ids).not.toContain(id);
  });

  it("stops as soon as the target is met", () => {
    const decision = planAging(snapshot(items), { ...base, currentTokens: 41_000, targetTokens: 40_000 });
    expect(decision.setAside.map((candidate) => candidate.id)).toEqual(["superseded"]);
  });

  it("skips what is already set aside, and does nothing under the target", () => {
    expect(planAging(snapshot(items), { ...base, currentTokens: 30_000, targetTokens: 40_000 }).reason).toBe("under-target");
    const decision = planAging(snapshot(items), { ...base, currentTokens: 50_000, targetTokens: 0, alreadySetAside: new Set(["old-big", "superseded", "mid"]) });
    expect(decision.reason).toBe("nothing-eligible");
  });

  it("below the budget, holds off when re-caching the history costs more than it saves", () => {
    // An old result followed by a long history: setting it aside rewrites all of it.
    const long = [result("old", 0, 5_000), ...Array.from({ length: 9 }, (_, i) => result(`later-${i}`, i + 1, 10_000, { recall: { kind: "none" } }))];
    const cache = { readMultiplier: 0.1, writeMultiplier: 1.25, horizonRequests: 5 };
    const decision = planAging(snapshot(long), { ...base, force: false, currentTokens: 95_000, targetTokens: 50_000, cache });
    expect(decision.worthIt).toBe(false);
    expect(decision.reason).toBe("not-worth-the-rewrite");
    expect(decision.setAside).toEqual([]);
    expect(decision.candidates.map((candidate) => candidate.id)).toEqual(["old"]);
    expect(decision.rewriteTokens).toBeGreaterThan(90_000 - 5_000);

    // Forced (over budget) it acts anyway; with a long horizon it pays for itself.
    expect(planAging(snapshot(long), { ...base, force: true, currentTokens: 95_000, targetTokens: 50_000, cache }).worthIt).toBe(true);
    const nearEnd = [...long.slice(1), result("late-big", 9, 40_000)];
    expect(planAging(snapshot(nearEnd), { ...base, force: false, currentTokens: 130_000, targetTokens: 50_000, cache: { ...cache, horizonRequests: 20 } }).worthIt).toBe(true);
  });

  it("is unpriced without cache figures: acts only when forced", () => {
    const decision = planAging(snapshot(items), { ...base, force: false, currentTokens: 50_000, targetTokens: 40_000 });
    expect(decision.worthIt).toBe(false);
  });

  it("measures the rewrite from the earliest message", () => {
    expect(tokensFrom(snapshot(items), 6)).toBe(4_000 + 9_000);
  });
});

describe("set-aside records", () => {
  it("say what the call was, how it went, why it went, and how to get it back", () => {
    const stub = buildSetAsideStub("toolu_1", {
      tool: "file_read", input: { path: "src/a.ts" }, content: JSON.stringify({ ok: true, content: "x".repeat(5000) }),
      why: "superseded", supersededBy: "toolu_9", recall: { kind: "archive", id: "toolu_1" }, note: "a.ts exports run()",
    });
    const record = JSON.parse(stub)._setAside;
    expect(record).toMatchObject({ tool: "file_read", outcome: "ok", note: "a.ts exports run()" });
    expect(record.input).toContain("src/a.ts");
    expect(record.why).toContain("toolu_9");
    expect(record.recover).toContain('tool_output_page with toolCallId "toolu_1"');
    expect(record.chars).toBeGreaterThan(5000);
    expect(isSetAside(stub)).toBe(true);
    expect(isSetAside(JSON.stringify({ _elided: "old style" }))).toBe(true);
    expect(isSetAside(JSON.stringify({ ok: true }))).toBe(false);
  });

  it("report failures and re-reads", () => {
    expect(outcomeLine(JSON.stringify({ ok: false, error: "ENOENT: no such file" }))).toBe("failed: ENOENT: no such file");
    expect(outcomeLine(JSON.stringify({ ok: true, summary: "3 tests passed" }))).toBe("ok: 3 tests passed");
    const stub = JSON.parse(buildSetAsideStub("t", { tool: "file_read", input: undefined, content: "{}", why: "aged", recall: { kind: "re-read", path: "a.ts" } }));
    expect(stub._setAside.recover).toBe("re-read a.ts; it has not changed since");
  });
});

describe("capToolResultKeepingEnds", () => {
  const NL = "\\n";
  it("passes content within the ceiling through unchanged", () => {
    expect(capToolResultKeepingEnds("short", "id", 100, NL)).toEqual({ content: "short", overflowed: false });
  });

  it("keeps the start, the end and the failure lines in the middle", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    lines[200] = "FAIL tests/a.spec.ts > adds";
    lines[250] = "TypeError: x is undefined";
    const content = lines.join(NL);
    const { content: capped, overflowed } = capToolResultKeepingEnds(content, "toolu_x", 2_000, NL);
    expect(overflowed).toBe(true);
    expect(capped.startsWith("line 0")).toBe(true);
    expect(capped).toContain("line 399");
    expect(capped).toContain("FAIL tests/a.spec.ts > adds");
    expect(capped).toContain("TypeError: x is undefined");
    expect(capped).not.toContain("line 150" + NL);
    expect(capped).toContain('toolCallId "toolu_x"');
  });

  it("falls back to a head-only cut when the ceiling cannot hold both ends", () => {
    const content = "x".repeat(1_000);
    expect(capToolResultKeepingEnds(content, "id", 3, NL).content).toContain("Output truncated at");
  });
});
