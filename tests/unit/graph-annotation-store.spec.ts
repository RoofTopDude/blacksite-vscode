import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphAnnotationStore } from "../../src/graph-annotation-store.js";

let root: string;
let store: GraphAnnotationStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-annotations-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export {};", "utf8");
  store = new GraphAnnotationStore(root);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GraphAnnotationStore", () => {
  it("round-trips an annotation to .blacksite/graph.json", () => {
    const added = store.add({ from: "src/a.ts", to: "src\\b.ts", note: "a drives b", kind: "ai", author: "agent", sessionId: "s1" });
    expect(added.from).toBe("src/a.ts");
    expect(added.to).toBe("src/b.ts");

    const reloaded = new GraphAnnotationStore(root).read();
    expect(reloaded.annotations).toHaveLength(1);
    expect(reloaded.annotations[0]).toMatchObject({ from: "src/a.ts", to: "src/b.ts", note: "a drives b", kind: "ai", author: "agent", sessionId: "s1" });
  });

  it("dedupes identical (from,to,note) triples", () => {
    const first = store.add({ from: "src/a.ts", to: "src/b.ts", note: "same", kind: "ai", author: "agent" });
    const second = store.add({ from: "src/a.ts", to: "src/b.ts", note: "same", kind: "ai", author: "agent" });
    expect(second.id).toBe(first.id);
    expect(store.read().annotations).toHaveLength(1);
  });

  it("rejects self-links, empty notes, and out-of-workspace paths", () => {
    expect(() => store.add({ from: "src/a.ts", to: "src/a.ts", note: "x", kind: "ai", author: "agent" })).toThrow(/different files/);
    expect(() => store.add({ from: "src/a.ts", to: "src/b.ts", note: "   ", kind: "ai", author: "agent" })).toThrow(/note/);
    expect(() => store.add({ from: "../outside.ts", to: "src/b.ts", note: "x", kind: "ai", author: "agent" })).toThrow(/workspace/i);
  });

  it("rejects links to unknown files when a node lookup is set", () => {
    store.setNodeLookup(() => new Set(["src/a.ts", "src/b.ts"]));
    expect(() => store.add({ from: "src/a.ts", to: "src/missing.ts", note: "x", kind: "ai", author: "agent" })).toThrow(/Codebase Map/);
  });

  it("remove() deletes by id and reports misses", () => {
    const added = store.add({ from: "src/a.ts", to: "src/b.ts", note: "n", kind: "ai", author: "agent" });
    expect(store.remove("nope")).toBe(false);
    expect(store.remove(added.id)).toBe(true);
    expect(store.read().annotations).toHaveLength(0);
  });

  it("recovers from malformed JSON with the default document", () => {
    fs.writeFileSync(store.filePath(), "{not json", "utf8");
    expect(store.read()).toEqual({ schemaVersion: 1, updatedAt: null, annotations: [] });
  });

  it("fires onDidChange on writes", () => {
    let fired = 0;
    store.onDidChange(() => { fired += 1; });
    store.add({ from: "src/a.ts", to: "src/b.ts", note: "n", kind: "ai", author: "agent" });
    expect(fired).toBe(1);
  });
});

describe("GraphAnnotationStore.dispatch (map_link* tools)", () => {
  it("link/list/remove round-trip with ok results", async () => {
    const linked = await store.dispatch("link", { from: "src/a.ts", to: "src/b.ts", note: "handler triggers service" }, { sessionId: "s9" });
    expect(linked.ok).toBe(true);
    const link = linked.link as { id: string; sessionId?: string };
    expect(link.sessionId).toBe("s9");

    const listed = await store.dispatch("list", {}, { sessionId: "s9" });
    expect((listed.links as unknown[]).length).toBe(1);

    const filtered = await store.dispatch("list", { path: "src/unrelated.ts" }, { sessionId: "s9" });
    expect((filtered.links as unknown[]).length).toBe(0);

    const removed = await store.dispatch("remove", { linkId: link.id }, { sessionId: "s9" });
    expect(removed.ok).toBe(true);
  });

  it("returns ok:false errors instead of throwing", async () => {
    const bad = await store.dispatch("link", { from: "src/a.ts", to: "src/a.ts", note: "x" }, { sessionId: "s" });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/different files/);
    const unknown = await store.dispatch("wat", {}, { sessionId: "s" });
    expect(unknown.ok).toBe(false);
    const missing = await store.dispatch("remove", { linkId: "zz" }, { sessionId: "s" });
    expect(missing.ok).toBe(false);
  });
});
