import { describe, expect, it, vi } from "vitest";

/* The VS Code side of the indexer ports: findFiles for roots git doesn't cover, the workspace
   watcher, and workspace-folder changes. */

const host = vi.hoisted(() => {
  const handlers: Record<string, (uri: { fsPath: string }) => void> = {};
  const folderListeners: Array<() => void> = [];
  return {
    handlers,
    folderListeners,
    findFilesCalls: [] as unknown[][],
    watcherPattern: "",
    watcherFlags: [] as boolean[],
    watcherDisposed: false,
  };
});

vi.mock("vscode", () => {
  class RelativePattern {
    constructor(readonly base: string, readonly pattern: string) {}
  }
  return {
    RelativePattern,
    workspace: {
      findFiles: async (...args: unknown[]) => {
        host.findFilesCalls.push(args);
        return [{ fsPath: "C:\\ws\\src\\a.ts" }, { fsPath: "C:\\ws\\src\\b.ts" }];
      },
      createFileSystemWatcher: (pattern: string, ...flags: boolean[]) => {
        host.watcherPattern = pattern;
        host.watcherFlags = flags;
        return {
          onDidCreate: (handler: (uri: { fsPath: string }) => void) => { host.handlers.create = handler; },
          onDidChange: (handler: (uri: { fsPath: string }) => void) => { host.handlers.change = handler; },
          onDidDelete: (handler: (uri: { fsPath: string }) => void) => { host.handlers.delete = handler; },
          dispose: () => { host.watcherDisposed = true; },
        };
      },
      onDidChangeWorkspaceFolders: (listener: () => void, _thisArgs: unknown, disposables?: Array<{ dispose(): void }>) => {
        host.folderListeners.push(listener);
        const subscription = { dispose: () => { host.folderListeners.splice(host.folderListeners.indexOf(listener), 1); } };
        disposables?.push(subscription);
        return subscription;
      },
    },
  };
});

const { onDidChangeWorkspaceRoots, vscodeFileEnumerator, vscodeFileWatcher } = await import("../../src/graph/vscode-ports.js");

describe("VS Code indexer ports", () => {
  it("enumerates a root with findFiles, passing the exclude glob and the cap through", async () => {
    const files = await vscodeFileEnumerator("C:/ws", "{**/node_modules/**}", 200_000);
    expect(files).toEqual(["C:\\ws\\src\\a.ts", "C:\\ws\\src\\b.ts"]);
    const [pattern, exclude, max] = host.findFilesCalls[0]!;
    expect(pattern).toMatchObject({ base: "C:/ws", pattern: "**/*" });
    expect(exclude).toBe("{**/node_modules/**}");
    expect(max).toBe(200_000);
  });

  it("watches every folder for creates, changes and deletes, reporting fsPath", () => {
    const touched: string[] = [];
    const subscription = vscodeFileWatcher.watch((absolute) => touched.push(absolute));
    expect(host.watcherPattern).toBe("**/*");
    expect(host.watcherFlags).toEqual([false, false, false]);
    host.handlers.create!({ fsPath: "C:\\ws\\new.ts" });
    host.handlers.change!({ fsPath: "C:\\ws\\changed.ts" });
    host.handlers.delete!({ fsPath: "C:\\ws\\gone.ts" });
    expect(touched).toEqual(["C:\\ws\\new.ts", "C:\\ws\\changed.ts", "C:\\ws\\gone.ts"]);
    subscription.dispose();
    expect(host.watcherDisposed).toBe(true);
  });

  it("forwards workspace-folder changes and honours thisArgs and disposables", () => {
    const owner = { calls: 0 };
    const disposables: Array<{ dispose(): void }> = [];
    const subscription = onDidChangeWorkspaceRoots(function (this: typeof owner) { this.calls += 1; }, owner, disposables);
    host.folderListeners.forEach((listener) => listener());
    expect(owner.calls).toBe(1);
    expect(disposables).toHaveLength(1);
    subscription.dispose();
    expect(host.folderListeners).toHaveLength(0);
  });
});
