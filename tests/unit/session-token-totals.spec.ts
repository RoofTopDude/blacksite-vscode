import { describe, expect, it } from "vitest";
import { readSessionTokenTotals } from "../../src/session-state.js";

describe("readSessionTokenTotals", () => {
  it("reads stored totals back", () => {
    expect(readSessionTokenTotals({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it("drops anything that is not four non-negative numbers, so a session saved by an older build simply has none", () => {
    expect(readSessionTokenTotals(undefined)).toBeUndefined();
    expect(readSessionTokenTotals("12")).toBeUndefined();
    expect(readSessionTokenTotals({ input: 1, output: 2, cacheRead: 3 })).toBeUndefined();
    expect(readSessionTokenTotals({ input: -1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBeUndefined();
    expect(readSessionTokenTotals({ input: Number.NaN, output: 2, cacheRead: 3, cacheWrite: 4 })).toBeUndefined();
  });
});
