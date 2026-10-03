import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagramChecker } from "../../src/diagrams/diagram-checker.js";
import { DiagramStore } from "../../src/diagrams/diagram-store.js";
import { DiagramToolService } from "../../src/diagrams/diagram-tools.js";

/* The workflow the diagram tools exist for, with nothing faked: a large flowchart is saved,
   then changed by small edits, and a bad edit is caught by Mermaid's real parser. Needs the
   built worker, so it skips on a checkout that has not run `npm run build`. */

const workerScript = path.resolve("out", "diagram-check-worker.js");
const library = path.resolve("out", "markdown-preview", "mermaid.min.js");
const built = fs.existsSync(workerScript) && fs.existsSync(library);

let root = "";
let checker: DiagramChecker;
let tools: DiagramToolService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-real-tools-"));
  checker = new DiagramChecker(workerScript, library);
  tools = new DiagramToolService({ store: new DiagramStore(root), checker });
});
afterEach(() => {
  checker.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Six subsystems of eight steps, chained, with cross-links: about 70 nodes and 80 edges. */
function largeFlowchart(): string {
  const systems = ["Chat", "Agent", "Tools", "Store", "Map", "Plans"];
  const lines = ["flowchart TD"];
  for (const system of systems) {
    lines.push(`  subgraph ${system}["${system}"]`);
    for (let n = 0; n < 8; n += 1) lines.push(`    ${system}${n}["${system} ${n}"]`);
    for (let n = 0; n < 7; n += 1) lines.push(`    ${system}${n} --> ${system}${n + 1}`);
    lines.push("  end");
  }
  systems.forEach((from, i) => lines.push(`  ${from}7 --> ${systems[(i + 1) % systems.length]}0`));
  return lines.join("\n");
}

describe.skipIf(!built)("editing a large diagram with the real parser", () => {
  it("saves it, patches one node and one link, and leaves the rest untouched", async () => {
    const source = largeFlowchart();
    const saved = await tools.dispatch("save", { name: "system", source });
    expect(saved).toMatchObject({ ok: true, checked: true, kind: "Flowchart" });

    const edited = await tools.dispatch("edit", {
      name: "system",
      edits: [
        { find: "Tools3[\"Tools 3\"]", replace: "Tools3[\"Tools 3 (approval gate)\"]" },
        { afterLine: 1, insert: "  classDef hot fill:#d95926,color:#0d0d0f" },
      ],
    });
    expect(edited).toMatchObject({ ok: true, saved: true, checked: true });
    const read = await tools.dispatch("read", { name: "system", fromLine: 1, toLine: 3 });
    expect(String(read["lines"])).toContain("classDef hot");

    const whole = await tools.dispatch("read", { name: "system", fromLine: 1, toLine: 400 });
    expect(String(whole["lines"])).toContain("Tools 3 (approval gate)");
    expect(String(whole["lines"])).toContain("Chat7 --> Agent0"); // untouched
  }, 60_000);

  it("refuses an edit that breaks it, names the line, and leaves the file as it was", async () => {
    await tools.dispatch("save", { name: "system", source: largeFlowchart() });
    const broken = await tools.dispatch("edit", { name: "system", edits: [{ find: "Chat0 --> Chat1", replace: "Chat0 --> --> Chat1" }] });
    expect(broken).toMatchObject({ ok: false, saved: false });
    expect(typeof broken["line"]).toBe("number");
    expect(String(broken["context"])).toContain("--> -->");

    const check = await tools.dispatch("check", { name: "system" });
    expect(check).toMatchObject({ ok: true, checked: true });
    const after = await tools.dispatch("read", { name: "system", fromLine: 1, toLine: 400 });
    expect(String(after["lines"])).not.toContain("--> -->");
  }, 60_000);

  it("advises against ELK for subgraphs, and for ELK on a flat graph", async () => {
    const nested = await tools.dispatch("check", { source: `${largeFlowchart()}\n${Array.from({ length: 40 }, (_, i) => `  Extra${i} --> Extra${i + 1}`).join("\n")}` });
    expect(nested["advice"]).toEqual([expect.stringMatching(/subgraphs/)]);

    const flat = `flowchart LR\n${Array.from({ length: 60 }, (_, i) => `  N${i} --> N${(i * 7 + 3) % 60}`).join("\n")}`;
    expect(await tools.dispatch("check", { source: flat })).toMatchObject({ ok: true, advice: [expect.stringMatching(/layout: elk/)] });
    expect(await tools.dispatch("check", { source: `---\nconfig:\n  layout: elk\n---\n${flat}` })).toMatchObject({ ok: true });
  }, 60_000);
});
