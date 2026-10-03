import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGRAMS_DIR, DiagramStore, MAX_SAVED_DIAGRAMS } from "../../src/diagrams/diagram-store.js";
import { MAX_DIAGRAM_SOURCE_CHARS } from "../../src/shared/mermaid-source.js";

let root = "";
let store: DiagramStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-diagrams-"));
  store = new DiagramStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const FLOW = "---\ntitle: Request flow\n---\nflowchart TD\n  A --> B";

describe("DiagramStore", () => {
  it("keeps diagrams under .blacksite/context/diagrams as .mmd files", () => {
    const written = store.write("Request Flow", FLOW);
    expect(written).toEqual({ ok: true, name: "request-flow.mmd", file: ".blacksite/context/diagrams/request-flow.mmd", created: true });
    expect(fs.readFileSync(path.join(root, DIAGRAMS_DIR, "request-flow.mmd"), "utf8")).toBe(`${FLOW}\n`);
  });

  it("reads back what it wrote, and lists it with its kind and title", () => {
    store.write("flow", FLOW);
    expect(store.read("flow.mmd")).toMatchObject({ ok: true, source: FLOW });
    expect(store.list()).toEqual([expect.objectContaining({ name: "flow.mmd", kind: "Flowchart", title: "Request flow", lines: 5 })]);
  });

  it("will not replace a diagram unless asked, and keeps the previous version when it does", () => {
    store.write("flow", FLOW);
    expect(store.write("flow", "flowchart TD\n  X --> Y")).toMatchObject({ ok: false });
    expect(store.write("flow", "flowchart TD\n  X --> Y", { overwrite: true })).toMatchObject({ ok: true, created: false });
    expect(fs.readFileSync(path.join(root, DIAGRAMS_DIR, "flow.mmd.bak"), "utf8")).toBe(`${FLOW}\n`);
    expect(store.list().map((entry) => entry.name)).toEqual(["flow.mmd"]); // the .bak is not a diagram
  });

  it("refuses an empty diagram, an oversized one, and a name it cannot use", () => {
    expect(store.write("flow", "   ")).toMatchObject({ ok: false });
    expect(store.write("flow", "x".repeat(MAX_DIAGRAM_SOURCE_CHARS + 1))).toMatchObject({ ok: false });
    expect(store.write("***", FLOW)).toMatchObject({ ok: false });
    expect(store.read("***")).toMatchObject({ ok: false });
  });

  it("cannot be aimed outside its folder", () => {
    expect(store.resolve("../../outside")).toBe(path.join(root, DIAGRAMS_DIR, "outside.mmd"));
    expect(store.nameOf(path.join(root, "src", "a.mmd"))).toBeUndefined();
    expect(store.nameOf(path.join(root, DIAGRAMS_DIR, "..", "x.mmd"))).toBeUndefined();
    expect(store.nameOf(path.join(root, DIAGRAMS_DIR, "nested", "x.mmd"))).toBeUndefined();
    expect(store.nameOf(path.join(root, DIAGRAMS_DIR, "x.mmd"))).toBe("x.mmd");
  });

  it("names a missing diagram helpfully, with what is saved", () => {
    store.write("alpha", FLOW);
    const missing = store.read("beta");
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.error).toMatch(/No saved diagram named "beta.mmd".*alpha.mmd/);
  });

  it("freeName avoids a collision", () => {
    store.write("flow", FLOW);
    expect(store.freeName("flow")).toBe("flow-2.mmd");
    expect(store.freeName("brand new")).toBe("brand-new.mmd");
  });

  it("stops at the saved-diagram limit", () => {
    fs.mkdirSync(path.join(root, DIAGRAMS_DIR), { recursive: true });
    for (let i = 0; i < MAX_SAVED_DIAGRAMS; i += 1) fs.writeFileSync(path.join(root, DIAGRAMS_DIR, `d${i}.mmd`), "flowchart TD\n A --> B\n");
    expect(store.write("one-more", FLOW)).toMatchObject({ ok: false });
    expect(store.write("d1", FLOW, { overwrite: true })).toMatchObject({ ok: true });
  });
});
