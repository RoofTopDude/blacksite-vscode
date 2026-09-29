import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateHookProgram, parseHooks, resolveHookLaunch, runHooks, toolMatches, validateHooks, type HookInput } from "../../src/hooks.js";
import { configuredHooks, describeHooks, setHookRunLog } from "../../src/hook-settings.js";
import * as vscode from "vscode";

const input: HookInput = { event: "PreToolUse", sessionId: "test", workspaceRoot: process.cwd(), toolName: "file_write", toolInput: { path: "a;$(echo nope).ts" } };
const node = (code: string) => ({ event: "PreToolUse" as const, command: process.execPath, args: ["-e", code] });

describe("hook scripts", () => {
  it("passes a versioned JSON payload on stdin without interpolating arguments", async () => {
    const hook = node(`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);process.exit(p.version===1&&p.toolInput.path==='a;$(echo nope).ts'&&process.argv[1]==='$(exit 9)'?0:1)});`);
    hook.args.push("$(exit 9)");
    expect(await runHooks([hook], input)).toEqual({ warnings: [] });
  });
  it("blocks on nonzero exit and includes bounded script feedback", async () => {
    const outcome = await runHooks([node("process.stderr.write('protected path');process.exitCode=2")], input);
    expect(outcome.blocked).toContain("protected path");
    expect(outcome.blocked).toContain("Exit 2");
    const large = await runHooks([node("process.stdout.write('x'.repeat(100000));process.exitCode=1")], input);
    expect(large.blocked!.length).toBeLessThan(17_000);
  });
  it("matches exact tools and events and stops after a blocking failure", async () => {
    expect(await runHooks([{ ...node("process.exit(1)"), tools: ["file_edit"] }], input)).toEqual({ warnings: [] });
    expect(await runHooks([{ ...node("process.exit(1)"), event: "Stop" }], input)).toEqual({ warnings: [] });
    const outcome = await runHooks([node("process.exit(2)"), node("process.stderr.write('second');process.exit(3)")], input);
    expect(outcome.blocked).toContain("Exit 2");
    expect(outcome.blocked).not.toContain("second");
  });
  it("reports launch errors, timeouts, and cancellation as blocking failures", async () => {
    expect((await runHooks([{ event: "PreToolUse", command: "blacksite-nonexistent-hook-executable" }], input)).blocked).toMatch(/ENOENT/);
    expect((await runHooks([{ ...node("setInterval(()=>{},1000)"), timeoutMs: 100 }], input)).blocked).toContain("Timed out");
    const controller = new AbortController();
    const pending = runHooks([node("setInterval(()=>{},1000)")], input, controller.signal);
    controller.abort();
    expect((await pending).blocked).toContain("Cancelled");
    expect((await runHooks([node("process.exit(0)")], input, controller.signal)).blocked).toContain("Cancelled");
  });
  it("treats post-tool and stop failures as warnings", async () => {
    for (const event of ["PostToolUse", "Stop"] as const) {
      const outcome = await runHooks([{ ...node("process.exit(2)"), event }], { ...input, event });
      expect(outcome.blocked).toBeUndefined();
      expect(outcome.warnings).toHaveLength(1);
    }
  });
  it("rejects malformed configuration and invalid time limits", () => {
    expect(parseHooks([])).toEqual([]);
    expect(parseHooks([node("process.exit(0)")])).toHaveLength(1);
    expect(() => parseHooks([{ ...node(""), tool: "file_edit" }])).toThrow();
    for (const bad of [null, {}, [null], [{ event: "unknown", command: "node" }], [{ ...node(""), args: [1] }], [{ ...node(""), tools: [""] }], [{ ...node(""), timeoutMs: 0 }], [{ ...node(""), timeoutMs: 60001 }]]) {
      expect(() => parseHooks(bad)).toThrow();
    }
  });
});

describe("hook configuration trust", () => {
  it("ignores workspace configuration and refuses execution without workspace trust", async () => {
    const inspect = vi.fn(() => ({ globalValue: [], workspaceValue: [node("process.exit(2)")] }));
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ inspect } as any);
    vi.spyOn(vscode.workspace, "isTrusted", "get").mockReturnValue(true);
    expect(await configuredHooks(input)).toEqual({ warnings: [] });
    inspect.mockReturnValue({ globalValue: [node("process.exit(2)")] as any, workspaceValue: [] });
    expect((await configuredHooks(input)).blocked).toContain("Exit 2");
    vi.spyOn(vscode.workspace, "isTrusted", "get").mockReturnValue(false);
    expect(await configuredHooks(input)).toEqual({});
  });
});

