import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Cryptographically-irrelevant but sufficient nonce for the webview CSP. */
function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
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
  const nonce = makeNonce();
  let html: string;
  try { html = fs.readFileSync(shellPath, "utf8"); }
  catch { return "<h1>Blacksite — webview not found. Run `npm run build`.</h1>"; }
  return html
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
    .replace(/\{\{nonce\}\}/g, nonce);
}
