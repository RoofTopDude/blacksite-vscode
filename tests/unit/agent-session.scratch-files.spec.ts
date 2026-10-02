import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type AgentSessionOptions } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";

/* A scratch script the agent wrote to check something and then removed used to stay on the
   completion lists: file_delete counted as one more edit, a shell `rm` went unnoticed, and the
   closing reminders asked for a test and a map note for a file that no longer existed — neither
   of which could succeed, so every reminder was spent on it. These run against a real directory,
   because "is it still on disk" is the question being answered. */

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-scratch-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

function context() {
  const values = new Map<string, unknown>();
  return { workspaceState: { get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback, update: async (key: string, value: unknown) => { values.set(key, value); } } };
}

/** A runtime that really writes and deletes under `root`, the way the local runtime does. */
function diskRuntime(root: string) {
  return {
    handleMessage: vi.fn(async (message: { type: string; payload?: Record<string, unknown> }) => {
      const payload = message.payload ?? {};
      const target = path.join(root, String(payload["path"] ?? ""));
      if (message.type === "system.write_file") {
        const created = !fs.existsSync(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(payload["content"] ?? ""));
        return { result: { ok: true, path: target, relativePath: String(payload["path"]), bytesWritten: 1, mode: "overwrite", created } };
      }
      if (message.type === "system.delete_path") {
        fs.rmSync(target, { force: true });
        return { result: { ok: true, path: target } };
      }
      if (message.type === "system.shell") {
        if (payload["command"] === "rm") for (const arg of (payload["args"] as string[]) ?? []) fs.rmSync(path.join(root, arg), { force: true });
        return { result: { ok: true, exitCode: 0, stdout: "", stderr: "" } };
      }
      if (message.type === "test.run") return { result: { ok: true, passed: 2, failed: 0, skipped: 0 } };
      return { result: { ok: true } };
    }),
  };
}

function makeSession(root: string, factory: ScriptedTurnFactory, options: Partial<AgentSessionOptions> = {}) {
  const scripted = new ScriptedProviderSession(factory);
  const graphProvider = {
    dispatch: vi.fn(async (_op: string, payload: Record<string, unknown>) => ({ ok: true, note: { from: payload["from"] ?? payload["path"] } })),
    syncIndex: vi.fn(async () => ({ appliedChanges: 1 })),
  };
  const session = new AgentSession({
    apiKey: "key", model: "claude-sonnet-5", systemPrompt: "test", workspaceRoot: root,
    runtime: diskRuntime(root) as never, context: context() as never, provider: "anthropic", maxIterations: 12,
    checkpointingEnabled: false, contextLength: 200_000, graphProvider: graphProvider as never,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
    ...options,
  });
  return { session, scripted, graphProvider };
}

async function run(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send("do the work")) events.push(event);
  return events;
}

const call = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });
const write = (id: string, file: string) => call(id, "file_write", { path: file, content: "x" });
const reminders = (scripted: ScriptedProviderSession) => scripted.userTexts.filter((text) => text.startsWith("[Internal continuation]"));

