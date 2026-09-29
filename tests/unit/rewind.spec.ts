/* Rewind. The file side is the diff journal replayed backwards to a turn's sequence number; the
   conversation side is a session snapshot. The contract these specs pin: exactly the recorded
   changes are undone, a file whose earlier content was not kept is named and never deleted, a
   file changed since is flagged before it is overwritten, and what rewind cannot undo is listed. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EditDiffJournal } from "../../src/edit-diff-journal.js";
import { describeRewind, RewindRegistry, rewindNote, untrackedEffect, type RewindPoint } from "../../src/rewind.js";
import { AgentSession } from "../../src/agent-session.js";
import { rewindTargetFor, truncateTurnsFrom, createChatState, createUserTurn, createAssistantTurn } from "../../src/webview/react/lib/chat-model.js";
import * as vscodeMock from "./helpers/vscode-mock.js";

type MockWorkspace = typeof vscodeMock.workspace & { textDocuments?: unknown[]; fs?: Record<string, unknown> };
const workspace = vscodeMock.workspace as MockWorkspace;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-rewind-"));
  workspace.textDocuments = [];
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => fs.promises.readFile(uri.fsPath),
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => fs.promises.writeFile(uri.fsPath, bytes),
    delete: async (uri: { fsPath: string }) => fs.promises.rm(uri.fsPath),
    createDirectory: async (uri: { fsPath: string }) => { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
    stat: async (uri: { fsPath: string }) => {
      const stat = await fs.promises.stat(uri.fsPath);
      return { type: stat.isDirectory() ? vscodeMock.FileType.Directory : vscodeMock.FileType.File, size: stat.size };
    },
  };
});
afterEach(() => {
  delete workspace.textDocuments;
  delete workspace.fs;
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (rel: string) => path.join(root, rel);
const read = (rel: string) => fs.readFileSync(file(rel), "utf8");

/** One recorded tool call: snapshot, change the file on disk, record the after-state. */
async function recordWrite(journal: EditDiffJournal, id: string, rel: string, content: string | null): Promise<void> {
  await journal.captureBefore(id, content === null ? "file_delete" : "file_write", { path: rel });
  if (content === null) fs.rmSync(file(rel));
  else fs.writeFileSync(file(rel), content);
  await journal.captureAfter(id, true);
}

