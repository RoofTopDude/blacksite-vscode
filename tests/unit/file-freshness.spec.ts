import { describe, expect, it } from "vitest";
import {
  FileFreshnessLedger,
  freshnessWarning,
  writtenPathsFromResult,
} from "../../src/file-freshness.js";

/* The scenario this guards: within ONE execution the agent edits a file, then
   comes back to it later. Reads already show the change (edits are saved to
   disk before the tool returns), and anchored edits fail safely on a stale
   copy — what was missing is the agent being told so, and the one operation
   that can silently discard its own earlier work. */

const ROOT = "c:/ws";

function ledger(): FileFreshnessLedger {
  return new FileFreshnessLedger(ROOT);
}

const editInput = (path: string) => ({ path, oldString: "a", newString: "b" });

describe("FileFreshnessLedger", () => {
  it("reports nothing for a file the session has never touched", () => {
    const led = ledger();
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toEqual([]);
    expect(led.changedThisSession("src/a.ts")).toBe(false);
  });

  it("marks a file stale once the session edits it", () => {
    const led = ledger();
    led.record("file_edit", editInput("src/a.ts"), true);
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toEqual([
      { path: "src/a.ts", tool: "file_edit" },
    ]);
    expect(led.changedThisSession("src/a.ts")).toBe(true);
  });

  it("clears staleness once the agent re-reads the file", () => {
    const led = ledger();
    led.record("file_edit", editInput("src/a.ts"), true);
    led.record("file_read", { path: "src/a.ts" }, true);
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toEqual([]);
  });

  it("goes stale again when the agent edits after re-reading", () => {
    const led = ledger();
    led.record("file_edit", editInput("src/a.ts"), true);
    led.record("file_read", { path: "src/a.ts" }, true);
    led.record("file_edit", editInput("src/a.ts"), true);
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toHaveLength(1);
  });

  it("ignores calls that failed — they changed and refreshed nothing", () => {
    const led = ledger();
    led.record("file_edit", editInput("src/a.ts"), false);
    expect(led.changedThisSession("src/a.ts")).toBe(false);

    led.record("file_edit", editInput("src/a.ts"), true);
    led.record("file_read", { path: "src/a.ts" }, false);
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toHaveLength(1);
  });

  /* file_read reports an absolute path while file_edit reports the relative one
     it was handed. Keyed naively they are two different files and the ledger
     silently never matches. */
  it("treats absolute and workspace-relative references as the same file", () => {
    const led = ledger();
    led.record("file_edit", editInput("src/a.ts"), true);
    expect(led.staleTargets("file_write", { path: "c:/ws/src/a.ts" })).toHaveLength(1);

    led.record("file_read", { path: "c:/ws/src/a.ts" }, true);
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toEqual([]);
  });

  it("matches case-insensitively and across path separators, as the filesystem does", () => {
    const led = ledger();
    led.record("file_edit", editInput("src/App.ts"), true);
    expect(led.staleTargets("file_write", { path: "src\\app.ts" })).toHaveLength(1);
  });

  it("tracks the per-file target of code_insert / code_replace, which nest it under `target`", () => {
    const led = ledger();
    led.record("code_replace", { target: { path: "src/a.ts" }, newText: "x" }, true);
    expect(led.changedThisSession("src/a.ts")).toBe(true);
  });

  it("tracks every file in a batch edit", () => {
    const led = ledger();
    led.record("file_edit_batch", { edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }, true);
    expect(led.changedThisSession("src/a.ts")).toBe(true);
    expect(led.changedThisSession("src/b.ts")).toBe(true);
  });

  it("does not treat a shell command's cwd as touching files", () => {
    const led = ledger();
    led.record("shell_run", { command: "npm", cwd: "src" }, true);
    expect(led.changedThisSession("src")).toBe(false);
  });

  it("records a subagent lane's edit, which invalidates the parent's copy too", () => {
    const led = ledger();
    led.recordWriteFromResult("file_edit", { ok: true, path: "src/a.ts" });
    expect(led.staleTargets("file_write", { path: "src/a.ts" })).toEqual([
      { path: "src/a.ts", tool: "file_edit" },
    ]);
  });
});

