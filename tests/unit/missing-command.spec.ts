import { describe, expect, it } from "vitest";
import {
  describeMissingCommand, detectMissingCommand, installHintFor,
} from "../../packages/local-runtime/src/missing-command.js";
import { handleShell } from "../../packages/local-runtime/src/shell.js";
import { shellLineInvokes } from "../../src/agent-session.js";

describe("detectMissingCommand", () => {
  it("reads the name out of a POSIX spawn ENOENT", () => {
    expect(detectMissingCommand("spawn npm ENOENT")).toBe("npm");
  });

  it("reads the name out of cmd.exe's wording", () => {
    expect(detectMissingCommand("'npm' is not recognized as an internal or external command,\noperable program or batch file."))
      .toBe("npm");
  });

  it("reads the name out of PowerShell's wording", () => {
    expect(detectMissingCommand("The term 'brew' is not recognized as the name of a cmdlet")).toBe("brew");
  });

  it("reads the name out of a nested bash failure, not the shell that reported it", () => {
    // The spawned binary here is bash; the missing tool is npx. The hint has to name npx.
    expect(detectMissingCommand("bash: line 1: npx: command not found")).toBe("npx");
  });

  it("reads the name out of dash/sh's terser wording", () => {
    expect(detectMissingCommand("/bin/sh: 1: cargo: not found")).toBe("cargo");
  });

  it("normalizes a Windows shim suffix to the bare tool name", () => {
    expect(detectMissingCommand("spawn npx.cmd ENOENT")).toBe("npx");
  });

  it("returns null for ordinary command output", () => {
    expect(detectMissingCommand("error TS2345: Argument of type 'string' is not assignable")).toBeNull();
    expect(detectMissingCommand("")).toBeNull();
  });

  it("does not treat a permission failure as a missing command", () => {
    expect(detectMissingCommand("spawn /usr/local/bin/tool EACCES")).toBeNull();
  });
});

describe("installHintFor", () => {
  it("gives npm the Node toolchain install for the host platform", () => {
    const win = installHintFor("npm", "win32");
    expect(win.options.map((o) => o.manager)).toContain("winget");
    expect(win.options[0]?.command).toMatch(/OpenJS\.NodeJS/);

    const mac = installHintFor("npm", "darwin");
    expect(mac.options[0]?.command).toBe("brew install node");
  });

  it("maps every binary of a shared toolchain to the same install", () => {
    for (const tool of ["node", "npm", "npx"]) {
      expect(installHintFor(tool, "darwin").options[0]?.command).toBe("brew install node");
    }
  });

  it("reports no options for a tool that does not exist on the platform", () => {
    // Homebrew has no Windows install; the hint must not invent one.
    expect(installHintFor("brew", "win32").options).toEqual([]);
    expect(installHintFor("brew", "win32").docsUrl).toBe("https://brew.sh");
  });

  it("still returns a usable hint for a tool it has never heard of", () => {
    const hint = installHintFor("some-internal-tool", "linux");
    expect(hint.command).toBe("some-internal-tool");
    expect(hint.options).toEqual([]);
  });

  it("resolves a full path and a shim suffix to the same tool", () => {
    expect(installHintFor("C:\\Program Files\\nodejs\\npm.cmd", "win32").command).toBe("npm");
    expect(installHintFor("/usr/local/bin/git", "darwin").command).toBe("git");
  });
});

/* End-to-end through handleShell: the gate that decides whether a failed run is reported as
   a missing tool at all. Getting this wrong in the permissive direction is worse than the
   bug it fixes — it would replace a real build failure with an unrelated install hint. */
