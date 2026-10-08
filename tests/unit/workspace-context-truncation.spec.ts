import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  summarizeBaseContextForPrompt,
  summarizeWorkspaceRulesForContext,
  summarizeWorkspaceRulesForPrompt,
} from "../../src/base-context-store.js";
import { gatherWorkspaceSnapshot, invalidateWorkspaceContextCache } from "../../src/workspace-context.js";

/* The workspace block rides in the model's view of the user's own turn. A section that simply
   stopped mid-sentence read as the user's message having been cut off, so every section that
   is clipped to fit its budget now says so — and says where the rest lives. */

describe("clipped sections of the workspace state say they were clipped", () => {
  let root: string;
  const workspace = vscode.workspace as unknown as { textDocuments?: unknown[] };
  const runtime = { handleMessage: async () => ({ result: { ok: false, message: "not a git repository" } }) };

  const write = (name: string, body: string): void => {
    fs.writeFileSync(path.join(root, ".blacksite", name), body, "utf8");
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-clip-"));
    fs.mkdirSync(path.join(root, ".blacksite"), { recursive: true });
    vscode.workspace.workspaceFolders = [{ name: "workspace", index: 0, uri: vscode.Uri.file(root) }];
    workspace.textDocuments = [];
    invalidateWorkspaceContextCache();
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders = undefined;
    workspace.textDocuments = undefined;
    invalidateWorkspaceContextCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("marks context.md when only its first part is shown, and not when it all fits", async () => {
    write("context.md", `${"x".repeat(5_000)}\nTHE END\n`);
    const clipped = (await gatherWorkspaceSnapshot(root, runtime as never)).baseContext;
    expect(clipped.startsWith("x".repeat(4_000))).toBe(true);
    expect(clipped).not.toContain("THE END");
    expect(clipped).toContain("context.md continues beyond this point");
    expect(clipped).toContain(".blacksite/context.md");

    write("context.md", "Short and complete.\n");
    const whole = (await gatherWorkspaceSnapshot(root, runtime as never)).baseContext;
    expect(whole).toBe("Short and complete.\n");
  });

  it("marks memory.md when its older notes are dropped, and starts on a whole note", async () => {
    const notes = Array.from({ length: 200 }, (_, i) => `note ${String(i).padStart(4, "0")} ${"-".repeat(40)}`);
    write("memory.md", `${notes.join("\n")}\n`);
    const memory = (await gatherWorkspaceSnapshot(root, runtime as never)).projectMemory;

    const [marker, ...rest] = memory.split("\n");
    expect(marker).toContain("earlier content of memory.md is not shown here");
    // The first retained line is a complete note, not the tail end of one the cut landed inside.
    expect(rest[0]).toMatch(/^note \d{4} -{40}$/);
    expect(memory).toContain("note 0199");
    expect(memory).not.toContain("note 0000");

    write("memory.md", "# Memory\n- one short note\n");
    expect((await gatherWorkspaceSnapshot(root, runtime as never)).projectMemory).toBe("# Memory\n- one short note\n");
  });

  it("marks workspace rules in the model's context, but leaves the editor's copy untouched", () => {
    write("workspace-rules.md", "Rule one.\nRule two.\nRule three.\n");

    const forContext = summarizeWorkspaceRulesForContext(root, 12);
    expect(forContext.startsWith("Rule one.\nRu\n[…")).toBe(true);
    expect(forContext).not.toContain("Rule two");
    expect(forContext).toContain("workspace-rules.md continues beyond this point");

    // The Workspace Rules editor shows this text and saves whatever it shows back to the file.
    expect(summarizeWorkspaceRulesForPrompt(root, 12)).toBe("Rule one.\nRu");

    expect(summarizeWorkspaceRulesForContext(root)).toBe("Rule one.\nRule two.\nRule three.");
    expect(summarizeWorkspaceRulesForContext(path.join(root, "nowhere"))).toBe("");
  });

  describe("Base Context", () => {
    const topics = (count: number) => Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      title: `Topic ${i}`,
      notes: `${"n".repeat(600)}`,
      enabled: true,
      pinned: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: `2026-01-01T00:00:${String(59 - i).padStart(2, "0")}.000Z`,
      files: [],
    }));

    it("says how many enabled topics did not fit", () => {
      write("base-context.json", JSON.stringify({ schemaVersion: 1, updatedAt: null, topics: topics(12) }));
      const summary = summarizeBaseContextForPrompt(root, 1_500);
      const shown = summary.split("\n").filter((line) => /^- Topic \d+$/.test(line)).length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(12);
      expect(summary).toContain(`${12 - shown} more enabled topics not shown here`);
      expect(summary).toContain(".blacksite/base-context.json");
    });

    it("adds nothing when every enabled topic is shown", () => {
      write("base-context.json", JSON.stringify({ schemaVersion: 1, updatedAt: null, topics: topics(2) }));
      const summary = summarizeBaseContextForPrompt(root);
      expect(summary).toContain("- Topic 0");
      expect(summary).toContain("- Topic 1");
      expect(summary).not.toContain("not shown here");
    });
  });
});
