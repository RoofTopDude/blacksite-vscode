import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReferenceStore } from "../../src/reference-store.js";

let root: string;
let store: ReferenceStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-ref-"));
  store = new ReferenceStore(root);
  store.ensureInitialized();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSourceFile(name: string, content: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("ReferenceStore", () => {
  it("copies an attachment into a permanent per-session directory", () => {
    const src = writeSourceFile("report.csv", "a,b\n1,2\n");
    const attachment = store.copyAttachment("s_1", src, "report.csv");

    expect(attachment.name).toBe("report.csv");
    expect(attachment.byteSize).toBe(fs.statSync(src).size);
    expect(fs.existsSync(attachment.path)).toBe(true);
    expect(attachment.path.startsWith(store.sessionDir("s_1"))).toBe(true);
    // Permanent workspace-local storage, not an OS temp directory.
    expect(attachment.path.startsWith(path.join(root, ".blacksite", "reference", "s_1"))).toBe(true);
  });

  it("de-duplicates colliding filenames within the same session", () => {
    const src = writeSourceFile("notes.txt", "first");
    const a = store.copyAttachment("s_1", src, "notes.txt");
    const b = store.copyAttachment("s_1", src, "notes.txt");
    expect(a.path).not.toBe(b.path);
    expect(fs.existsSync(a.path)).toBe(true);
    expect(fs.existsSync(b.path)).toBe(true);
  });

  it("isolates attachments per conversation", () => {
    const src = writeSourceFile("shared.txt", "x");
    store.copyAttachment("s_1", src, "shared.txt");
    store.copyAttachment("s_2", src, "shared.txt");
    expect(store.listAttachments("s_1")).toHaveLength(1);
    expect(store.listAttachments("s_2")).toHaveLength(1);
    expect(store.listAttachments("s_3")).toHaveLength(0);
  });

  it("rejects a session id or filename that would escape the session directory", () => {
    const src = writeSourceFile("evil.txt", "x");
    expect(() => store.copyAttachment("../../etc", src, "evil.txt")).not.toThrow();
    // Path traversal in the session id is sanitized away, not honored.
    const attachment = store.copyAttachment("../../etc", src, "evil.txt");
    expect(attachment.path.startsWith(path.join(root, ".blacksite", "reference"))).toBe(true);

    expect(() => store.writeAttachmentBytes("s_1", "../../outside.txt", Buffer.from("x"))).not.toThrow();
    const escaped = store.writeAttachmentBytes("s_1", "../../outside.txt", Buffer.from("x"));
    expect(escaped.path.startsWith(store.sessionDir("s_1"))).toBe(true);
  });

  it("writes raw bytes for pasted/dropped content", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const attachment = store.writeAttachmentBytes("s_1", "pasted.png", bytes);
    expect(fs.readFileSync(attachment.path)).toEqual(bytes);
  });

  it("reads and appends the per-conversation Extracted context.md scratchpad", () => {
    expect(store.readContextMd("s_1")).toBe("");
    store.appendContextMd("s_1", "The report covers Q1 revenue.");
    const content = store.readContextMd("s_1");
    expect(content).toContain("The report covers Q1 revenue.");
    expect(path.basename(store.contextMdPath("s_1"))).toBe("Extracted context.md");

    store.appendContextMd("s_1", "Second finding.");
    expect(store.readContextMd("s_1")).toContain("Second finding.");
    expect(store.readContextMd("s_1")).toContain("The report covers Q1 revenue.");
  });

  it("does not list the Extracted context.md scratchpad as an attachment", () => {
    store.appendContextMd("s_1", "note");
    const src = writeSourceFile("data.csv", "a,b");
    store.copyAttachment("s_1", src, "data.csv");
    const names = store.listAttachments("s_1").map((a) => a.name);
    expect(names).toEqual(["data.csv"]);
  });
});
