import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphAnnotationStore } from "../../src/graph-annotation-store.js";
import { buildWorkspaceRoots, type WorkspaceRoot } from "../../src/graph/workspace-roots.js";

let root: string;
let roots: WorkspaceRoot[];
let store: GraphAnnotationStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-annotations-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export {};", "utf8");
  roots = buildWorkspaceRoots([{ name: "ws", path: root }]);
  store = new GraphAnnotationStore(() => roots);
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

    const reloaded = new GraphAnnotationStore(() => roots).read();
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
    expect(store.read()).toEqual({ schemaVersion: 2, updatedAt: null, annotations: [] });
  });

  it("fires onDidChange on writes", () => {
    let fired = 0;
    store.onDidChange(() => { fired += 1; });
    store.add({ from: "src/a.ts", to: "src/b.ts", note: "n", kind: "ai", author: "agent" });
    expect(fired).toBe(1);
  });

  it("creates a node-scoped note when `to` is omitted", () => {
    const added = store.add({ from: "src/a.ts", note: "entry point for the CLI", kind: "ai", author: "agent" });
    expect(added.scope).toBe("node");
    expect(added.to).toBeUndefined();
    expect(store.list("src/a.ts")).toHaveLength(1);
  });

  it("migrates a schema v1 document by inferring scope: edge", () => {
    fs.writeFileSync(store.filePath(), JSON.stringify({
      schemaVersion: 1,
      updatedAt: null,
      annotations: [{
        id: "gl_old", from: "src/a.ts", to: "src/b.ts", kind: "ai", author: "agent", note: "legacy",
        createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
      }],
    }), "utf8");
    const doc = store.read();
    expect(doc.annotations).toHaveLength(1);
    expect(doc.annotations[0]).toMatchObject({ scope: "edge", from: "src/a.ts", to: "src/b.ts", note: "legacy" });
  });

  it("update() merges new text and keeps a bounded history", () => {
    const added = store.add({ from: "src/a.ts", to: "src/b.ts", note: "v1", kind: "ai", author: "agent" });
    let current = added;
    for (let i = 2; i <= 8; i += 1) {
      current = store.update({ id: added.id, note: `v${i}` });
    }
    expect(current.note).toBe("v8");
    expect(current.history).toHaveLength(5);
    expect(current.history?.[0]?.note).toBe("v7"); // most recently displaced text first
  });
});

describe("GraphAnnotationStore — multi-root workspace", () => {
  let rootB: string;
  let multiRoots: WorkspaceRoot[];
  let multiStore: GraphAnnotationStore;

  beforeEach(() => {
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), "graph-annotations-b-"));
    fs.mkdirSync(path.join(rootB, "lib"), { recursive: true });
    fs.writeFileSync(path.join(rootB, "lib", "c.ts"), "export {};", "utf8");
    multiRoots = buildWorkspaceRoots([
      { name: "app-one", path: root },
      { name: "app-two", path: rootB },
    ]);
    multiStore = new GraphAnnotationStore(() => multiRoots);
    multiStore.ensureInitialized();
  });

  afterEach(() => {
    multiStore.dispose();
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it("folder-qualifies ids so a link can span two workspace folders", () => {
    const added = multiStore.add({ from: "app-one/src/a.ts", to: "app-two/lib/c.ts", note: "cross-root", kind: "ai", author: "agent" });
    expect(added.from).toBe("app-one/src/a.ts");
    expect(added.to).toBe("app-two/lib/c.ts");
  });

  it("accepts an absolute path under the second root", () => {
    const absoluteC = path.join(rootB, "lib", "c.ts");
    const added = multiStore.add({ from: "app-one/src/a.ts", to: absoluteC, note: "abs path", kind: "ai", author: "agent" });
    expect(added.to).toBe("app-two/lib/c.ts");
  });

  it("defaults an unqualified relative path to the first root", () => {
    const added = multiStore.add({ from: "src/a.ts", to: "app-two/lib/c.ts", note: "default root", kind: "ai", author: "agent" });
    expect(added.from).toBe("app-one/src/a.ts");
  });

  it("rejects a path under an unknown folder prefix once a node lookup is set", () => {
    multiStore.setNodeLookup(() => new Set(["app-one/src/a.ts", "app-two/lib/c.ts"]));
    expect(() => multiStore.add({ from: "app-one/src/a.ts", to: "nope/lib/c.ts", note: "x", kind: "ai", author: "agent" })).toThrow(/Codebase Map/);
  });

  it("rejects a traversal escape even with a folder prefix", () => {
    expect(() => multiStore.add({ from: "app-one/src/a.ts", to: "app-two/../../../etc/passwd", note: "x", kind: "ai", author: "agent" })).toThrow(/workspace/i);
  });
});

describe("GraphAnnotationStore.dispatch (map_note_* tools)", () => {
  it("add/list/update/remove round-trip with ok results", async () => {
    const added = await store.dispatch("add", { from: "src/a.ts", to: "src/b.ts", note: "handler triggers service" }, { sessionId: "s9" });
    expect(added.ok).toBe(true);
    const note = added.note as { id: string; sessionId?: string; note: string };
    expect(note.sessionId).toBe("s9");

    const listed = await store.dispatch("list", {}, { sessionId: "s9" });
    expect((listed.notes as unknown[]).length).toBe(1);

    const filtered = await store.dispatch("list", { path: "src/unrelated.ts" }, { sessionId: "s9" });
    expect((filtered.notes as unknown[]).length).toBe(0);

    const updated = await store.dispatch("update", { id: note.id, note: "refined explanation" }, { sessionId: "s9" });
    expect(updated.ok).toBe(true);
    expect((updated.note as { note: string }).note).toBe("refined explanation");

    const removed = await store.dispatch("remove", { id: note.id }, { sessionId: "s9" });
    expect(removed.ok).toBe(true);
  });

  it("returns ok:false errors instead of throwing", async () => {
    const bad = await store.dispatch("add", { from: "src/a.ts", to: "src/a.ts", note: "x" }, { sessionId: "s" });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/different files/);
    const unknown = await store.dispatch("wat", {}, { sessionId: "s" });
    expect(unknown.ok).toBe(false);
    const missing = await store.dispatch("remove", { id: "zz" }, { sessionId: "s" });
    expect(missing.ok).toBe(false);
  });

  it("still accepts the legacy 'link' op and linkId field for in-flight sessions", async () => {
    const linked = await store.dispatch("link", { from: "src/a.ts", to: "src/b.ts", note: "legacy path" }, { sessionId: "s9" });
    expect(linked.ok).toBe(true);
    const note = linked.note as { id: string };
    const removed = await store.dispatch("remove", { linkId: note.id }, { sessionId: "s9" });
    expect(removed.ok).toBe(true);
  });
});
