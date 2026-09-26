import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { confirmProjectAutoApprove, PROJECT_AUTO_APPROVE_KEY, readCommandPolicy } from "../../src/command-policy.js";
import { ChatProvider } from "../../src/chat-provider.js";

/* A repository can ship `.vscode/settings.json`. These pin that such a file can tighten the
   agent's command policy but never loosen it: a checked-in `autoApprove` or `allowEvalFlags`
   must not let prompt-injected instructions run without the user being asked. */

type Scoped = { globalValue?: unknown; workspaceValue?: unknown };

function mockPermissions(values: Record<string, Scoped>, updates: Array<{ key: string; value: unknown; target: unknown }> = []): void {
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
    get: (key: string, fallback?: unknown) => values[key]?.workspaceValue ?? values[key]?.globalValue ?? fallback,
    inspect: (key: string) => values[key] ?? {},
    update: async (key: string, value: unknown, target: unknown) => { updates.push({ key, value, target }); },
  } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);
}

function memento(initial: Record<string, unknown> = {}): vscode.Memento {
  const store = new Map(Object.entries(initial));
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T) => (store.has(key) ? store.get(key) as T : fallback),
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } as vscode.Memento;
}

afterEach(() => vi.restoreAllMocks());

describe("readCommandPolicy", () => {
  it("ignores a repository's auto-approvals until the user confirms them here", () => {
    mockPermissions({ autoApprove: { globalValue: ["git"], workspaceValue: ["bash", "node"] } });
    expect(readCommandPolicy(memento()).autoApprove).toEqual(["git"]);
    expect(readCommandPolicy(memento({ [PROJECT_AUTO_APPROVE_KEY]: ["node"] })).autoApprove).toEqual(["git", "node"]);
  });

  it("reads the eval-flag opt-out from user settings only", () => {
    mockPermissions({ allowEvalFlags: { workspaceValue: true } });
    expect(readCommandPolicy(memento()).allowEvalFlags).toBe(false);
    mockPermissions({ allowEvalFlags: { globalValue: true } });
    expect(readCommandPolicy(memento()).allowEvalFlags).toBe(true);
  });

  it("still lets a repository restrict", () => {
    mockPermissions({ deniedCommands: { workspaceValue: ["curl"] }, allowedCommands: { workspaceValue: ["just"] } });
    const policy = readCommandPolicy(memento());
    expect(policy.deniedCommands).toEqual(["curl"]);
    expect(policy.allowedCommands).toEqual(["just"]);
  });

  it("matches confirmations by command identity", async () => {
    const state = memento();
    await confirmProjectAutoApprove(state, "C:\\tools\\Node.EXE");
    await confirmProjectAutoApprove(state, "node");
    expect(state.get(PROJECT_AUTO_APPROVE_KEY)).toEqual(["node"]);
  });
});

describe("ChatProvider._persistAutoApprove", () => {
  function host(state = memento()) {
    const runtime = { setPolicy: vi.fn() };
    const provider = Object.assign(Object.create(ChatProvider.prototype), {
      _context: { workspaceState: state },
      _runtime: runtime,
    }) as { _persistAutoApprove(command: string, scope?: "workspace" | "global"): Promise<void> };
    return { provider, runtime, state };
  }

  it("never copies a repository's list into user settings on an \"All projects\" choice", async () => {
    const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
    mockPermissions({ autoApprove: { globalValue: ["git"], workspaceValue: ["bash"] } }, updates);
    await host().provider._persistAutoApprove("npm", "global");
    expect(updates).toEqual([{ key: "autoApprove", value: ["git", "npm"], target: vscode.ConfigurationTarget.Global }]);
  });

  it("confirms a project choice locally and applies it even when the repository already lists it", async () => {
    const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
    mockPermissions({ autoApprove: { workspaceValue: ["bash"] } }, updates);
    const workspace = vscode.workspace as unknown as { workspaceFolders: unknown };
    const previous = workspace.workspaceFolders;
    workspace.workspaceFolders = [{ name: "repo", index: 0, uri: vscode.Uri.file(process.cwd()) }];
    try {
      const { provider, runtime, state } = host();
      await provider._persistAutoApprove("bash", "workspace");
      expect(state.get(PROJECT_AUTO_APPROVE_KEY)).toEqual(["bash"]);
      expect(updates).toEqual([]);
      expect(runtime.setPolicy).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: ["bash"] }));
    } finally {
      workspace.workspaceFolders = previous;
    }
  });
});
