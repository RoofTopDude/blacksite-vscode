import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { bindWorkspaceUi } from "../../src/workspace-ui-host.js";

const disposables: vscode.Disposable[] = [];
afterEach(() => { for (const item of disposables.splice(0)) item.dispose(); vi.restoreAllMocks(); });

function fixture() {
  let receive: (message: unknown) => Promise<void>;
  const messages: Array<Record<string, unknown>> = [];
  const state = new Map<string, unknown>();
  const context = { workspaceState: {
    get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { state.set(key, value); },
  } } as unknown as vscode.ExtensionContext;
  const webview = {
    onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose: vi.fn() }; },
    postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; },
  } as unknown as vscode.Webview;
  const binding = bindWorkspaceUi(webview, context);
  disposables.push(binding);
  return { send: (message: unknown) => receive(message), messages, state, binding };
}

describe("shared workspace navigation", () => {
  it("allows only known destinations and carries entity IDs to their dedicated command", async () => {
    const command = vi.spyOn(vscode.commands, "executeCommand");
    const view = fixture();
    await view.send({ type: "workspace_navigate", destination: "workbench.action.closeWindow" });
    expect(command).not.toHaveBeenCalled();
    await view.send({ type: "workspace_navigate", source: "runs", destination: "plans", entityId: "plan-1" });
    expect(command).toHaveBeenCalledWith("blacksite.revealPlan", "plan-1");
    expect(view.state.get("workspace.recent")).toEqual(["plans", "runs"]);
    await view.send({ type: "workspace_navigate", source: "plans", destination: "runs" });
    expect(command).toHaveBeenLastCalledWith("blacksite.runs.focus");
    expect(view.state.get("workspace.recent")).toEqual(["runs", "plans"]);
  });

  it("synchronizes density across mounted panels and releases its configuration listener", async () => {
    const first = fixture();
    const second = fixture();
    await first.send({ type: "workspace_density", density: "compact" });
    expect(first.messages.at(-1)?.density).toBe("compact");
    expect(second.messages.at(-1)?.density).toBe("compact");
    second.binding.dispose();
    const count = second.messages.length;
    await first.send({ type: "workspace_density", density: "comfortable" });
    expect(first.messages.at(-1)?.density).toBe("comfortable");
    expect(second.messages).toHaveLength(count);
  });
});
