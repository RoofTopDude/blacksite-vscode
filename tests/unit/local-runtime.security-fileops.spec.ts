import { describe, expect, it, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  planSpawn,
  classifyOperation,
  classifyCommandPermission,
  isAllowedCommand,
  resolveShellConfirmation,
  buildDescription,
  validateArgs,
} from "../../packages/local-runtime/src/security.js";
import { handleShell, runShellCommand } from "../../packages/local-runtime/src/shell.js";
import { LocalRuntime } from "../../packages/local-runtime/src/index.js";
import { searchFiles, glob } from "../../packages/local-runtime/src/file-ops.js";

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

describe("handleShell — shell-line-in-command guidance (command is the executable, not a shell line)", () => {
  const root = os.tmpdir();

  it("rejects a shell operator crammed into `command` with actionable guidance", async () => {
    for (const command of ["npm run build && npm test", "echo hi | grep h", "ls; rm x", "cat a > b", "echo $(whoami)"]) {
      const res = (await handleShell({ command, args: [] }, root)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/executable name only|invoke a shell explicitly/i);
    }
  });

  it("allows an explicit shell invocation where the operators live in args", () => {
    // command is a plain executable ("bash"); the operators are inside an arg, so no false positive.
    const outcome = resolveShellConfirmation("bash", ["-lc", "a && b"], false, undefined, {});
    // It reaches the normal policy path (confirm/proceed/denied) rather than the operator-in-command guard.
    expect(["confirm", "proceed", "denied"]).toContain(outcome.kind);
  });

  // Regression coverage for the spawnSync -> spawn conversion: spawnSync ran on the calling
  // thread and blocked it for the command's full duration (up to 10 minutes for an allowed
  // command), which froze the entire VS Code UI — surfaced to users as the extension
  // "crashing." These assert the async replacement actually returns results, honours the
  // timeout by killing the child instead of hanging, and survives a spawn failure (ENOENT)
  // without an unhandled 'error' event on the ChildProcess (which would crash the whole
  // extension host, not just this call).
  it("handleShell runs a real allowed command end-to-end via async spawn", async () => {
    const result = await handleShell({ command: "node", args: ["--version"] }, root);
    expect(result.ok).toBe(true);
    if (result.ok && "exitCode" in result) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^v\d/);
      expect(result.timedOut).toBe(false);
    } else {
      throw new Error("expected a completed shell result");
    }
  });

  it("runShellCommand kills the child and reports timedOut instead of hanging past the timeout", async () => {
    const scriptPath = path.join(os.tmpdir(), `bls-shell-timeout-${Date.now()}.js`);
    fs.writeFileSync(scriptPath, "setTimeout(() => {}, 5000);"); // outlives the 150ms timeout below
    try {
      const started = Date.now();
      const result = await runShellCommand({ command: "node", args: [scriptPath], shell: false }, root, 150);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      // Resolved close to the timeout, not the script's full 5s runtime — proves the child was
      // actually killed rather than the promise just waiting it out.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      try { fs.unlinkSync(scriptPath); } catch { /* best effort cleanup */ }
    }
  });

  it("runShellCommand resolves (does not throw or hang) when the binary does not exist", async () => {
    const result = await runShellCommand(
      { command: "bls-definitely-not-a-real-binary-xyz", args: [], shell: false },
      root,
      5000,
    );
    expect(result.exitCode).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
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

  it("glob: searches a file's directory when given a file path instead of erroring", () => {
    const res = glob(tmp, file, "*.js");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.results).toContain("main.js");
  });
});

describe("command permission — tri-state classification (unrecognized commands prompt, don't hard-fail)", () => {
  it("classifies a denied binary as denied, even one that would otherwise be unrecognized", () => {
    expect(classifyCommandPermission("mystery-tool", undefined, undefined, { deniedCommands: ["mystery-tool"] })).toBe("denied");
  });

  it("classifies a default-allowlisted binary as allowed", () => {
    expect(classifyCommandPermission("git")).toBe("allowed");
  });

  it("classifies an unlisted binary as unrecognized, not denied", () => {
    expect(classifyCommandPermission("some-random-binary-xyz")).toBe("unrecognized");
  });

  it("isAllowedCommand facade stays boolean-equivalent to classifyCommandPermission === allowed", () => {
    expect(isAllowedCommand("git")).toBe(true);
    expect(isAllowedCommand("some-random-binary-xyz")).toBe(false);
    expect(isAllowedCommand("mystery-tool", undefined, undefined, { deniedCommands: ["mystery-tool"] })).toBe(false);
  });

  it("resolveShellConfirmation forces confirmation for an unrecognized command even when its tier guess wouldn't normally prompt", () => {
    const outcome = resolveShellConfirmation("some-random-binary-xyz", ["--version"], false, undefined, undefined);
    expect(outcome.kind).toBe("confirm");
    if (outcome.kind === "confirm") {
      expect(outcome.unrecognizedCommand).toBe(true);
      expect(outcome.description).toMatch(/unrecognized/i);
    }
  });

  it("resolveShellConfirmation hard-denies an explicitly denied command with no confirmation path", () => {
    const outcome = resolveShellConfirmation("curl", ["https://example.com"], false, undefined, { deniedCommands: ["curl"] });
    expect(outcome.kind).toBe("denied");
  });

  it("resolveShellConfirmation proceeds without a prompt once already confirmed", () => {
    const outcome = resolveShellConfirmation("some-random-binary-xyz", [], true, undefined, undefined);
    expect(outcome.kind).toBe("proceed");
  });

  it("buildDescription surfaces both 'unrecognized' and a matched destructive pattern instead of losing one", () => {
    // "rm" isn't on the default allowlist, so it's simultaneously unrecognized AND
    // destructive-tier — regression guard for a bug caught while implementing this.
    const description = buildDescription("rm", ["-rf", "build"], true);
    expect(description).toMatch(/unrecognized/i);
    expect(description).toMatch(/permanently deletes/i);
  });

  it("handleShell prompts instead of hard-failing for an unlisted binary", async () => {
    const result = await handleShell({ command: "some-random-binary-xyz", args: ["--version"] }, process.cwd());
    expect(result.ok).toBe(true);
    if (result.ok && "requiresConfirmation" in result) {
      expect(result.requiresConfirmation).toBe(true);
      expect(result.unrecognizedCommand).toBe(true);
    } else {
      throw new Error("expected a confirmation-required result");
    }
  });

  it("handleShell still hard-fails an explicitly denied binary with no confirmation path", async () => {
    const result = await handleShell({ command: "curl", args: [] }, process.cwd(), { deniedCommands: ["curl"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/explicitly denied/i);
  });

  it("system.process.start prompts instead of hard-failing for an unlisted binary (same fix as handleShell)", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const response = await runtime.handleMessage({
      type: "system.process.start",
      payload: { command: "some-random-binary-xyz", args: [] },
    });
    const result = response.result as { ok: boolean; requiresConfirmation?: boolean; unrecognizedCommand?: boolean };
    expect(result.ok).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.unrecognizedCommand).toBe(true);
  });

  it("system.process.start still hard-fails an explicitly denied binary", async () => {
    const runtime = new LocalRuntime(process.cwd(), { deniedCommands: ["curl"] });
    const response = await runtime.handleMessage({
      type: "system.process.start",
      payload: { command: "curl", args: [] },
    });
    const result = response.result as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/explicitly denied/i);
  });
});
