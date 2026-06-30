import { describe, expect, it, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  planSpawn,
  classifyOperation,
  isAllowedCommand,
  validateArgs,
} from "../../../../packages/local-runtime/src/security.js";
import { searchFiles } from "../../../../packages/local-runtime/src/file-ops.js";

describe("planSpawn — Windows shim handling (fixes npx.cmd spawn EINVAL flail)", () => {
  it("routes a model-supplied .cmd shim through the shell as the bare name", () => {
    const plan = planSpawn("npx.cmd", ["--yes", "serve", "."], "win32");
    expect(plan.shell).toBe(true);
    expect(plan.command.startsWith("npx ")).toBe(true);
    expect(plan.command).not.toContain(".cmd");
  });

  it("spawns explicit .exe binaries directly", () => {
    const plan = planSpawn("node.exe", ["x.js"], "win32");
    expect(plan.shell).toBe(false);
    expect(plan.command).toBe("node.exe");
  });

  it("is a passthrough on non-Windows platforms", () => {
    const plan = planSpawn("npx", ["serve"], "linux");
    expect(plan).toEqual({ command: "npx", args: ["serve"], shell: false });
  });
});

describe("command policy — harmless waits and instructive eval blocks", () => {
  it("classifies sleep/timeout as read-tier (no approval prompt, no fight)", () => {
    expect(classifyOperation("sleep", ["2"]).tier).toBe("read");
    expect(classifyOperation("timeout", ["/t", "2"]).tier).toBe("read");
  });

  it("allows sleep through the allowlist", () => {
    expect(isAllowedCommand("sleep")).toBe(true);
  });

  it("blocks node -e but tells the model what to do instead", () => {
    expect(() => validateArgs("node", ["-e", "console.log(1)"]))
      .toThrowError(/Write the snippet to a file/i);
  });
});

describe("searchFiles — accepts a file path (fixes 'path must be a directory')", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bs-search-"));
  const file = path.join(tmp, "main.js");
  fs.writeFileSync(file, "const a = 1;\nfunction loop() {}\nconst b = 2;\n", "utf8");

  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("scans a single file when given a file path instead of erroring", () => {
    const res = searchFiles(tmp, file, "function loop");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.results).toHaveLength(1);
      expect(res.results[0]!.line).toBe(2);
    }
  });

  it("still searches a directory normally", () => {
    const res = searchFiles(tmp, tmp, "const");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.results.length).toBe(2);
  });
});
