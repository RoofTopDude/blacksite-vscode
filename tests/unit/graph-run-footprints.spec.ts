import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { footprintFromEvents, RunFootprintIndex, runsTouching, type RunEventLike } from "../../src/graph/run-footprints.js";

const summary = (id: string, status: string, startedAt: string) => ({ id, title: `Run ${id}`, status, startedAt, endedAt: new Date(Date.parse(startedAt) + 60_000).toISOString() });

describe("run footprints", () => {
  it("folds events into per-file counts, first touch, and kinds", () => {
    const fp = footprintFromEvents(summary("r1", "succeeded", "2026-09-01T00:00:00Z"), [
      { id: "1", path: "src/a.ts", kind: "read", at: 500 },
      { id: "2", path: "src/a.ts", kind: "edit", at: 200 },
      { id: "3", path: "lib/b.ts", kind: "read", at: 900 },
    ]);
    expect(fp.files["src/a.ts"]).toEqual([2, 200, ["edit", "read"]]);
  });

  it("answers which runs touched a file or area, newest first", () => {
    const older = footprintFromEvents(summary("old", "succeeded", "2026-09-01T00:00:00Z"), [{ id: "1", path: "src/a.ts", kind: "edit", at: 10 }]);
    const newer = footprintFromEvents(summary("new", "failed", "2026-09-02T00:00:00Z"), [
      { id: "1", path: "src/a.ts", kind: "read", at: 30 },
      { id: "2", path: "src/c.ts", kind: "edit", at: 5 },
    ]);
    const other = footprintFromEvents(summary("other", "succeeded", "2026-09-03T00:00:00Z"), [{ id: "1", path: "docs/x.md", kind: "read", at: 1 }]);
    const touches = runsTouching([older, newer, other], (p) => p.startsWith("src/"));
    expect(touches.map((t) => t.runId)).toEqual(["new", "old"]);
    expect(touches[0]).toMatchObject({ firstAt: 5, events: 2 });
  });

  it("pages through event windows and caches finished runs on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-footprints-"));
    try {
      let windowCalls = 0;
      const events: RunEventLike[] = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}`, path: `f${i % 3}.ts`, kind: "read", at: i }));
      const source = {
        listRunSummaries: () => [summary("r1", "succeeded", "2026-09-01T00:00:00Z")],
        getMapEventWindow: (_id: string, from: number, to: number, limit: number) => {
          windowCalls += 1;
          return events.filter((e) => e.at >= from && e.at <= to).slice(0, limit);
        },
      };
      const cache = join(dir, "fp.json");
      const index = new RunFootprintIndex(source, cache);
      const [fp] = await index.footprints();
      expect(windowCalls).toBe(2);
      expect(Object.keys(fp!.files).sort()).toEqual(["f0.ts", "f1.ts", "f2.ts"]);

      windowCalls = 0;
      const reloaded = new RunFootprintIndex(source, cache);
      await reloaded.footprints();
      expect(windowCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomputes a run that is still in progress", async () => {
    let calls = 0;
    const source = {
      listRunSummaries: () => [{ id: "live", title: "live", status: "running", startedAt: new Date().toISOString() }],
      getMapEventWindow: () => { calls += 1; return []; },
    };
    const index = new RunFootprintIndex(source, null);
    await index.footprints();
    await index.footprints();
    expect(calls).toBe(2);
  });
});
