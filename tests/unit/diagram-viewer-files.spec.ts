import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The viewer host's file-backed tabs: a tab that follows a saved diagram, writes edits back to
   it, becomes a file's tab when saved to the project, and comes back after a window reload.
   `vscode` is the shared unit-test mock plus the few pieces a webview panel needs. */

interface FakePanel {
  title: string;
  iconPath: unknown;
  viewColumn: number;
  revealed: number;
  disposed: boolean;
  html: string;
  posted: Array<Record<string, unknown>>;
  receive: ((message: unknown) => void) | undefined;
  onDispose: Array<() => void>;
  webview: Record<string, unknown>;
  reveal(): void;
  onDidDispose(listener: () => void): { dispose(): void };
  dispose(): void;
}

interface FakeWatcher {
  change: Array<() => void>;
  create: Array<() => void>;
  remove: Array<() => void>;
  disposed: boolean;
}

const hoisted = vi.hoisted(() => ({
  panels: [] as unknown[],
  watchers: [] as unknown[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  serializer: undefined as undefined | { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> },
  infoMessages: [] as string[],
}));

vi.mock("vscode", async () => {
  const mock = await import("./helpers/vscode-mock.js");
  const makePanel = (title: string): FakePanel => {
    const panel: FakePanel = {
      title, iconPath: undefined, viewColumn: 1, revealed: 0, disposed: false, html: "", posted: [],
      receive: undefined, onDispose: [],
      webview: {
        options: {},
        cspSource: "'self'",
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async (message: Record<string, unknown>) => { panel.posted.push(message); return true; },
        onDidReceiveMessage: (listener: (message: unknown) => void) => { panel.receive = listener; return { dispose: () => { panel.receive = undefined; } }; },
        set html(value: string) { panel.html = value; },
        get html() { return panel.html; },
      },
      reveal() { panel.revealed += 1; },
      onDidDispose(listener) { panel.onDispose.push(listener); return { dispose: () => undefined }; },
      dispose() { panel.disposed = true; for (const listener of panel.onDispose) listener(); },
    };
    hoisted.panels.push(panel);
    return panel;
  };
  return {
    ...mock,
    ViewColumn: { Active: -1 },
    RelativePattern: class RelativePattern { constructor(readonly base: string, readonly pattern: string) {} },
    window: {
      ...mock.window,
      showInformationMessage: async (message: string) => { hoisted.infoMessages.push(message); return undefined; },
      showWarningMessage: async () => undefined,
      createWebviewPanel: (_type: string, title: string) => makePanel(title),
      registerWebviewPanelSerializer: (_type: string, serializer: typeof hoisted.serializer) => { hoisted.serializer = serializer; return { dispose: () => undefined }; },
    },
    workspace: {
      ...mock.workspace,
      createFileSystemWatcher: () => {
        const watcher: FakeWatcher = { change: [], create: [], remove: [], disposed: false };
        hoisted.watchers.push(watcher);
        return {
          onDidChange: (listener: () => void) => { watcher.change.push(listener); },
          onDidCreate: (listener: () => void) => { watcher.create.push(listener); },
          onDidDelete: (listener: () => void) => { watcher.remove.push(listener); },
          dispose: () => { watcher.disposed = true; },
        };
      },
    },
    commands: {
      ...mock.commands,
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { hoisted.commands.set(name, handler); return { dispose: () => undefined }; },
    },
  };
});

import * as vscode from "vscode";
import { DiagramViewer, OPEN_DIAGRAM_COMMAND, SAVE_DIAGRAM_COMMAND } from "../../src/diagrams/diagram-viewer.js";
import { DiagramStore } from "../../src/diagrams/diagram-store.js";

let root = "";
let store: DiagramStore;
let viewer: DiagramViewer;

const panels = (): FakePanel[] => hoisted.panels as FakePanel[];
const watchers = (): FakeWatcher[] => hoisted.watchers as FakeWatcher[];
const SOURCE = "---\ntitle: Request flow\n---\nflowchart TD\n  A --> B";
const EDITED = "---\ntitle: Request flow\n---\nflowchart TD\n  A --> B\n  B --> C";

async function send(panel: FakePanel, message: Record<string, unknown>): Promise<void> {
  panel.receive?.(message);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const posted = (panel: FakePanel, type: string): Array<Record<string, unknown>> => panel.posted.filter((message) => message["type"] === type);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-viewer-"));
  store = new DiagramStore(root);
  hoisted.panels.length = 0;
  hoisted.watchers.length = 0;
  hoisted.commands.clear();
  hoisted.infoMessages.length = 0;
  const context = { extensionUri: vscode.Uri.file(root), subscriptions: [] } as unknown as vscode.ExtensionContext;
  viewer = new DiagramViewer(context).register();
  viewer.setWorkspaceRoot(root);
});
afterEach(() => {
  viewer.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function saved(name = "flow", source = SOURCE): string {
  store.write(name, source);
  return store.resolve(name)!;
}

describe("a tab that follows a saved diagram", () => {
  it("opens with the file's source and tells the webview which file it is", async () => {
    const file = saved();
    expect(viewer.openFile(file)).toBe(true);
    const [panel] = panels();
    expect(panel!.title).toBe("Request flow · Flowchart");
    await send(panel!, { type: "diagram_ready" });
    expect(posted(panel!, "diagram_init")[0]).toMatchObject({
      source: SOURCE,
      file: { name: "flow.mmd", path: ".blacksite/context/diagrams/flow.mmd" },
    });
  });

  it("reveals the existing tab instead of opening a second one", () => {
    const file = saved();
    viewer.openFile(file);
    viewer.openFile(file);
    expect(panels()).toHaveLength(1);
    expect(panels()[0]!.revealed).toBe(1);
  });

  it("redraws when the file changes, and ignores a change that leaves the source as it was", async () => {
    const file = saved();
    viewer.openFile(file);
    const panel = panels()[0]!;
    const watcher = watchers()[0]!;

    store.write("flow", EDITED, { overwrite: true });
    for (const listener of watcher.change) listener();
    expect(posted(panel, "diagram_update")).toEqual([
      expect.objectContaining({ source: EDITED, file: expect.objectContaining({ name: "flow.mmd" }) }),
    ]);

    for (const listener of watcher.change) listener(); // same content again
    expect(posted(panel, "diagram_update")).toHaveLength(1);
  });

  it("warns, but keeps the last version, when the file is deleted", async () => {
    const file = saved();
    viewer.openFile(file);
    for (const listener of watchers()[0]!.remove) listener();
    expect(posted(panels()[0]!, "diagram_notice")[0]).toMatchObject({ level: "error" });
  });

  it("writes the tab's edits back to the file", async () => {
    const file = saved();
    viewer.openFile(file);
    const panel = panels()[0]!;
    await send(panel, { type: "diagram_write", source: EDITED });
    expect(store.read("flow")).toMatchObject({ ok: true, source: EDITED });
    expect(posted(panel, "diagram_update")[0]).toMatchObject({ source: EDITED });
    expect(posted(panel, "diagram_notice").at(-1)).toMatchObject({ level: "info", message: "Saved flow.mmd" });
  });

  it("refuses a write from a tab that is not backed by a file, and writes nothing", async () => {
    viewer.open(SOURCE);
    const panel = panels()[0]!;
    await send(panel, { type: "diagram_write", source: EDITED });
    expect(posted(panel, "diagram_notice")[0]).toMatchObject({ level: "error" });
    expect(store.list()).toEqual([]);
  });

  it("stops watching when the tab is closed", () => {
    const file = saved();
    viewer.openFile(file);
    panels()[0]!.dispose();
    expect(watchers()[0]!.disposed).toBe(true);
    // And the file can be opened again afterwards.
    expect(viewer.openFile(file)).toBe(true);
    expect(panels()).toHaveLength(2);
  });

  it("will not open a path outside the saved diagrams folder", () => {
    const outside = path.join(root, "elsewhere.mmd");
    fs.writeFileSync(outside, SOURCE);
    expect(viewer.openFile(outside)).toBe(false);
    expect(panels()).toHaveLength(0);
  });
});

describe("saving a diagram to the project", () => {
  it("makes an unsaved tab the tab of the new file", async () => {
    viewer.open(SOURCE);
    const panel = panels()[0]!;
    await send(panel, { type: "diagram_save_to_project", source: SOURCE });

    expect(store.list().map((entry) => entry.name)).toEqual(["request-flow.mmd"]);
    expect(posted(panel, "diagram_update")[0]).toMatchObject({ file: { name: "request-flow.mmd" } });
    // From here the tab follows the file: opening it again reveals this tab.
    viewer.openFile(store.resolve("request-flow")!);
    expect(panels()).toHaveLength(1);
    expect(panel.revealed).toBe(1);
    expect(watchers()).toHaveLength(1);
  });

  it("does not overwrite a diagram that already has the name", async () => {
    saved("request-flow", "flowchart TD\n  X --> Y");
    viewer.open(SOURCE);
    await send(panels()[0]!, { type: "diagram_save_to_project", source: SOURCE });
    expect(store.list().map((entry) => entry.name).sort()).toEqual(["request-flow-2.mmd", "request-flow.mmd"]);
    expect(store.read("request-flow")).toMatchObject({ source: "flowchart TD\n  X --> Y" });
  });

  it("is also a command, for the Save button on a diagram in the chat", async () => {
    await hoisted.commands.get(SAVE_DIAGRAM_COMMAND)!({ source: SOURCE });
    expect(store.list().map((entry) => entry.name)).toEqual(["request-flow.mmd"]);
    expect(hoisted.infoMessages[0]).toMatch(/Saved \.blacksite\/context\/diagrams\/request-flow\.mmd/);
  });

  it("opens a saved diagram through the open command's file argument", async () => {
    const file = saved();
    await hoisted.commands.get(OPEN_DIAGRAM_COMMAND)!({ file });
    expect(panels()).toHaveLength(1);
  });
});

describe("restoring tabs after a reload", () => {
  it("brings a file-backed tab back showing the file as it is now", async () => {
    const file = saved("flow", EDITED);
    const restored = (hoisted.serializer!.deserializeWebviewPanel as (panel: unknown, state: unknown) => Promise<void>);
    const fake = createRestoredPanel();
    await restored(fake, { diagram: { source: SOURCE, file: { name: "flow.mmd", path: path.relative(root, file).split(path.sep).join("/") } } });
    await send(fake, { type: "diagram_ready" });
    expect(posted(fake, "diagram_init")[0]).toMatchObject({ source: EDITED, file: { name: "flow.mmd" } });
    expect(watchers()).toHaveLength(1);
  });

  it("falls back to the remembered source, unbacked, when the file is gone", async () => {
    const fake = createRestoredPanel();
    await hoisted.serializer!.deserializeWebviewPanel(fake, { diagram: { source: SOURCE, file: { name: "gone.mmd", path: ".blacksite/context/diagrams/gone.mmd" } } });
    await send(fake, { type: "diagram_ready" });
    const init = posted(fake, "diagram_init")[0]!;
    expect(init["source"]).toBe(SOURCE);
    expect(init["file"]).toBeUndefined();
    expect(watchers()).toHaveLength(0);
  });

  it("drops a tab with nothing to show", async () => {
    const fake = createRestoredPanel();
    await hoisted.serializer!.deserializeWebviewPanel(fake, { diagram: {} });
    expect(fake.disposed).toBe(true);
  });

  it("cannot be pointed outside the project by a remembered path", async () => {
    const outside = path.join(os.tmpdir(), `bs-outside-${Date.now()}.mmd`);
    fs.writeFileSync(outside, "flowchart TD\n  EVIL --> X");
    try {
      const fake = createRestoredPanel();
      await hoisted.serializer!.deserializeWebviewPanel(fake, { diagram: { source: SOURCE, file: { path: path.relative(root, outside) } } });
      await send(fake, { type: "diagram_ready" });
      expect(posted(fake, "diagram_init")[0]).toMatchObject({ source: SOURCE });
      expect(posted(fake, "diagram_init")[0]!["file"]).toBeUndefined();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

function createRestoredPanel(): FakePanel {
  const factory = (vscode.window as unknown as { createWebviewPanel(type: string, title: string): FakePanel }).createWebviewPanel;
  const panel = factory("blacksite.diagramViewer", "restored");
  // The panel was just recorded as a fresh tab; VS Code hands the serializer one it created.
  hoisted.panels.pop();
  return panel;
}
