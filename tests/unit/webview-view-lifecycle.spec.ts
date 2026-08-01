import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { TicketProvider } from "../../src/ticket-provider.js";
import { TicketStore } from "../../src/ticket-store.js";

/**
 * None of these views set `retainContextWhenHidden`, so VS Code disposes a webview view when it
 * is hidden and calls resolveWebviewView again when it is shown. Registering the message
 * listener into `context.subscriptions` therefore stranded one dead listener — and the dead
 * webview it holds — per hide/show cycle, for the life of the window. The listener has to be
 * scoped to the view that owns it.
 */

interface FakeDisposable { dispose: () => void; disposed: boolean }

function disposable(): FakeDisposable {
  const d: FakeDisposable = { disposed: false, dispose: () => { d.disposed = true; } };
  return d;
}

function fakeWebviewView(): { view: vscode.WebviewView; registrations: FakeDisposable[] } {
  const registrations: FakeDisposable[] = [];
  /* Mirrors VS Code's Event<T> signature: (listener, thisArg?, disposables?) — including the
     third argument, which appends the registration to the caller's collection. Emulating that
     is the whole point here, since routing it to context.subscriptions is the bug. */
  const track = (_listener?: unknown, _thisArg?: unknown, disposables?: FakeDisposable[]): FakeDisposable => {
    const d = disposable();
    registrations.push(d);
    if (Array.isArray(disposables)) disposables.push(d);
    return d;
  };
  const view = {
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: track,
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: unknown) => uri,
      cspSource: "vscode-webview:",
    },
    visible: true,
    onDidChangeVisibility: track,
    onDidDispose: track,
  } as unknown as vscode.WebviewView;
  return { view, registrations };
}

let root: string;
let context: vscode.ExtensionContext;
let provider: TicketProvider;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-viewlife-"));
  context = {
    extensionUri: vscode.Uri.file(root),
    subscriptions: [] as vscode.Disposable[],
  } as unknown as vscode.ExtensionContext;
  const store = new TicketStore(root, () => [], () => false, () => []);
  store.ensureInitialized();
  provider = new TicketProvider(context, store, root);
});

afterEach(() => {
  provider.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("webview view lifecycle", () => {
  it("releases the previous view's registrations when the view is re-resolved", () => {
    const first = fakeWebviewView();
    provider.resolveWebviewView(first.view);
    expect(first.registrations.length).toBeGreaterThan(0);
    expect(first.registrations.every((d) => d.disposed)).toBe(false);

    const second = fakeWebviewView();
    provider.resolveWebviewView(second.view);

    // Everything the first view registered is gone; the live view keeps its own.
    expect(first.registrations.every((d) => d.disposed)).toBe(true);
    expect(second.registrations.every((d) => d.disposed)).toBe(false);
  });

  it("does not grow context.subscriptions across hide/show cycles", () => {
    const before = context.subscriptions.length;
    for (let i = 0; i < 25; i += 1) provider.resolveWebviewView(fakeWebviewView().view);
    expect(context.subscriptions.length).toBe(before);
  });

  it("releases the live view's registrations on dispose", () => {
    const only = fakeWebviewView();
    provider.resolveWebviewView(only.view);
    provider.dispose();
    expect(only.registrations.every((d) => d.disposed)).toBe(true);
  });
});