describe("writtenPathsFromResult", () => {
  it("prefers relativePath, since file_write reports an absolute path too", () => {
    expect(writtenPathsFromResult("file_write", {
      ok: true, path: "c:/ws/src/a.ts", relativePath: "src/a.ts",
    })).toEqual(["src/a.ts"]);
  });

  it("falls back to path when that is all the tool reports", () => {
    expect(writtenPathsFromResult("file_edit", { ok: true, path: "src/a.ts" })).toEqual(["src/a.ts"]);
  });

  it("reads per-file rows out of a batch result", () => {
    expect(writtenPathsFromResult("file_edit_batch", {
      ok: true, results: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    })).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores failed results and non-mutating tools", () => {
    expect(writtenPathsFromResult("file_edit", { ok: false, path: "src/a.ts" })).toEqual([]);
    expect(writtenPathsFromResult("file_read", { ok: true, path: "src/a.ts" })).toEqual([]);
  });
});

describe("freshnessWarning", () => {
  const stale = [{ path: "src/a.ts", tool: "file_edit" }];

  it("says nothing when the file is not stale", () => {
    expect(freshnessWarning("file_write", { path: "src/a.ts" }, true, [], "")).toBeUndefined();
  });

  /* The one genuine data-loss path: a whole-file write has no anchor text, so
     rewriting from a pre-edit copy discards the session's own earlier change. */
  it("warns on a whole-file overwrite of a file changed but not re-read", () => {
    const warning = freshnessWarning("file_write", { path: "src/a.ts" }, true, stale, "");
    expect(warning).toContain("src/a.ts");
    expect(warning).toContain("file_edit");
    expect(warning).toMatch(/replaces that content outright/);
  });

  it("does not warn when the same write is an append", () => {
    expect(freshnessWarning("file_write", { path: "src/a.ts", mode: "append" }, true, stale, "")).toBeUndefined();
  });

  it("warns that a positional insert may have moved", () => {
    const warning = freshnessWarning("code_insert", { target: { path: "src/a.ts" } }, true, stale, "");
    expect(warning).toMatch(/positional/);
  });

  /* Anchored edits are the normal way to make several changes to one file and
     verify their own text, so a notice on each would drown the ones above. */
  it("stays silent on a successful anchored edit", () => {
    expect(freshnessWarning("file_edit", { path: "src/a.ts" }, true, stale, "")).toBeUndefined();
    expect(freshnessWarning("file_edit_batch", { edits: [] }, true, stale, "")).toBeUndefined();
    expect(freshnessWarning("json_edit", { path: "src/a.ts" }, true, stale, "")).toBeUndefined();
  });

  it("explains an anchor miss on a file the session already changed", () => {
    const warning = freshnessWarning(
      "file_edit", { path: "src/a.ts" }, false, stale,
      "oldString was not found in src/a.ts (also tried EOL-converted...)",
    );
    expect(warning).toMatch(/already changed/);
    expect(warning).toMatch(/file_read/);
  });

  it("explains an ambiguous-match failure the same way", () => {
    const warning = freshnessWarning(
      "file_edit", { path: "src/a.ts" }, false, stale,
      "oldString matches 3 locations in src/a.ts.",
    );
    expect(warning).toMatch(/already changed/);
  });

  it("does not blame staleness for an unrelated failure", () => {
    expect(freshnessWarning("file_edit", { path: "src/a.ts" }, false, stale, "path is required.")).toBeUndefined();
  });
});

/* End-to-end shape of the scenario in the request: edit, come back later,
   get told the copy is old — then stop being told once it is re-read. */
describe("edit → return-to-file, within one execution", () => {
  it("warns on the second visit and goes quiet after a re-read", () => {
    const led = ledger();

    led.record("file_edit", editInput("src/a.ts"), true);

    const beforeReread = led.staleTargets("file_write", { path: "src/a.ts" });
    expect(freshnessWarning("file_write", { path: "src/a.ts" }, true, beforeReread, "")).toBeDefined();

    led.record("file_read", { path: "src/a.ts" }, true);

    const afterReread = led.staleTargets("file_write", { path: "src/a.ts" });
    expect(freshnessWarning("file_write", { path: "src/a.ts" }, true, afterReread, "")).toBeUndefined();
  });
});
