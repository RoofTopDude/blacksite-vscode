import { describe, expect, it } from "vitest";
import { LiveActivityTracker, LIVE_OP_MAX_AGE_MS } from "../../src/graph/live-activity.js";

describe("LiveActivityTracker", () => {
  it("shows a node while its tool call is in flight and clears it on result", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts"], "edit", 1000);
    expect(t.active).toBe(true);
    expect(t.snapshot(1000)).toEqual([{ path: "src/a.ts", kind: "edit", at: 1000 }]);
    t.result("call1");
    expect(t.active).toBe(false);
    expect(t.snapshot(1000)).toEqual([]);
  });

  it("ignores a call that touches no known node (nothing to show)", () => {
    const t = new LiveActivityTracker();
    t.start("call1", [], "read", 1000);
    expect(t.active).toBe(false);
    expect(t.snapshot(1000)).toEqual([]);
  });

  it("dedupes multiple in-flight ops on the same path, keeping the most recent kind/time", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts"], "read", 1000);
    t.start("call2", ["src/a.ts"], "edit", 1500, "lane-a");
    const snap = t.snapshot(1500);
    expect(snap).toEqual([{ path: "src/a.ts", kind: "edit", at: 1500, laneId: "lane-a" }]);
  });

  it("keeps a path live until *all* ops touching it complete", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts"], "read", 1000);
    t.start("call2", ["src/a.ts"], "edit", 1500);
    t.result("call2");
    // call1 still in flight → path stays live, now reflecting call1's kind.
    expect(t.snapshot(1600)).toEqual([{ path: "src/a.ts", kind: "read", at: 1000 }]);
    t.result("call1");
    expect(t.snapshot(1600)).toEqual([]);
  });

  it("keeps concurrent subagent lanes distinct when provider tool call ids overlap", () => {
    const t = new LiveActivityTracker();
    t.start("lane-a:call1", ["src/a.ts"], "read", 1000, "lane-a");
    t.start("lane-b:call1", ["src/b.ts"], "edit", 1100, "lane-b");
    t.result("lane-a:call1");
    expect(t.snapshot(1200)).toEqual([{ path: "src/b.ts", kind: "edit", at: 1100, laneId: "lane-b" }]);
  });

  it("sorts multiple live nodes most-recent-first (drives the chip's primary)", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts"], "read", 1000);
    t.start("call2", ["src/b.ts"], "edit", 2000);
    t.start("call3", ["src/c.ts"], "shell", 1500);
    expect(t.snapshot(2000).map((a) => a.path)).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
  });

  it("expands a multi-path op (e.g. edit batch) to one live entry per file", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts", "src/b.ts"], "edit", 1000);
    expect(t.snapshot(1000).map((a) => a.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("prunes an op whose result event never arrived, so nothing sticks 'working' forever", () => {
    const t = new LiveActivityTracker();
    t.start("stuck", ["src/a.ts"], "edit", 1000);
    const later = 1000 + LIVE_OP_MAX_AGE_MS + 1;
    expect(t.snapshot(later)).toEqual([]);
    expect(t.active).toBe(false); // pruned entry is actually removed, not just hidden
  });

  it("clear() drops everything (conversation reset)", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts"], "edit", 1000);
    t.clear();
    expect(t.snapshot(1000)).toEqual([]);
  });

  it("carries the intent detail through to the snapshot, newest op's detail winning", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["repo"], "shell", 1000, undefined, "npm test");
    expect(t.snapshot(1000)).toEqual([{ path: "repo", kind: "shell", at: 1000, detail: "npm test" }]);
    // A newer op on the same path replaces the detail.
    t.start("call2", ["repo"], "shell", 1500, undefined, "git status");
    expect(t.snapshot(1500)[0]?.detail).toBe("git status");
  });

  it("normalizes an empty detail string to absent", () => {
    const t = new LiveActivityTracker();
    t.start("call1", ["src/a.ts"], "read", 1000, undefined, "");
    expect(t.snapshot(1000)[0]?.detail).toBeUndefined();
  });
});
