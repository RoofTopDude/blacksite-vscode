import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EditDiffJournal } from "../../src/edit-diff-journal.js";
import * as vscodeMock from "./helpers/vscode-mock.js";

/* The journal reads through vscode.workspace.fs and the open-document list, which the shared mock
   does not model. Both are attached per test and removed afterwards. */
type MockWorkspace = typeof vscodeMock.workspace & {
  textDocuments?: unknown[];
  fs?: { readFile(uri: { fsPath: string }): Promise<Uint8Array> };
};
const workspace = vscodeMock.workspace as MockWorkspace;

interface JournalInternals {
  _bytes: number;
  _entries: Map<string, { bytes: number }>;
}

function accounted(journal: EditDiffJournal): { total: number; sum: number } {
  const state = journal as unknown as JournalInternals;
  return { total: state._bytes, sum: [...state._entries.values()].reduce((acc, entry) => acc + entry.bytes, 0) };
}

let root: string;
let gate: Promise<void> | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-diff-journal-"));
  gate = undefined;
  workspace.textDocuments = [];
  workspace.fs = {
    async readFile(uri) {
      if (gate) await gate;
      return fs.promises.readFile(uri.fsPath);
    },
  };
});

afterEach(() => {
  delete workspace.textDocuments;
  delete workspace.fs;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("EditDiffJournal", () => {
  it("reports the files a call changed, with line stats", async () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "one\ntwo\n");
    const journal = new EditDiffJournal(root);

    await journal.captureBefore("call-1", "file_write", { path: "a.txt" });
    fs.writeFileSync(file, "one\nTWO\nthree\n");
    const diffs = await journal.captureAfter("call-1", true);

    expect(diffs).toEqual([{ path: "a.txt", additions: 2, deletions: 1, kind: "modified", line: 2 }]);
    expect(journal.has("call-1", "a.txt")).toBe(true);
    const { total, sum } = accounted(journal);
    expect(total).toBe(sum);
    journal.dispose();
  });

  /* A retried call (or another lane's eviction) can drop the entry while captureAfter is reading
     the file. Its bytes were already subtracted, so adding the read afterwards inflated the total
     permanently — and every later eviction pass then emptied the whole journal. */
  it("keeps the byte total honest when the entry is replaced mid-read", async () => {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "before\n");
    const journal = new EditDiffJournal(root);
    await journal.captureBefore("call-1", "file_write", { path: "a.txt" });
    fs.writeFileSync(file, "after, and considerably longer than before\n");

    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = journal.captureAfter("call-1", true);
    // The retry snapshots again while the first pass is still waiting on its read.
    gate = undefined;
    await journal.captureBefore("call-1", "file_write", { path: "a.txt" });
    release();

    await expect(pending).resolves.toEqual([]);
    const { total, sum } = accounted(journal);
    expect(total).toBe(sum);
    journal.dispose();
  });
});
