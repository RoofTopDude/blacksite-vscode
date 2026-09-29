import { describe, expect, it, vi } from "vitest";
import { parseHooks, runHooks, type HookInput } from "../../src/hooks.js";
import { configuredHooks } from "../../src/hook-settings.js";
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
