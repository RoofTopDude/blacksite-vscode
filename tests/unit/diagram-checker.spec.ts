import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagramChecker } from "../../src/diagrams/diagram-checker.js";

/* The host-side client against the real worker bundle (out/diagram-check-worker.js) and the
   real Mermaid build. The worker is a build artifact, so this skips on a checkout that has not
   run `npm run build`, like the other specs that check what ships. */

const workerScript = path.resolve("out", "diagram-check-worker.js");
const library = path.resolve("out", "markdown-preview", "mermaid.min.js");
const built = fs.existsSync(workerScript) && fs.existsSync(library);

let checker: DiagramChecker | undefined;
afterEach(() => { checker?.dispose(); checker = undefined; });

describe.skipIf(!built)("DiagramChecker with the built worker", () => {
  it("checks a valid diagram", async () => {
    checker = new DiagramChecker(workerScript, library);
    expect(await checker.check("flowchart TD\n  A --> B")).toMatchObject({ ok: true, checked: true, diagramType: "flowchart-v2" });
  }, 30_000);

  it("reports the parser's line for an invalid one, and keeps working afterwards", async () => {
    checker = new DiagramChecker(workerScript, library);
    const bad = await checker.check("flowchart TD\n  A --> B\n  C --> --> D");
    expect(bad).toMatchObject({ ok: false, checked: true, line: 3 });
    expect(await checker.check("pie\n \"a\" : 1")).toMatchObject({ ok: true, checked: true });
  }, 30_000);

  it("answers several checks at once, each with its own result", async () => {
    checker = new DiagramChecker(workerScript, library);
    const results = await Promise.all([
      checker.check("flowchart TD\n  A --> B"),
      checker.check("flowchart TD\n  A[unclosed"),
      checker.check("sequenceDiagram\n  A->>B: hi"),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
  }, 30_000);

  it("starts again after being disposed", async () => {
    checker = new DiagramChecker(workerScript, library);
    await checker.check("flowchart TD\n  A --> B");
    checker.dispose();
    expect(await checker.check("flowchart TD\n  A --> B")).toMatchObject({ ok: true, checked: true });
  }, 30_000);
});

describe("DiagramChecker without a usable worker", () => {
  it("says it could not check, rather than calling the diagram invalid", async () => {
    checker = new DiagramChecker(path.resolve("out", "no-such-worker.js"), library);
    const result = await checker.check("flowchart TD\n  A --> B");
    expect(result).toMatchObject({ ok: true, checked: false });
    expect(result.note).toMatch(/not part of this build/);
  });

  it("says so when Mermaid's library is missing too", async () => {
    checker = new DiagramChecker(workerScript, path.resolve("out", "no-such-library.js"));
    expect(await checker.check("flowchart TD\n  A --> B")).toMatchObject({ ok: true, checked: false });
  });
});