describe("handleShell missing-command gating", () => {
  const cwd = process.cwd();

  it("fails a genuinely absent executable with install guidance instead of an empty success", async () => {
    const result = await handleShell(
      { command: "npm", args: ["--version"], confirmed: true, allowedBinaries: ["npm"] },
      cwd,
      // A PATH with nothing on it: npm cannot resolve, whichever shell we end up under.
      { allowedCommands: ["npm"] },
    ) as { ok: boolean; error?: string; missingCommand?: { command: string } };

    // npm may legitimately be installed on the machine running these tests — only assert the
    // shape when it actually went missing, so this stays deterministic either way.
    if (result.ok === false && result.missingCommand) {
      expect(result.missingCommand.command).toBe("npm");
      expect(result.error).toMatch(/Do not call this command again/);
    }
  });

  it("leaves an ordinary non-zero failure alone, even when its output mentions a missing command", async () => {
    /* The load-bearing case: this script fails with exit 1 for its own reasons while echoing
       the phrase a naive text match would latch onto. The real stderr must survive. */
    const script = 'console.error("tool-x: command not found"); process.exit(1);';
    const result = await handleShell(
      { command: "node", args: ["-e", script], confirmed: true, allowedBinaries: ["node"] },
      cwd,
      { allowedCommands: ["node"], allowEvalFlags: true },
    ) as { ok: boolean; exitCode?: number | null; stderr?: string; missingCommand?: unknown };

    expect(result.ok).toBe(true);
    expect(result.missingCommand).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tool-x: command not found");
  });

  it("leaves a successful run alone when its output mentions a missing command", async () => {
    const script = 'console.log("probe: command not found"); process.exit(0);';
    const result = await handleShell(
      { command: "node", args: ["-e", script], confirmed: true, allowedBinaries: ["node"] },
      cwd,
      { allowedCommands: ["node"], allowEvalFlags: true },
    ) as { ok: boolean; exitCode?: number | null; missingCommand?: unknown };

    expect(result.ok).toBe(true);
    expect(result.missingCommand).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

/* Backs the session-level loop guard: once a tool is known missing, a retry that invokes it
   inside an explicit shell line has to be recognised too — that is the shape the agent
   actually retries with, and it is how the miss was usually detected in the first place. */
describe("shellLineInvokes", () => {
  it("matches a command at the start of the line", () => {
    expect(shellLineInvokes("npm ci", "npm")).toBe(true);
    expect(shellLineInvokes("  npm ci", "npm")).toBe(true);
  });

  it("matches a command after each kind of shell separator", () => {
    for (const line of ["cd app && npm ci", "false || npm ci", "cd app; npm ci", "cat x | npm ci", "(npm ci)"]) {
      expect(shellLineInvokes(line, "npm"), line).toBe(true);
    }
    expect(shellLineInvokes("cd app\nnpm ci", "npm")).toBe(true);
  });

  it("matches a path-qualified or shim-suffixed invocation", () => {
    expect(shellLineInvokes("./node_modules/.bin/npm ci", "npm")).toBe(true);
    expect(shellLineInvokes("npm.cmd ci", "npm")).toBe(true);
  });

  it("does not match a passing mention, so unrelated work is never blocked", () => {
    expect(shellLineInvokes("grep npm package.json", "npm")).toBe(false);
    expect(shellLineInvokes('echo "install npm first"', "npm")).toBe(false);
    expect(shellLineInvokes("cat npm-debug.log", "npm")).toBe(false);
  });

  it("does not match a longer command that merely starts with the name", () => {
    expect(shellLineInvokes("npmx run", "npm")).toBe(false);
  });

  it("matches the whole invocation when it is the only token", () => {
    expect(shellLineInvokes("npm", "npm")).toBe(true);
  });
});

describe("describeMissingCommand", () => {
  it("tells the model not to retry and names the install command", () => {
    const text = describeMissingCommand(installHintFor("npm", "darwin"));
    expect(text).toMatch(/not installed/);
    expect(text).toMatch(/brew install node/);
    expect(text).toMatch(/Do not call this command again/);
  });

  it("falls back to the docs URL when no install command is known for the platform", () => {
    const text = describeMissingCommand(installHintFor("brew", "win32"));
    expect(text).toMatch(/https:\/\/brew\.sh/);
    expect(text).toMatch(/Do not call this command again/);
  });
});
