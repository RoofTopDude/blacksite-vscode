import { describe, expect, it } from "vitest";
import { SymbolPass, type SymbolPassDeps } from "../../src/graph/symbol-pass.js";

/** A controllable harness: a fake clock, a signature map, and a record of which
    files were indexed. Each indexFile advances the clock by `costMs`. */
function harness(opts: { budgetMs: number; costMs?: number }) {
  const cost = opts.costMs ?? 1;
  let clock = 0;
  const signatures = new Map<string, string>();
  const indexed: string[] = [];
  const signal = { aborted: false };
  const deps: SymbolPassDeps = {
    now: () => clock,
    signatureOf: (path) => signatures.get(path),
    indexFile: async (path) => { indexed.push(path); clock += cost; },
    signal,
  };
  const pass = new SymbolPass(deps, { budgetMs: opts.budgetMs });
  const setSig = (path: string, sig: string) => signatures.set(path, sig);
  return { pass, indexed, setSig, signal, tick: () => clock, advance: (ms: number) => { clock += ms; } };
}

describe("SymbolPass", () => {
  it("indexes every file exactly once across ticks, then goes idle", async () => {
    const h = harness({ budgetMs: 1000 });
    for (const p of ["a.ts", "b.ts", "c.ts"]) h.setSig(p, "v1");
    h.pass.setFiles(["a.ts", "b.ts", "c.ts"]);
    await h.pass.runTick();
    expect(h.indexed.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(h.pass.hasWork()).toBe(false);
    // Re-pointing at the same unchanged corpus queues nothing.
    h.pass.setFiles(["a.ts", "b.ts", "c.ts"]);
    expect(h.pass.hasWork()).toBe(false);
  });

  it("stops at the time budget and resumes on the next tick", async () => {
    const h = harness({ budgetMs: 2, costMs: 1 }); // ~2 files per tick
    for (let i = 0; i < 5; i += 1) h.setSig(`f${i}.ts`, "v1");
    h.pass.setFiles(["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts"]);
    const first = await h.pass.runTick();
    expect(first).toBe(2);
    expect(h.pass.hasWork()).toBe(true);
    // Drain the rest across further ticks.
    while (h.pass.hasWork()) await h.pass.runTick();
    expect(h.indexed).toHaveLength(5);
  });

  it("reindexes only the files whose signature changed", async () => {
    const h = harness({ budgetMs: 1000 });
    h.setSig("a.ts", "v1");
    h.setSig("b.ts", "v1");
    h.pass.setFiles(["a.ts", "b.ts"]);
    await h.pass.runTick();
    expect(h.indexed).toHaveLength(2);
    // b.ts changes; a.ts does not.
    h.setSig("b.ts", "v2");
    h.pass.setFiles(["a.ts", "b.ts"]);
    await h.pass.runTick();
    expect(h.indexed).toEqual(["a.ts", "b.ts", "b.ts"]);
  });

  it("forgets files dropped from the corpus", () => {
    const h = harness({ budgetMs: 1000 });
    h.setSig("a.ts", "v1");
    h.setSig("b.ts", "v1");
    h.pass.setFiles(["a.ts", "b.ts"]);
    const removed = h.pass.setFiles(["a.ts"]);
    expect(removed).toEqual([]); // nothing indexed yet, so nothing to forget
  });

  it("drops the edges of a removed file after it was indexed", async () => {
    const h = harness({ budgetMs: 1000 });
    h.setSig("a.ts", "v1");
    h.setSig("b.ts", "v1");
    h.pass.setFiles(["a.ts", "b.ts"]);
    await h.pass.runTick();
    const removed = h.pass.setFiles(["a.ts"]);
    expect(removed).toEqual(["b.ts"]);
  });

  it("stops promptly when aborted", async () => {
    const h = harness({ budgetMs: 1000 });
    for (let i = 0; i < 10; i += 1) h.setSig(`f${i}.ts`, "v1");
    h.pass.setFiles(Array.from({ length: 10 }, (_, i) => `f${i}.ts`));
    h.signal.aborted = true;
    const processed = await h.pass.runTick();
    expect(processed).toBe(0);
    expect(h.pass.hasWork()).toBe(true); // work preserved for a later, un-aborted tick
  });

  it("skips unreadable files (no signature) without wedging", async () => {
    const h = harness({ budgetMs: 1000 });
    h.setSig("a.ts", "v1"); // b.ts intentionally has no signature
    h.pass.setFiles(["a.ts", "b.ts"]);
    await h.pass.runTick();
    expect(h.indexed).toEqual(["a.ts"]);
    expect(h.pass.hasWork()).toBe(false);
  });

  it("keeps a cold-provider miss eligible for a later idle tick", async () => {
    let attempts = 0;
    const pass = new SymbolPass({
      now: () => 0,
      signatureOf: () => "v1",
      indexFile: async () => {
        attempts += 1;
        return attempts > 1;
      },
    }, { budgetMs: 10 });
    pass.setFiles(["cold.py"]);
    expect(await pass.runTick()).toBe(0);
    expect(pass.hasWork()).toBe(true);
    expect(await pass.runTick()).toBe(1);
    expect(pass.hasWork()).toBe(false);
  });
});
