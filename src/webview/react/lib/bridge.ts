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