describe("restoring files from the edit journal", () => {
  it("puts changed files back, removes created ones, and leaves earlier history alone", async () => {
    fs.writeFileSync(file("a.ts"), "original a");
    fs.writeFileSync(file("keep.ts"), "keep v1");
    const journal = new EditDiffJournal(root);
    await recordWrite(journal, "c0", "keep.ts", "keep v2"); // before the rewind point
    const point = journal.sequence;
    await recordWrite(journal, "c1", "a.ts", "a changed once");
    await recordWrite(journal, "c2", "a.ts", "a changed twice");
    await recordWrite(journal, "c3", "new.ts", "created");

    const plan = await journal.planRestore(point);
    expect(plan.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "a.ts", action: "restore", content: "original a", modifiedSince: false }),
      expect.objectContaining({ path: "new.ts", action: "delete", modifiedSince: false }),
    ]));
    expect(plan.files.some((f) => f.path === "keep.ts")).toBe(false);

    const outcome = await journal.applyRestore(plan);
    expect(outcome).toEqual({ restored: ["a.ts"], deleted: ["new.ts"], failed: [] });
    expect(read("a.ts")).toBe("original a");
    expect(fs.existsSync(file("new.ts"))).toBe(false);
    expect(read("keep.ts")).toBe("keep v2");
  });

  it("brings back a file the agent deleted", async () => {
    fs.writeFileSync(file("gone.ts"), "precious");
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    await recordWrite(journal, "d1", "gone.ts", null);
    await journal.applyRestore(await journal.planRestore(point));
    expect(read("gone.ts")).toBe("precious");
  });

  it("flags a file changed after the agent's last edit before overwriting it", async () => {
    fs.writeFileSync(file("a.ts"), "v1");
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    await recordWrite(journal, "c1", "a.ts", "v2");
    fs.writeFileSync(file("a.ts"), "v2 plus the user's own edit");
    const plan = await journal.planRestore(point);
    expect(plan.files).toEqual([expect.objectContaining({ path: "a.ts", modifiedSince: true })]);
  });

  it("names a binary file it cannot restore and never deletes it", async () => {
    fs.writeFileSync(file("logo.bin"), Buffer.from([0, 1, 2, 3]));
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    await journal.captureBefore("b1", "file_write", { path: "logo.bin" });
    fs.writeFileSync(file("logo.bin"), "now text");
    await journal.captureAfter("b1", true);
    const plan = await journal.planRestore(point);
    expect(plan.files).toEqual([]);
    expect(plan.unrestorable).toEqual([{ path: "logo.bin", reason: "it is a binary file" }]);
    await journal.applyRestore(plan);
    expect(fs.existsSync(file("logo.bin"))).toBe(true);
  });

  it("says nothing about a binary file the call never changed", async () => {
    fs.writeFileSync(file("logo.bin"), Buffer.from([0, 1, 2, 3]));
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    await journal.captureBefore("b1", "file_write", { path: "logo.bin" });
    await journal.captureAfter("b1", false); // the write failed; the bytes are unchanged
    expect(await journal.planRestore(point)).toEqual({ files: [], unrestorable: [] });
  });

  it("restores the exact bytes of a file that is not UTF-8", async () => {
    const latin1 = Buffer.from("caf\xe9\n", "latin1");
    fs.writeFileSync(file("legacy.txt"), latin1);
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    await recordWrite(journal, "l1", "legacy.txt", "rewritten");
    await journal.applyRestore(await journal.planRestore(point));
    expect(fs.readFileSync(file("legacy.txt")).equals(latin1)).toBe(true);
  });

  it("journals the restore itself, so a later rewind sees accurate history", async () => {
    fs.writeFileSync(file("a.ts"), "v1");
    const journal = new EditDiffJournal(root);
    const first = journal.sequence;
    await recordWrite(journal, "c1", "a.ts", "v2");
    const second = journal.sequence;
    await recordWrite(journal, "c2", "a.ts", "v3");
    await journal.applyRestore(await journal.planRestore(second)); // back to v2
    expect(read("a.ts")).toBe("v2");
    const plan = await journal.planRestore(first);
    expect(plan.files).toEqual([expect.objectContaining({ path: "a.ts", content: "v1", modifiedSince: false })]);
  });

  it("snapshots files a language-server edit names only once applied", async () => {
    fs.writeFileSync(file("x.ts"), "x before");
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    await journal.captureFiles("rename-1", "code_rename", ["x.ts"]);
    fs.writeFileSync(file("x.ts"), "x after");
    await journal.captureAfter("rename-1", true);
    const plan = await journal.planRestore(point);
    expect(plan.files).toEqual([expect.objectContaining({ path: "x.ts", content: "x before" })]);
  });

  it("reports files whose history was evicted instead of restoring less than it claims", async () => {
    const journal = new EditDiffJournal(root);
    const point = journal.sequence;
    for (let i = 0; i < 252; i++) {
      fs.writeFileSync(file(`f${i}.ts`), `v${i}`);
      await recordWrite(journal, `c${i}`, `f${i}.ts`, `changed ${i}`);
    }
    const plan = await journal.planRestore(point);
    expect(plan.unrestorable.map((u) => u.path)).toEqual(expect.arrayContaining(["f0.ts", "f1.ts"]));
    expect(plan.unrestorable[0]!.reason).toMatch(/dropped from the edit history/);
    // ~250 files written and journaled: under a full parallel coverage run on Windows the disk
    // contention alone pushes it past the 5s default, though it takes under a second on its own.
  }, 20_000);
});

