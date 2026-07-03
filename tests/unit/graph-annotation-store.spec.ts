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
    expect(store.read()).toEqual({ schemaVersion: 1, updatedAt: null, annotations: [] });
  });

  it("fires onDidChange on writes", () => {
    let fired = 0;
    store.onDidChange(() => { fired += 1; });
    store.add({ from: "src/a.ts", to: "src/b.ts", note: "n", kind: "ai", author: "agent" });
    expect(fired).toBe(1);
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
