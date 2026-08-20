import * as vscode from "vscode";

/** Open a Markdown URI in VS Code's rendered preview instead of the raw text editor. */
export async function showMarkdownPreview(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("markdown.showPreview", uri);
}