const post = (code: string) => ({ ...node(code), event: "PostToolUse" as const });
const stop = (code: string) => ({ ...node(code), event: "Stop" as const });
const postInput: HookInput = { ...input, event: "PostToolUse", result: { ok: true }, ok: true };
const stopInput: HookInput = { ...input, event: "Stop", stopReason: "end_turn", toolName: undefined };
const printJson = (value: object) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`;

describe("hook output that reaches the model", () => {
  it("passes a PostToolUse hook's exit code 2 to the model and warns the user", async () => {
    const outcome = await runHooks([post("process.stderr.write('lint failed: a.ts');process.exitCode=2")], postInput);
    expect(outcome.context).toEqual(["lint failed: a.ts"]);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.blocked).toBeUndefined();
  });
  it("keeps any other post-tool failure between the script and the user", async () => {
    const outcome = await runHooks([post("process.exitCode=1")], postInput);
    expect(outcome.context).toBeUndefined();
    expect(outcome.warnings).toHaveLength(1);
  });
  it("lets a Stop hook send the agent back to work with exit code 2, and only that", async () => {
    expect((await runHooks([stop("process.stdout.write('tests not run');process.exitCode=2")], stopInput)).resume).toBe("tests not run");
    const other = await runHooks([stop("process.exitCode=1")], stopInput);
    expect(other.resume).toBeUndefined();
    expect(other.warnings).toHaveLength(1);
  });
  it("reads a JSON decision or added context from a hook that exits 0", async () => {
    expect((await runHooks([node(printJson({ decision: "block", reason: "no secrets" }))], input)).blocked).toContain("no secrets");
    expect((await runHooks([post(printJson({ decision: "block", reason: "format it" }))], postInput)).context).toEqual(["format it"]);
    expect((await runHooks([stop(printJson({ decision: "block", reason: "run the tests" }))], stopInput)).resume).toBe("run the tests");
    expect((await runHooks([post(printJson({ additionalContext: "prettier changed 2 files" }))], postInput)).context).toEqual(["prettier changed 2 files"]);
    const prompt = { ...node(printJson({ additionalContext: "branch: main" })), event: "UserPromptSubmit" as const };
    expect((await runHooks([prompt], { ...input, event: "UserPromptSubmit", prompt: "hi" })).context).toEqual(["branch: main"]);
  });
  it("ignores plain output and context on events where it has no meaning", async () => {
    expect(await runHooks([post("process.stdout.write('formatted 2 files')")], postInput)).toEqual({ warnings: [] });
    expect(await runHooks([node(printJson({ additionalContext: "ignored" }))], input)).toEqual({ warnings: [] });
    expect(await runHooks([post("process.stdout.write('{not json')")], postInput)).toEqual({ warnings: [] });
  });
  it("never lets a Notification hook block anything", async () => {
    const outcome = await runHooks([{ ...node("process.exit(1)"), event: "Notification" as const }], { ...input, event: "Notification", toolName: undefined, message: "Approve?" });
    expect(outcome.blocked).toBeUndefined();
    expect(outcome.warnings).toHaveLength(1);
  });
  it("tells the script which event and tool it runs for", async () => {
    const hook = node(`process.exit(process.env.BLACKSITE_HOOK_EVENT==='PreToolUse'&&process.env.BLACKSITE_TOOL_NAME==='file_write'&&process.env.BLACKSITE_WORKSPACE===${JSON.stringify(process.cwd())}&&process.env.BLACKSITE_SESSION_ID==='test'?0:1)`);
    expect(await runHooks([hook], input)).toEqual({ warnings: [] });
  });
});

describe("hook tool filters", () => {
  it("matches exactly, or with * wildcards, and treats other characters literally", () => {
    expect(toolMatches(undefined, "anything")).toBe(true);
    expect(toolMatches(["file_*"], "file_write")).toBe(true);
    expect(toolMatches(["file_*"], "code_edit")).toBe(false);
    expect(toolMatches(["*_edit", "git_status"], "file_edit")).toBe(true);
    expect(toolMatches(["a.b"], "aXb")).toBe(false);
    expect(toolMatches(["x"], undefined)).toBe(false);
  });
});

describe("hook configuration errors", () => {
  it("names the entry and field at fault, with a hint for the names other tools use", () => {
    expect(() => parseHooks([{ event: "PreToolUse", command: "node", matcher: "file_write" }])).toThrow('Invalid hook 1: unknown key "matcher" (use tools)');
    expect(() => parseHooks([node(""), { event: "PreToolUsee", command: "node" }])).toThrow(/Invalid hook 2: event must be one of/);
    expect(() => parseHooks([{ ...node(""), timeoutMs: 5 }])).toThrow(/timeoutMs must be a whole number from 100 to 60000/);
    expect(() => parseHooks([{ event: "Stop" }])).toThrow(/command must be a non-empty/);
  });
  it("treats a broken entry as a possible safety check unless its event can never block", () => {
    const { problems, hooks } = validateHooks([{ event: "Stop", command: "" }, { event: "PreToolUse" }, { command: "x" }, 7, node("")]);
    expect(problems.map((problem) => problem.blocking)).toEqual([false, true, true, true]);
    expect(hooks).toHaveLength(1);
  });
  it("runs the valid hooks around a broken one that could not have blocked, and says which entry is wrong", async () => {
    const inspect = vi.fn(() => ({ globalValue: [{ event: "Stop", command: "" }, node("process.exit(0)")] }));
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ inspect } as any);
    vi.spyOn(vscode.workspace, "isTrusted", "get").mockReturnValue(true);
    expect(await configuredHooks(input)).toEqual({ warnings: [] });
    expect((await configuredHooks(stopInput)).warnings).toEqual([expect.stringContaining("Invalid hook 1")]);
    inspect.mockReturnValue({ globalValue: [{ event: "PreToolUse", matcher: "file_write", command: "node" }] } as any);
    expect((await configuredHooks(input)).blocked).toMatch(/Invalid hook 1: unknown key "matcher".*user settings/);
  });
});

describe("starting a hook's program", () => {
  const env = { PATH: "C:\\bin;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const present = (...files: string[]) => (candidate: string) => files.includes(candidate);
  it("finds npm and other .cmd programs through PATH and PATHEXT, and runs them through cmd.exe", () => {
    const launch = resolveHookLaunch("npm", ["run", "lint"], "C:\\work", "win32", env, present("C:\\Program Files\\nodejs\\npm.cmd"));
    expect(launch.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(launch.args[3]).toBe(`"C:\\Program^ Files\\nodejs\\npm.cmd ^"run^" ^"lint^""`);
  });
  it("escapes twice for the npm shims that hand their arguments to a second shell", () => {
    const shim = "C:\\proj\\node_modules\\.bin\\prettier.cmd";
    const launch = resolveHookLaunch(shim, ["--check"], "C:\\proj", "win32", env, present(shim));
    expect(launch.args[3]).toContain("^^^\"--check^^^\"");
  });
  it("launches an .exe directly, by its full path", () => {
    expect(resolveHookLaunch("node", ["a.js"], "C:\\work", "win32", env, present("C:\\Program Files\\nodejs\\node.exe")))
      .toEqual({ file: "C:\\Program Files\\nodejs\\node.exe", args: ["a.js"] });
  });
  it("refuses what cmd.exe cannot pass safely, and files Windows cannot run at all", () => {
    expect(() => resolveHookLaunch("C:\\h\\run.cmd", ["100%"], "C:\\work", "win32", env, present("C:\\h\\run.cmd"))).toThrow(/percent sign/);
    expect(() => resolveHookLaunch("C:\\h\\check.ps1", [], "C:\\work", "win32", env, present("C:\\h\\check.ps1"))).toThrow(/cannot run a \.ps1 file directly/);
  });
  it("leaves an unknown name for spawn to report, and never picks a bare name out of the workspace", () => {
    expect(resolveHookLaunch("nothere", ["x"], "C:\\work", "win32", env, present())).toEqual({ file: "nothere", args: ["x"] });
    expect(resolveHookLaunch("tool", [], "C:\\work", "win32", env, present("C:\\work\\tool.exe"))).toEqual({ file: "tool", args: [] });
  });
  it("does not change how programs start elsewhere, and can say where one would be found", () => {
    expect(resolveHookLaunch("npx", ["a"], "/work", "linux", {}, present())).toEqual({ file: "npx", args: ["a"] });
    expect(locateHookProgram("prettier", "/work", "linux", { PATH: "/usr/bin:/opt/bin" }, present("/opt/bin/prettier"))).toBe("/opt/bin/prettier");
    expect(locateHookProgram("./hooks/check.sh", "/work", "linux", {}, present("/work/hooks/check.sh"))).toBe("/work/hooks/check.sh");
    expect(locateHookProgram("gone", "/work", "linux", { PATH: "/usr/bin" }, present())).toBeUndefined();
  });
  it("reports a missing program in words a person can act on", async () => {
    const outcome = await runHooks([{ event: "PreToolUse", command: "blacksite-nonexistent-hook-executable" }], input);
    expect(outcome.blocked).toContain('Command not found: "blacksite-nonexistent-hook-executable"');
    expect(outcome.blocked).toContain("PATH");
  });
});

describe.runIf(process.platform === "win32")("hooks on Windows", () => {
  it("runs a .cmd program by bare name, which node's spawn alone refuses to start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blacksite-hook-"));
    const previous = process.env.PATH;
    try {
      writeFileSync(join(directory, "blacksite-hook-probe.cmd"), "@echo off\r\necho %1 %2 1>&2\r\nexit /b 3\r\n");
      process.env.PATH = `${directory};${previous}`;
      const outcome = await runHooks([{ event: "PreToolUse", command: "blacksite-hook-probe", args: ["a b", "c&d"] }], input);
      expect(outcome.blocked).toContain("Exit 3");
      // Both arguments arrived intact: the ampersand was data, not a second command.
      expect(outcome.blocked).toContain('"a b" "c&d"');
    } finally {
      process.env.PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the hook run log", () => {
  it("records what ran and how it ended, so a hook that works is visible, and never the payload", async () => {
    const inspect = vi.fn(() => ({ globalValue: [
      { ...node("process.exit(0)"), args: ["-e", "process.exit(0)"], tools: ["file_write"] },
      { ...node("process.stderr.write('protected path');process.exitCode=2"), args: ["-e", "process.stderr.write('protected path');process.exitCode=2"] },
    ] }));
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ inspect } as any);
    vi.spyOn(vscode.workspace, "isTrusted", "get").mockReturnValue(true);
    const lines: string[] = [];
    setHookRunLog({ appendLine: (line) => lines.push(line) });
    try {
      await configuredHooks({ ...input, toolInput: { path: "secret-payload.ts" } });
    } finally { setHookRunLog(undefined); }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] PreToolUse file_write: .* → exit 0 in \d+ ms$/);
    expect(lines[1]).toMatch(/→ failed after \d+ ms: Exit 2: protected path$/);
    expect(lines.join("\n")).not.toContain("secret-payload");
  });
  it("runs unchanged when nothing is listening, or when the log itself breaks", async () => {
    expect(await runHooks([node("process.exit(0)")], input, undefined, () => { throw new Error("log failed"); })).toEqual({ warnings: [] });
  });
});

describe("checking the hook setup", () => {
  it("reports what each hook resolves to, what is missing, and settings that are ignored", () => {
    const inspect = vi.fn(() => ({
      globalValue: [{ event: "PreToolUse", command: process.execPath }, { event: "Stop", command: "blacksite-nonexistent-hook-executable" }],
      workspaceValue: [{ event: "Stop", command: "node" }],
    }));
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ inspect } as any);
    vi.spyOn(vscode.workspace, "isTrusted", "get").mockReturnValue(true);
    const { lines, healthy } = describeHooks(process.cwd());
    expect(healthy).toBe(false);
    expect(lines.some((line) => line.startsWith("✓ PreToolUse") && line.includes(process.execPath))).toBe(true);
    expect(lines.some((line) => line.startsWith("✗ Stop") && line.includes("was not found"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Ignored: blacksite.hooks.commands is also set in workspace"))).toBe(true);
    inspect.mockReturnValue({ globalValue: [] } as any);
    expect(describeHooks(process.cwd())).toMatchObject({ healthy: true, lines: [expect.stringContaining("No hooks are configured")] });
  });
});
