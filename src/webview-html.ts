import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** Unpredictable per-render nonce for the webview CSP. */
export function createWebviewNonce(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Render the shared HTML shell (out/webview/shell.html) with a nonce'd script tag
 * pointing at the given React entry bundle (out/webview/<scriptFile>). Used by
 * every webview provider; any shared chunks are loaded from the same webview
 * origin under the shell CSP.
 */
export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  scriptFile: string,
): string {
  const shellPath = path.join(extensionUri.fsPath, "out", "webview", "shell.html");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "webview", scriptFile),
  );
  const fontsBase = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "webview", "fonts"),
  );
  const nonce = createWebviewNonce();
  let html: string;
  try { html = fs.readFileSync(shellPath, "utf8"); }
  catch { return "<h1>Blacksite — webview not found. Run `npm run build`.</h1>"; }
  return html
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
    .replace(/\{\{fontsBase\}\}/g, fontsBase.toString())
    .replace(/\{\{nonce\}\}/g, nonce);
}
