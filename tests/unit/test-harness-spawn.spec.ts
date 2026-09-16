import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression for the Windows test.run breakage: npx/vitest/jest resolve to a `.cmd` shim on
// Windows, and Node refuses to spawn a batch shim without `shell: true` (spawn EINVAL/ENOENT —
// the same CVE-2024-27980 hardening `security.ts`'s `planSpawn` exists to route around). Before
// the fix, test-harness.ts called `spawnSync("npx", ...)` directly and never checked
// `res.error`, so this failure was silently misreported as "Could not parse structured test
// output" instead of a diagnosable "could not start npx" — see test-harness.ts's `_spawnRunner`.
const spawnSyncMock = vi.fn();
vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const { runTests } = await import("../../packages/local-runtime/src/test-harness.js");

function mkTempProjectWith(file: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-test-harness-"));
  fs.writeFileSync(path.join(dir, file), "");
  return dir;
}

describe("runTests spawn-failure handling", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    spawnSyncMock.mockReset();
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a clear error instead of 'could not parse' when npx fails to spawn", () => {
    const dir = mkTempProjectWith("vitest.config.ts");
    tempDirs.push(dir);
    const enoent = Object.assign(new Error("spawn npx.cmd ENOENT"), { code: "ENOENT" });
    spawnSyncMock.mockReturnValue({ error: enoent, stdout: null, stderr: null, status: null, signal: null });

    const result = runTests(dir);

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.message).toContain('Could not start "npx"');
    expect(result.failures[0]?.message).not.toContain("Could not parse structured test output");
  });

  it("falls back from python to python3 when python is not on PATH", () => {
    const dir = mkTempProjectWith("pytest.ini");
    tempDirs.push(dir);
    const enoent = Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" });
    spawnSyncMock
      .mockReturnValueOnce({ error: enoent, stdout: null, stderr: null, status: null, signal: null })
      .mockReturnValueOnce({ error: null, stdout: "2 passed", stderr: "", status: 0, signal: null });

    const result = runTests(dir);

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(2);
  });

  it("reports a clear error when neither python nor python3 is on PATH", () => {
    const dir = mkTempProjectWith("pytest.ini");
    tempDirs.push(dir);
    const enoent = Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" });
    spawnSyncMock.mockReturnValue({ error: enoent, stdout: null, stderr: null, status: null, signal: null });

    const result = runTests(dir);

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.message).toContain('Could not start "python3"');
  });
});
