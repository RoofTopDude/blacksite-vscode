/* The Hooks page. "Blacksite: Manage Hooks" was a palette entry with no handler from 1.26.0 to
   1.31.0; these specs drive the page's host the way its webview does: list hooks with whether
   each program can be found, add, edit, reorder and remove them in user settings only, and run
   one with a sample payload. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { HooksPanel } from "../../src/hooks-panel.js";
import { sampleHookInput, testHook } from "../../src/hook-settings.js";

interface FakePanel {
  posted: Array<Record<string, unknown>>;
  receive?: (message: unknown) => void;
  disposed: boolean;
  html: string;
}

const hoisted = vi.hoisted(() => ({ panels: [] as FakePanel[] }));

vi.mock("vscode", async () => {
  const mock = await import("./helpers/vscode-mock.js");
  return {
    ...mock,
    ViewColumn: { Active: -1 },
    window: {
      ...mock.window,
      createWebviewPanel: () => {
        const disposeListeners: Array<() => void> = [];
        const panel = {
          posted: [] as Array<Record<string, unknown>>, receive: undefined as undefined | ((message: unknown) => void), disposed: false, html: "",
          viewColumn: 1,
          webview: {
            cspSource: "'self'",
            asWebviewUri: (uri: unknown) => uri,
            postMessage: async (message: Record<string, unknown>) => { panel.posted.push(message); return true; },
            onDidReceiveMessage: (listener: (message: unknown) => void) => { panel.receive = listener; return { dispose: () => undefined }; },
            set html(value: string) { panel.html = value; },
            get html() { return panel.html; },
          },
          reveal: () => undefined,
          onDidDispose: (listener: () => void) => { disposeListeners.push(listener); return { dispose: () => undefined }; },
          dispose: () => { panel.disposed = true; for (const listener of disposeListeners) listener(); },
        };
        hoisted.panels.push(panel);
        return panel;
      },
    },
    workspace: {
      ...mock.workspace,
      onDidGrantWorkspaceTrust: () => ({ dispose: () => undefined }),
    },
  };
});

const mockWorkspace = vscode.workspace as unknown as {
  __setGlobalConfig(key: string, value: unknown): void;
  __setConfig(key: string, value: unknown): void;
  __clearConfig(): void;
};

const context = {
  extensionUri: vscode.Uri.file("/ext"),
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as vscode.ExtensionContext;

function userHooks(): unknown[] {
  return vscode.workspace.getConfiguration("blacksite.hooks").inspect<unknown[]>("commands")?.globalValue ?? [];
}

async function openPage() {
  const page = new HooksPanel(context, () => process.cwd(), () => undefined);
  page.open();
  const panel = hoisted.panels.at(-1)!;
  const send = async (message: Record<string, unknown>) => {
    panel.receive!(message);
    // The host handles each message asynchronously; let the settings write and re-post land.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const state = () => [...panel.posted].reverse().find((message) => message.type === "hooks_state") as {
    entries: Array<{ index: number; hook: { event: string; command: string; args?: string[] } | null; problem: string | null; found: string | null; test: { summary: string; tone: string } | null }>;
    shadowed: boolean;
    trusted: boolean;
  };
  return { page, panel, send, state };
}

beforeEach(() => {
  mockWorkspace.__clearConfig();
  hoisted.panels.length = 0;
});

afterEach(() => {
  mockWorkspace.__clearConfig();
});

describe("Hooks page", () => {
  it("opens, and lists each hook with whether its program can be found", async () => {
    mockWorkspace.__setGlobalConfig("blacksite.hooks.commands", [
      { event: "PostToolUse", command: "node", args: ["fmt.js"], tools: ["file_edit"] },
      { event: "PreToolUse", command: "definitely-not-installed-hook-xyz" },
    ]);
    const { state } = await openPage();
    expect(hoisted.panels).toHaveLength(1);
    const entries = state().entries;
    expect(entries.map((entry) => entry.hook?.command)).toEqual(["node", "definitely-not-installed-hook-xyz"]);
    expect(entries[0]!.found).toBeTruthy();
    expect(entries[1]!.found).toBeNull();
  });

  it("shows an entry the agent would reject, with the reason, instead of hiding it", async () => {
    mockWorkspace.__setGlobalConfig("blacksite.hooks.commands", [{ event: "PreToolUse", command: "node", matcher: "file_*" }]);
    const { state } = await openPage();
    expect(state().entries[0]).toMatchObject({ hook: null });
    expect(state().entries[0]!.problem).toMatch(/unknown key "matcher" \(use tools\)/);
  });

  it("adds, edits, reorders and removes hooks in user settings", async () => {
    const { send } = await openPage();
    await send({ type: "add", hook: { event: "PostToolUse", command: "node", args: ["lint.js"], tools: ["file_edit"], timeoutMs: 10_000 } });
    await send({ type: "add", hook: { event: "Stop", command: "npm", args: ["test"], tools: [], timeoutMs: 30_000 } });
    // Defaults are left out so settings.json stays readable.
    expect(userHooks()).toEqual([
      { event: "PostToolUse", command: "node", args: ["lint.js"], tools: ["file_edit"] },
      { event: "Stop", command: "npm", args: ["test"], timeoutMs: 30_000 },
    ]);

    await send({ type: "update", index: 0, hook: { event: "PostToolUse", command: "node", args: ["lint.js", "--fix"], tools: ["file_*"], timeoutMs: 5_000 } });
    expect(userHooks()[0]).toEqual({ event: "PostToolUse", command: "node", args: ["lint.js", "--fix"], tools: ["file_*"], timeoutMs: 5_000 });

    await send({ type: "move", index: 1, to: 0 });
    expect((userHooks()[0] as { event: string }).event).toBe("Stop");

    await send({ type: "remove", index: 0 });
    expect(userHooks()).toHaveLength(1);
  });

  it("refuses a hook the agent would reject, and says why", async () => {
    const { send, panel } = await openPage();
    await send({ type: "add", hook: { event: "PreToolUse", command: "", timeoutMs: 10_000 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(userHooks()).toEqual([]);
    expect(panel.posted.find((message) => message.type === "hooks_error")?.message).toMatch(/command must be a non-empty/);
  });

  it("notes a workspace copy of the setting, which is ignored", async () => {
    mockWorkspace.__setConfig("blacksite.hooks.commands", [{ event: "Stop", command: "node" }]);
    const { state } = await openPage();
    expect(state().shadowed).toBe(true);
    expect(state().entries).toEqual([]);
  });

  it("runs one hook with a sample payload and reports what the agent would do", async () => {
    mockWorkspace.__setGlobalConfig("blacksite.hooks.commands", [
      { event: "PreToolUse", command: "node", args: ["-e", "process.stderr.write('not this file'); process.exit(1)"] },
    ]);
    const { send, state } = await openPage();
    await send({ type: "test", index: 0 });
    await expect.poll(() => state().entries[0]!.test?.tone, { timeout: 15_000 }).toBe("warn");
    expect(state().entries[0]!.test!.summary).toMatch(/^Blocked in \d+ ms\. The agent would stop here: .*not this file/);
  });
});

describe("testHook", () => {
  it("reports a passing hook", async () => {
    const result = await testHook({ event: "PostToolUse", command: "node", args: ["-e", "process.exit(0)"] }, process.cwd());
    expect(result).toMatchObject({ tone: "ok" });
    expect(result.summary).toMatch(/^Passed in \d+ ms \(exit 0\)\.$/);
  });

  it("calls exit 2 after a tool feedback for the agent, not a failure", async () => {
    const result = await testHook({ event: "PostToolUse", command: "node", args: ["-e", "process.stderr.write('fix the lint'); process.exit(2)"] }, process.cwd());
    expect(result.tone).toBe("warn");
    expect(result.summary).toMatch(/^Sent the agent feedback in \d+ ms: fix the lint$/);
  });

  it("reports a program that cannot be found", async () => {
    const result = await testHook({ event: "PostToolUse", command: "definitely-not-installed-hook-xyz" }, process.cwd());
    expect(result.tone).toBe("error");
    expect(result.summary).toMatch(/Command not found|not found|ENOENT/i);
  });

  it("feeds the hook the same JSON shape the agent sends", async () => {
    const script = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({additionalContext: j.event+':'+j.toolName+':'+j.version}));});";
    const result = await testHook({ event: "PostToolUse", command: "node", args: ["-e", script], tools: ["file_*"] }, process.cwd());
    expect(result.summary).toMatch(/note for the agent: PostToolUse:file_sample:1$/);
  });
});

describe("sampleHookInput", () => {
  it("matches the hook's own tool filter, so a test run is never filtered out", () => {
    expect(sampleHookInput({ event: "PreToolUse", command: "x", tools: ["shell_run"] }, "/w").toolName).toBe("shell_run");
    expect(sampleHookInput({ event: "PreToolUse", command: "x", tools: ["file_*"] }, "/w").toolName).toBe("file_sample");
    expect(sampleHookInput({ event: "Stop", command: "x" }, "/w")).toMatchObject({ event: "Stop", stopReason: "end_turn", workspaceRoot: "/w" });
  });
});
