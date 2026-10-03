import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramCheck } from "../../src/diagrams/diagram-checker.js";
import { DiagramStore } from "../../src/diagrams/diagram-store.js";
import { DiagramToolService, diagramAdvice, diagramStats } from "../../src/diagrams/diagram-tools.js";

let root = "";
let store: DiagramStore;
let opened: string[];

/** A checker that rejects a diagram containing "BROKEN", naming its line, as Mermaid's would. */
const checker = {
  check: vi.fn(async (source: string): Promise<DiagramCheck> => {
    const at = source.split("\n").findIndex((line) => line.includes("BROKEN"));
    return at >= 0 ? { ok: false, checked: true, error: `Parse error on line ${at + 1}:\nBROKEN`, line: at + 1 } : { ok: true, checked: true, diagramType: "flowchart-v2" };
  }),
};

function service(): DiagramToolService {
  return new DiagramToolService({ store, checker, openInViewer: (file) => { opened.push(file); } });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-diagram-tools-"));
  store = new DiagramStore(root);
  opened = [];
  checker.check.mockClear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const FLOW = "flowchart TD\n  A --> B\n  B --> C";

describe("diagram_save", () => {
  it("parses first and saves only a diagram that parses, leaving nothing behind otherwise", async () => {
    const refused = await service().dispatch("save", { name: "flow", source: "flowchart TD\n  A --> BROKEN" });
    expect(refused).toMatchObject({ ok: false, saved: false, line: 2 });
    expect(refused["context"]).toContain("BROKEN");
    expect(store.list()).toEqual([]);

    const saved = await service().dispatch("save", { name: "flow", source: FLOW });
    expect(saved).toMatchObject({ ok: true, saved: true, created: true, name: "flow.mmd", kind: "Flowchart", lines: 3 });
  });

  it("can stage an invalid diagram on request, and says so", async () => {
    const saved = await service().dispatch("save", { name: "wip", source: "flowchart TD\n  BROKEN", allowInvalid: true });
    expect(saved).toMatchObject({ ok: true, saved: true });
    expect(saved["warning"]).toMatch(/does not parse/);
  });

  it("opens the viewer only when asked", async () => {
    await service().dispatch("save", { name: "a", source: FLOW });
    expect(opened).toEqual([]);
    await service().dispatch("save", { name: "b", source: FLOW, open: true });
    expect(opened).toEqual([path.join(root, ".blacksite", "context", "diagrams", "b.mmd")]);
  });

  it("will not overwrite without being told to", async () => {
    await service().dispatch("save", { name: "a", source: FLOW });
    expect(await service().dispatch("save", { name: "a", source: FLOW })).toMatchObject({ ok: false });
    expect(await service().dispatch("save", { name: "a", source: `${FLOW}\n  C --> D`, overwrite: true })).toMatchObject({ ok: true, created: false });
  });
});

describe("diagram_edit", () => {
  it("patches the saved file and reports what it did", async () => {
    await service().dispatch("save", { name: "flow", source: FLOW });
    const result = await service().dispatch("edit", { name: "flow", edits: [{ find: "B --> C", replace: "B --> C\n  C --> D" }] });
    expect(result).toMatchObject({ ok: true, saved: true, lines: 4, edits: ["Edit 1: replaced 1 occurrence at line 3."] });
    expect(result["undo"]).toContain("flow.mmd.bak");
    expect(store.read("flow")).toMatchObject({ ok: true, source: `${FLOW}\n  C --> D` });
  });

  it("refuses an edit that breaks the diagram, with the line and an excerpt, and changes nothing", async () => {
    await service().dispatch("save", { name: "flow", source: FLOW });
    const result = await service().dispatch("edit", { name: "flow", edits: [{ find: "A --> B", replace: "A --> BROKEN" }] });
    expect(result).toMatchObject({ ok: false, saved: false, line: 2 });
    expect(result["context"]).toContain("A --> BROKEN");
    expect(store.read("flow")).toMatchObject({ source: FLOW });
  });

  it("reports an edit that does not match, and a diagram that is not saved", async () => {
    await service().dispatch("save", { name: "flow", source: FLOW });
    expect(await service().dispatch("edit", { name: "flow", edits: [{ find: "nope", replace: "x" }] })).toMatchObject({ ok: false });
    expect(await service().dispatch("edit", { name: "ghost", edits: [{ find: "a", replace: "b" }] })).toMatchObject({ ok: false });
    expect(await service().dispatch("edit", { name: "flow", edits: [] })).toMatchObject({ ok: false });
    expect(await service().dispatch("edit", { name: "flow", edits: "bad" })).toMatchObject({ ok: false });
  });

  it("accepts line numbers the model sends as strings", async () => {
    await service().dispatch("save", { name: "flow", source: FLOW });
    const result = await service().dispatch("edit", { name: "flow", edits: [{ fromLine: "3", replace: "  B --> Z" }] });
    expect(result).toMatchObject({ ok: true });
    expect(store.read("flow")).toMatchObject({ source: "flowchart TD\n  A --> B\n  B --> Z" });
  });

  it("does not hold the file hostage to an unavailable checker", async () => {
    checker.check.mockResolvedValueOnce({ ok: true, checked: false, note: "no worker" });
    const saved = await service().dispatch("save", { name: "flow", source: FLOW });
    expect(saved).toMatchObject({ ok: true, checked: false });
  });
});

describe("diagram_read", () => {
  it("lists saved diagrams, or reads one with line numbers and a continuation hint", async () => {
    expect(await service().dispatch("read", {})).toMatchObject({ ok: true, count: 0, directory: ".blacksite/context/diagrams" });
    const long = `flowchart TD\n${Array.from({ length: 500 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n")}`;
    await service().dispatch("save", { name: "long", source: long });
    expect(await service().dispatch("read", {})).toMatchObject({ count: 1, diagrams: [expect.objectContaining({ name: "long.mmd" })] });

    const page = await service().dispatch("read", { name: "long" });
    expect(page).toMatchObject({ ok: true, totalLines: 501, fromLine: 1, toLine: 400 });
    expect(page["more"]).toMatch(/fromLine: 401/);
    const tail = await service().dispatch("read", { name: "long", fromLine: 495 });
    expect(tail).toMatchObject({ fromLine: 495, toLine: 501 });
    expect(tail["more"]).toBeUndefined();
  });

  it("names the saved diagrams when asked for one that is not there", async () => {
    await service().dispatch("save", { name: "alpha", source: FLOW });
    const missing = await service().dispatch("read", { name: "beta" });
    expect(missing).toMatchObject({ ok: false });
    expect(String(missing["error"])).toContain("alpha.mmd");
  });
});

describe("diagram_check", () => {
  it("checks source or a saved diagram, and reports the line on failure", async () => {
    expect(await service().dispatch("check", { source: FLOW })).toMatchObject({ ok: true, checked: true, kind: "Flowchart", lines: 3 });
    expect(await service().dispatch("check", { source: "flowchart TD\n BROKEN" })).toMatchObject({ ok: false, line: 2 });
    await service().dispatch("save", { name: "flow", source: FLOW });
    expect(await service().dispatch("check", { name: "flow" })).toMatchObject({ ok: true, file: ".blacksite/context/diagrams/flow.mmd" });
    expect(await service().dispatch("check", {})).toMatchObject({ ok: false });
  });

  it("says when it could not verify, rather than calling the diagram fine", async () => {
    checker.check.mockResolvedValueOnce({ ok: true, checked: false, note: "the diagram checker timed out" });
    const result = await service().dispatch("check", { source: FLOW });
    expect(result).toMatchObject({ ok: true, checked: false });
    expect(String(result["note"])).toContain("Not verified");
  });

  it("validates a chart block with the chart parser, not the Mermaid one", async () => {
    const good = JSON.stringify({ type: "bar", x: "w", y: ["a"], data: [{ w: "1", a: 2 }] });
    expect(await service().dispatch("check", { source: good })).toMatchObject({ ok: true, language: "chart", type: "bar", rows: 1 });
    const bad = JSON.stringify({ type: "bar", x: "w", y: ["missing"], data: [{ w: "1", a: 2 }] });
    const result = await service().dispatch("check", { source: bad });
    expect(result).toMatchObject({ ok: false, language: "chart" });
    expect(String(result["error"])).toContain("missing");
    expect(checker.check).not.toHaveBeenCalled();
  });
});

describe("advice", () => {
  const links = (n: number, subgraph = false): string =>
    `flowchart TD\n${subgraph ? "  subgraph S\n    X\n  end\n" : ""}${Array.from({ length: n }, (_, i) => `  N${i} --> N${i + 1}`).join("\n")}`;

  it("counts links and lines", () => {
    expect(diagramStats(links(10))).toMatchObject({ lines: 11, links: 10 });
  });

  it("says nothing about a small diagram", () => {
    expect(diagramAdvice(links(10), "Flowchart")).toEqual([]);
  });

  it("suggests ELK for a flat, dense flowchart but not for one with subgraphs, where it does worse", () => {
    expect(diagramAdvice(links(50), "Flowchart")[0]).toMatch(/layout: elk/);
    const nested = diagramAdvice(links(50, true), "Flowchart")[0]!;
    expect(nested).toMatch(/subgraph/);
    expect(nested).not.toMatch(/layout: elk/);
  });

  it("does not suggest ELK again once it is on, and suggests splitting a very large one", () => {
    expect(diagramAdvice(`---\nconfig:\n  layout: elk\n---\n${links(50)}`, "Flowchart")).toEqual([]);
    expect(diagramAdvice(links(200), "Flowchart").join(" ")).toMatch(/Split it/);
  });
});