describe("scratch files and the completion gates", () => {
  it("owes nothing for a script kept in the scratch folder, and keeps that folder out of git", async () => {
    const root = workspace();
    const { session, scripted } = makeSession(root, ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [write("w", ".blacksite/scratch/probe.py")], stopReason: "tool_use", usage };
      return { text: "done", stopReason: "end_turn", usage };
    }, { mapNotes: "require" });
    await run(session);

    expect(reminders(scripted)).toEqual([]);
    expect(session.runtimeState.verification.status).toBe("idle");
    expect(fs.readFileSync(path.join(root, ".blacksite", "scratch", ".gitignore"), "utf8")).toContain("*");
  });

  it("owes nothing for a script written and then removed with file_delete", async () => {
    const root = workspace();
    const { session, scripted } = makeSession(root, ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [write("w", "check.mjs")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [call("d", "file_delete", { path: "check.mjs" })], stopReason: "tool_use", usage };
      return { text: "done", stopReason: "end_turn", usage };
    });
    await run(session);

    expect(reminders(scripted)).toEqual([]);
    expect(session.runtimeState.verification.status).toBe("idle");
  });

  it("drops a script removed from the shell, and keeps the real edit pending", async () => {
    const root = workspace({ "src/a.ts": "old" });
    const { session, scripted } = makeSession(root, ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [write("a", "src/a.ts"), write("w", "check.mjs")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [call("rm", "shell_run", { command: "rm", args: ["check.mjs"] })], stopReason: "tool_use", usage };
      if (turnIndex === 2) return { text: "done", stopReason: "end_turn", usage };
      if (turnIndex === 3) return { toolCalls: [call("t", "test_run", {}), call("n", "map_note_add", { from: "src/a.ts", note: "why" })], stopReason: "tool_use", usage };
      return { text: "done, verified", stopReason: "end_turn", usage };
    });
    const events = await run(session);

    const [reminder] = reminders(scripted);
    expect(reminder).toContain("src/a.ts");
    expect(reminder).not.toContain("check.mjs");
    expect(events.some((event) => event.type === "execution_diagnostic" && event.message.includes("no longer on disk: check.mjs"))).toBe(true);
    expect(session.runtimeState.verification).toMatchObject({ status: "passed", files: ["src/a.ts"] });
  });

  it("names one file once, however the tool reported it", async () => {
    const root = workspace();
    const { session } = makeSession(root, ({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [write("w", "notes.ts")], stopReason: "tool_use", usage }
      : { text: "done", stopReason: "end_turn", usage });
    await run(session);
    // file_write reports the absolute path as well as the relative one it was given.
    expect(session.exportState().verification?.files).toEqual(["notes.ts"]);
  });

  it("keeps a deleted pre-existing file pending and marks it deleted in the reminder", async () => {
    const root = workspace({ "old.ts": "export {}" });
    const { session, scripted } = makeSession(root, ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [call("d", "file_delete", { path: "old.ts" })], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { text: "removed it", stopReason: "end_turn", usage };
      if (turnIndex === 2) return { toolCalls: [call("t", "test_run", {})], stopReason: "tool_use", usage };
      return { text: "removed it, tests pass", stopReason: "end_turn", usage };
    });
    await run(session);

    const [reminder] = reminders(scripted);
    expect(reminder).toContain("old.ts (deleted)");
    expect(reminder).toContain("check what depended on it");
    expect(reminder).toContain("workspace_refresh");
    expect(session.runtimeState.verification.status).toBe("passed");
  });

  it("looks for a file in every workspace folder before calling it deleted", () => {
    const primary = workspace();
    const second = workspace({ "src/b.ts": "export {}" });
    const { session } = makeSession(primary, () => ({ text: "hi", stopReason: "end_turn", usage }), {
      workspaceRoots: () => [primary, second],
    });
    const describe = (session as unknown as { _describeDebtPaths(paths: string[]): string[] })._describeDebtPaths.bind(session);
    // Language-server edits report paths relative to their own folder; map ids lead with its name.
    expect(describe(["src/b.ts", `${path.basename(second)}/src/b.ts`, "gone.ts"]))
      .toEqual(["src/b.ts", `${path.basename(second)}/src/b.ts`, "gone.ts (deleted)"]);
  });

  it("does not count a diagnostics call on a missing file as a failed check", async () => {
    const root = workspace({ "src/a.ts": "old" });
    const lspProvider = { dispatch: vi.fn(async () => ({ ok: false, code: "file_missing", error: "gone" })) };
    const { session } = makeSession(root, ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [write("a", "src/a.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [call("c", "code_diagnostics", { path: "check.mjs" })], stopReason: "tool_use", usage };
      return { text: "done", stopReason: "end_turn", usage };
    }, { lspProvider: lspProvider as never });
    await run(session);
    expect(session.exportState().verification).toMatchObject({ files: ["src/a.ts"] });
    expect(session.exportState().verification?.status).not.toBe("failed");
  });
});

describe("workspace_refresh", () => {
  it("re-syncs the lists with the disk without passing the gate", async () => {
    /* legacy.ts existed before the session, was rewritten, then removed from the shell. The pass
       before every iteration drops its note debt on its own (it was on disk when edited, so its
       absence is a deletion); its verification stays owed, since deleting a real file is a change. */
    const root = workspace({ "src/a.ts": "old", "legacy.ts": "old" });
    const { session, scripted, graphProvider } = makeSession(root, ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [write("a", "src/a.ts"), write("l", "legacy.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [call("rm", "shell_run", { command: "rm", args: ["legacy.ts"] })], stopReason: "tool_use", usage };
      if (turnIndex === 2) return { toolCalls: [call("r", "workspace_refresh", {})], stopReason: "tool_use", usage };
      return { text: "done", stopReason: "end_turn", usage };
    }, { staleDiagnosticFiles: () => ["legacy.ts"] });
    await run(session);

    const refresh = scripted.toolResults.flat().find((result) => result.tool_use_id === "r")!;
    const body = JSON.parse(refresh.content) as Record<string, unknown>;
    expect(body["droppedReminders"]).toEqual([]);
    expect(body["staleDiagnosticsFor"]).toEqual(["legacy.ts"]);
    expect(body["mapIndex"]).toEqual({ appliedChanges: 1 });
    expect(body["outstanding"]).toEqual([
      "verification (pending): src/a.ts, legacy.ts (deleted)",
      "map notes: src/a.ts",
    ]);
    expect(graphProvider.syncIndex).toHaveBeenCalledOnce();
    // Information, not a check: the edit set still needed verifying, so the closing reminders came.
    expect(reminders(scripted).length).toBeGreaterThan(0);
    expect(session.exportState().verification?.status).not.toBe("passed");
  });

  it("is offered on every request, since the harness's own reminders name it", async () => {
    const root = workspace();
    const { session } = makeSession(root, () => ({ text: "hi", stopReason: "end_turn", usage }));
    const tools = (session as unknown as { _getTools(): Array<{ name: string }> })._getTools().map((tool) => tool.name);
    expect(tools).toContain("workspace_refresh");
  });
});
