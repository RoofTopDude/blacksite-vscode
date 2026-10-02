import { describe, expect, it } from "vitest";
import { outstandingFiles, recordCheck, recordMutation, withoutFiles } from "../../src/agent/verification-ledger.js";
import type { VerificationGateState } from "../../src/session-state.js";

const idle: VerificationGateState = { status: "idle", files: [] };
const none = { passed: [], failed: [], unchecked: [] };

function edited(...files: string[]): VerificationGateState {
  return recordMutation(idle, files, [], 1)!;
}

describe("verification ledger", () => {
  it("owes a check for every changed file", () => {
    const state = edited("a/x.py", "b/y.py");
    expect(state).toMatchObject({ status: "pending", files: ["a/x.py", "b/y.py"], pendingFiles: ["a/x.py", "b/y.py"] });
  });

  it("settles only the files a check covered", () => {
    const state = recordCheck(edited("a/x.py", "b/y.py"), { ...none, passed: ["a/x.py"] }, "tests", "2 tests passed.", 2)!;
    expect(state.status).toBe("pending");
    expect(outstandingFiles(state)).toEqual(["b/y.py"]);
    expect(state.files).toEqual(["a/x.py", "b/y.py"]);
  });

  it("passes once every file is covered", () => {
    let state = recordCheck(edited("a/x.py", "b/y.py"), { ...none, passed: ["a/x.py"] }, "tests", "ok", 2)!;
    state = recordCheck(state, { ...none, passed: ["b/y.py"] }, "tests", "ok", 3)!;
    expect(state.status).toBe("passed");
    expect(outstandingFiles(state)).toEqual([]);
  });

  it("fails only the files a failing check covered", () => {
    const state = recordCheck(edited("a/x.py", "b/y.py"), { ...none, failed: ["a/x.py"] }, "tests", "1 tests failed.", 2)!;
    expect(state).toMatchObject({ status: "failed", failedFiles: ["a/x.py"], pendingFiles: ["a/x.py", "b/y.py"] });
  });

  it("clears a failure when the file is fixed and checked again", () => {
    let state = recordCheck(edited("a/x.py"), { ...none, failed: ["a/x.py"] }, "tests", "failed", 2)!;
    state = recordMutation(state, ["a/x.py"], [], 3)!;
    expect(state).toMatchObject({ status: "pending", failedFiles: [] });
    state = recordCheck(state, { ...none, passed: ["a/x.py"] }, "tests", "ok", 4)!;
    expect(state.status).toBe("passed");
  });

  it("sets aside a file no checker covers, and skips when nothing could be verified", () => {
    const state = recordCheck(edited("deploy/values.yaml"), { ...none, unchecked: ["deploy/values.yaml"] }, "diagnostics", "n/a", 2)!;
    expect(state.status).toBe("skipped");
    expect(state.uncheckedFiles).toEqual(["deploy/values.yaml"]);
    expect(state.detail).toContain("No checker covers deploy/values.yaml");
  });

  it("passes a mixed set once the checkable files are verified", () => {
    let state = recordCheck(edited("a/x.py", "deploy/values.yaml"), { ...none, unchecked: ["deploy/values.yaml"] }, "diagnostics", "n/a", 2)!;
    state = recordCheck(state, { ...none, passed: ["a/x.py"] }, "tests", "ok", 3)!;
    expect(state.status).toBe("passed");
  });

  it("ignores a check that covered none of the owed files", () => {
    expect(recordCheck(edited("a/x.py"), { ...none, passed: ["c/z.py"] }, "tests", "ok", 2)).toBeNull();
  });

  it("returns null when a mutation leaves nothing owed", () => {
    const state = edited("tmp.mjs");
    expect(recordMutation(state, [], ["tmp.mjs"], 2)).toBeNull();
  });

  it("reads state saved before per-file tracking", () => {
    const legacy: VerificationGateState = { status: "failed", files: ["a/x.py", "b/y.py"], detail: "1 tests failed." };
    expect(outstandingFiles(legacy)).toEqual(["a/x.py", "b/y.py"]);
    const state = recordCheck(legacy, { ...none, passed: ["a/x.py", "b/y.py"] }, "tests", "ok", 2)!;
    expect(state.status).toBe("passed");
  });

  it("drops files from the episode entirely", () => {
    const state = withoutFiles(edited("a/x.py", "tmp.mjs"), ["tmp.mjs"], 2);
    expect(state.files).toEqual(["a/x.py"]);
    expect(outstandingFiles(state)).toEqual(["a/x.py"]);
  });
});
