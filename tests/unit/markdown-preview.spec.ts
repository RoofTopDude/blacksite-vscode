import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { showMarkdownPreview } from "../../src/markdown-preview.js";

describe("showMarkdownPreview", () => {
  it("opens Markdown through VS Code's rendered preview command", async () => {
    const uri = vscode.Uri.file("C:/workspace/report.md");
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand");

    await showMarkdownPreview(uri);

    expect(executeCommand).toHaveBeenCalledWith("markdown.showPreview", uri);
  });
});