describe("rewind points and effects", () => {
  const point = (turnId: string): RewindPoint => ({
    turnId, sessionId: "s1", journalSeq: 0, snapshot: { messages: [], fullHistory: [], state: {} }, userText: turnId, createdAt: 0, untracked: [],
  });

  it("keeps points in order and truncates from a turn", () => {
    const registry = new RewindRegistry();
    registry.add(point("t1"));
    registry.add(point("t2"));
    registry.add(point("t3"));
    registry.recordUntracked("t2", "ran `npm install`");
    registry.recordUntracked("t2", "ran `npm install`");
    registry.recordUntracked("t3", null);
    expect(registry.from("t2").map((p) => p.turnId)).toEqual(["t2", "t3"]);
    expect(registry.get("t2")!.untracked).toEqual(["ran `npm install`"]);
    registry.truncateFrom("t2");
    expect(registry.turnIds("s1")).toEqual(["t1"]);
  });

  it("names the side effects the journal cannot undo, and only those", () => {
    expect(untrackedEffect("shell_run", { command: "rg", args: ["TODO"] })).toBeNull();
    expect(untrackedEffect("shell_run", { command: "npm", args: ["install"] })).toBe("ran `npm install`");
    expect(untrackedEffect("git_op", { op: "status" })).toBeNull();
    expect(untrackedEffect("git_op", { op: "commit" })).toBe("git commit");
    expect(untrackedEffect("github_create_pr", {})).toBe("github create pr");
    expect(untrackedEffect("mcp_call_tool", { toolName: "deploy" })).toBe("called MCP tool deploy");
    expect(untrackedEffect("file_write", { path: "a" })).toBeNull();
  });

  it("describes what will change, what is lost and what is not undone", () => {
    const text = describeRewind(
      {
        files: [
          { path: "a.ts", action: "restore", content: "x", modifiedSince: true },
          { path: "new.ts", action: "delete", modifiedSince: false },
        ],
        unrestorable: [{ path: "logo.png", reason: "it is a binary file" }],
      },
      ["ran `npm install`", "ran `npm install`", "git commit"],
    );
    expect(text).toContain("Files put back as they were (1): a.ts.");
    expect(text).toContain("removed to the trash (1): new.ts.");
    expect(text).toContain("discards those changes too: a.ts.");
    expect(text).toContain("logo.png (it is a binary file)");
    expect(text).toContain("Not undone — effects outside the edit history: ran `npm install`, git commit.");
    expect(rewindNote("code", ["a.ts"])).toContain("Re-read a file before editing it: a.ts.");
    expect(rewindNote("code", [])).toBe("");
  });
});

describe("conversation rewind in the session", () => {
  function session() {
    return new AgentSession({
      apiKey: "k", model: "claude-sonnet-4-6", systemPrompt: "s", workspaceRoot: root, provider: "anthropic",
      runtime: { handleMessage: vi.fn() } as any, context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
      checkpointingEnabled: false, memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    });
  }

  it("returns messages, recorded prompts and loaded tools to the snapshot", () => {
    const s = session();
    s.restoreState({ messages: [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "one" }] }], userPrompts: ["first"], loadedTools: ["plan_update"] } as any);
    const snapshot = s.captureRewindSnapshot();
    s.restoreState({ messages: [...snapshot.messages, { role: "user", content: "second" }, { role: "assistant", content: [{ type: "text", text: "two" }] }], userPrompts: ["first", "second"], loadedTools: ["plan_update", "ticket_file"] } as any);
    s.rewindTo(snapshot);
    expect(s.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.userPrompts).toEqual(["first"]);
    expect(s.exportState().loadedTools).toEqual(["plan_update"]);
  });

  it("drops a background compaction that finishes after a rewind replaced the history", async () => {
    const s = session();
    const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }));
    s.restoreState({ messages: many } as any);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = { compress: vi.fn(async () => { await gate; return "summary"; }) };
    const snapshot = { messages: many.slice(0, 2), fullHistory: many.slice(0, 2), state: {} } as any;
    const pending = (s as any)._compressHistory(provider, "auto");
    s.rewindTo(snapshot);
    release();
    expect(await pending).toBe("skipped");
    expect(s.history).toHaveLength(2);
    expect(s.exportState().compressedSummary).toBeUndefined();
  });
});

describe("rewind in the transcript", () => {
  it("targets the assistant turn after a user message, and truncates from that message", () => {
    const chat = createChatState();
    const u1 = createUserTurn(chat, "first", null);
    const a1 = createAssistantTurn(chat, "turn_1");
    const u2 = createUserTurn(chat, "second", null);
    createAssistantTurn(chat, "turn_2");
    expect(rewindTargetFor(chat.turns, u2.id, ["turn_1", "turn_2"])).toBe("turn_2");
    expect(rewindTargetFor(chat.turns, u1.id, ["turn_2"])).toBeNull();
    expect(truncateTurnsFrom(chat, "turn_2")).toBe("second");
    expect(chat.turns.map((t) => t.id)).toEqual([u1.id, a1.id]);
    expect(chat.byId.has("turn_2")).toBe(false);
    expect(chat.userTurnCount).toBe(1);
  });
});
