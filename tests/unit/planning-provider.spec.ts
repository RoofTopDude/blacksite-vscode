import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PlanningProvider } from "../../src/planning-provider.js";
import { PlanningStore } from "../../src/planning-store.js";
import { buildWorkspaceRoots } from "../../src/graph/workspace-roots.js";

/* A phase's `files` are documented — and prompted for — as Codebase Map node
   ids. The Map folder-qualifies those as soon as a second workspace folder is
   open, so resolving them against the first folder alone breaks every "open
   this file" chip in a multi-root workspace. These tests pin both dialects. */

let tmp: string;
let folderA: string;
let folderB: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-plan-provider-"));
  folderA = path.join(tmp, "app-one");
  folderB = path.join(tmp, "app-two");
  fs.mkdirSync(path.join(folderA, "src"), { recursive: true });
  fs.mkdirSync(path.join(folderB, "src"), { recursive: true });
  fs.writeFileSync(path.join(folderA, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(folderB, "src", "b.ts"), "export const b = 2;\n");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function provider(roots: Array<{ name: string; path: string }>): PlanningProvider {
  const store = new PlanningStore(folderA);
  return new PlanningProvider(
    {} as never,
    store,
    folderA,
    () => buildWorkspaceRoots(roots),
  );
}

/** `_resolvePhaseFile` is the whole decision this test cares about; going
 *  through the webview message plumbing would only test the mock. */
function resolve(instance: PlanningProvider, raw: string): string | null {
  return (instance as unknown as { _resolvePhaseFile(value: string): string | null })._resolvePhaseFile(raw);
}

describe("PlanningProvider phase-file resolution", () => {
  it("opens a plain relative id in a single-folder workspace", () => {
    const single = provider([{ name: "app-one", path: folderA }]);
    expect(resolve(single, "src/a.ts")).toBe(path.resolve(folderA, "src/a.ts"));
  });

  it("opens a folder-qualified map id in a multi-root workspace", () => {
    const multi = provider([{ name: "app-one", path: folderA }, { name: "app-two", path: folderB }]);
    expect(resolve(multi, "app-one/src/a.ts")).toBe(path.resolve(folderA, "src/a.ts"));
  });

  it("opens a file living in a folder other than the first", () => {
    const multi = provider([{ name: "app-one", path: folderA }, { name: "app-two", path: folderB }]);
    expect(resolve(multi, "app-two/src/b.ts")).toBe(path.resolve(folderB, "src/b.ts"));
  });

  it("still resolves a plain relative id written before a second folder was added", () => {
    const multi = provider([{ name: "app-one", path: folderA }, { name: "app-two", path: folderB }]);
    expect(resolve(multi, "src/a.ts")).toBe(path.resolve(folderA, "src/a.ts"));
  });

  it("refuses to climb out of the workspace", () => {
    const multi = provider([{ name: "app-one", path: folderA }, { name: "app-two", path: folderB }]);
    expect(resolve(multi, "../../../etc/passwd")).toBeNull();
    expect(resolve(multi, "app-one/../../escape.ts")).toBeNull();
  });

  it("returns null for a declared file that isn't on disk", () => {
    const single = provider([{ name: "app-one", path: folderA }]);
    expect(resolve(single, "src/missing.ts")).toBeNull();
  });

  it("returns null for a directory, which has no editor tab to open", () => {
    const single = provider([{ name: "app-one", path: folderA }]);
    expect(resolve(single, "src")).toBeNull();
  });
});
