/* Thin wrapper around the VS Code webview API. acquireVsCodeApi() may only be
   called once per webview, so it is centralized here. Generic across all four
   webview surfaces; callers layer their own typed message unions on top. */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode: VsCodeApi = acquireVsCodeApi();

export function post(message: unknown): void {
  vscode.postMessage(message);
}

/**
 * Per-surface persisted UI state, keyed so several features can share one webview's slot.
 *
 * VS Code restores this when a hidden view is reconstructed, which is the only reason a
 * sidebar's filters and sort survive being tabbed away from — without it every tab switch
 * silently resets the view the user set up.
 */
export function readUiState<T>(key: string, fallback: T): T {
  const state = vscode.getState();
  if (!state || typeof state !== "object") return fallback;
  const slot = (state as Record<string, unknown>)[key];
  return slot === undefined ? fallback : { ...fallback, ...(slot as object) };
}

export function writeUiState(key: string, value: unknown): void {
  const state = vscode.getState();
  const base = state && typeof state === "object" ? state as Record<string, unknown> : {};
  vscode.setState({ ...base, [key]: value });
}

export function onMessage(handler: (message: any) => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data;
    if (data && typeof data === "object" && typeof data.type === "string") {
      handler(data);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
