import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../../src/vector-store.js";

let root: string;
let filePath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vector-store-"));
  filePath = path.join(root, "vectors.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("load", () => {
  it("starts empty when no file exists yet", () => {
    const store = new VectorStore(filePath);
    store.load();
    expect(store.size).toBe(0);
  });

  it("silently discards a corrupt file and starts fresh, rather than throwing", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not valid json", "utf8");
    const store = new VectorStore(filePath);
    expect(() => store.load()).not.toThrow();
    expect(store.size).toBe(0);
  });

  it("ignores a file with the wrong version tag", () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ v: 2, entries: [{ id: "a", vec: [1], payload: {}, ts: 1 }] }), "utf8");
    const store = new VectorStore(filePath);
    store.load();
    expect(store.size).toBe(0);
  });
});

describe("upsert + search", () => {
  it("normalizes vectors so search scores are cosine similarity", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [1, 0], { label: "right" });
    store.upsert("b", [0, 1], { label: "up" });
    const results = store.search([1, 0], 2);
    expect(results[0]).toMatchObject({ id: "a", payload: { label: "right" } });
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[1]?.score).toBeCloseTo(0, 5);
  });

  it("overwrites an existing entry with the same id instead of duplicating it", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [1, 0], { v: 1 });
    store.upsert("a", [0, 1], { v: 2 });
    expect(store.size).toBe(1);
    expect(store.search([0, 1], 1)[0]?.payload).toEqual({ v: 2 });
  });

  it("applies the filter predicate before scoring and truncates to topK", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [1, 0], { _col: "x" });
    store.upsert("b", [1, 0], { _col: "y" });
    store.upsert("c", [1, 0], { _col: "x" });
    const results = store.search([1, 0], 10, (p) => p["_col"] === "x");
    expect(results.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("excludes entries embedded at a different dimensionality instead of scoring a truncated dot product", () => {
    const store = new VectorStore(filePath);
    store.upsert("same-dims", [1, 0, 0], { label: "comparable" });
    store.upsert("fewer-dims", [1, 0], { label: "stale model" });
    const results = store.search([1, 0, 0], 10);
    expect(results.map((r) => r.id)).toEqual(["same-dims"]);
  });

  it("evicts the oldest entries once maxEntries is exceeded", () => {
    const store = new VectorStore(filePath, 2);
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    store.upsert("old", [1, 0], {});
    vi.setSystemTime(2000);
    store.upsert("mid", [1, 0], {});
    vi.setSystemTime(3000);
    store.upsert("new", [1, 0], {});
    expect(store.size).toBe(2);
    const ids = store.search([1, 0], 10).map((r) => r.id).sort();
    expect(ids).toEqual(["mid", "new"]);
  });
});

describe("delete", () => {
  it("removes an entry and reports whether it existed", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [1, 0], {});
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe("collectionSize", () => {
  it("counts only entries tagged with the given _col", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [1, 0], { _col: "notes" });
    store.upsert("b", [1, 0], { _col: "notes" });
    store.upsert("c", [1, 0], { _col: "code" });
    expect(store.collectionSize("notes")).toBe(2);
    expect(store.collectionSize("code")).toBe(1);
    expect(store.collectionSize("missing")).toBe(0);
  });
});

describe("clear", () => {
  it("drops every entry and persists immediately", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [1, 0], {});
    store.clear();
    expect(store.size).toBe(0);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.entries).toEqual([]);
  });

  it("is a no-op (and doesn't write a file) when already empty", () => {
    const store = new VectorStore(filePath);
    store.clear();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("persistence round-trip", () => {
  it("dispose() flushes pending writes so a fresh instance can reload them", () => {
    const store = new VectorStore(filePath);
    store.upsert("a", [3, 4], { label: "x" });
    store.dispose();

    const reloaded = new VectorStore(filePath);
    reloaded.load();
    expect(reloaded.size).toBe(1);
    expect(reloaded.search([1, 0], 1)[0]?.payload).toEqual({ label: "x" });
  });

  it("save() is a no-op when nothing is dirty", () => {
    const store = new VectorStore(filePath);
    store.save();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
