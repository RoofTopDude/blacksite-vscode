import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlanDocStore } from "../../src/plan-doc-store.js";

let root: string;
let store: PlanDocStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-plandoc-"));
  store = new PlanDocStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("markdown docs", () => {
  it("writes and reads a doc's body back", () => {
    store.writeMarkdown("plan-1", "doc-1", "# Findings\n\nIt works.");
    expect(store.readMarkdown("plan-1", "doc-1")).toBe("# Findings\n\nIt works.");
  });

  it("returns empty string for a doc that was never written", () => {
    expect(store.readMarkdown("plan-1", "missing")).toBe("");
  });

  it("overwrites in place on a second write", () => {
    store.writeMarkdown("plan-1", "doc-1", "first");
    store.writeMarkdown("plan-1", "doc-1", "second");
    expect(store.readMarkdown("plan-1", "doc-1")).toBe("second");
  });

  it("caps body length at MAX_DOC_BODY and reports the stored (capped) byte size", () => {
    const huge = "x".repeat(60_000);
    const byteSize = store.writeMarkdown("plan-1", "doc-1", huge);
    const stored = store.readMarkdown("plan-1", "doc-1");
    expect(stored.length).toBe(50_000);
    expect(byteSize).toBe(50_000);
  });

  it("deleteMarkdown removes the file and is a no-op if already gone", () => {
    store.writeMarkdown("plan-1", "doc-1", "content");
    store.deleteMarkdown("plan-1", "doc-1");
    expect(store.readMarkdown("plan-1", "doc-1")).toBe("");
    expect(() => store.deleteMarkdown("plan-1", "doc-1")).not.toThrow();
  });

  it("keeps docs from different plans in separate directories", () => {
    store.writeMarkdown("plan-1", "doc-1", "plan one's doc");
    store.writeMarkdown("plan-2", "doc-1", "plan two's doc");
    expect(store.readMarkdown("plan-1", "doc-1")).toBe("plan one's doc");
    expect(store.readMarkdown("plan-2", "doc-1")).toBe("plan two's doc");
  });
});

describe("file attachments", () => {
  function makeSourceFile(name: string, content: string): string {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "bls-plandoc-src-"));
    const p = path.join(srcDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("copies a file in and resolves its path back out", () => {
    const src = makeSourceFile("spec.pdf", "pretend pdf bytes");
    const { attachmentFilename, byteSize } = store.attachFile("plan-1", "doc-1", src);
    expect(attachmentFilename).toContain("spec.pdf");
    expect(byteSize).toBe(Buffer.byteLength("pretend pdf bytes"));

    const resolved = store.attachmentAbsPath("plan-1", attachmentFilename);
    expect(resolved).toBeDefined();
    expect(fs.readFileSync(resolved!, "utf8")).toBe("pretend pdf bytes");
  });

  it("sanitizes a hostile filename instead of escaping the files directory", () => {
    const src = makeSourceFile("evil.txt", "danger");
    const { attachmentFilename } = store.attachFile("plan-1", "doc-1", src, "../../escape.txt");
    const resolved = store.attachmentAbsPath("plan-1", attachmentFilename);
    expect(resolved).toBeDefined();
    // Must have stayed inside this plan's files directory.
    expect(path.dirname(resolved!)).toBe(path.join(root, ".blacksite", "plans", "plan-1", "files"));
  });

  it("attachmentAbsPath refuses a path-traversal filename even if guessed", () => {
    store.attachFile("plan-1", "doc-1", makeSourceFile("a.txt", "a"));
    expect(store.attachmentAbsPath("plan-1", "../../../etc/passwd")).toBeUndefined();
  });

  it("attachmentAbsPath returns undefined for a file that was never attached", () => {
    expect(store.attachmentAbsPath("plan-1", "nothing-here.txt")).toBeUndefined();
  });

  it("deleteAttachment removes the copied file", () => {
    const { attachmentFilename } = store.attachFile("plan-1", "doc-1", makeSourceFile("f.txt", "f"));
    store.deleteAttachment("plan-1", attachmentFilename);
    expect(store.attachmentAbsPath("plan-1", attachmentFilename)).toBeUndefined();
  });
});

describe("deletePlanDir", () => {
  it("removes every doc and attachment under a plan", () => {
    store.writeMarkdown("plan-1", "doc-1", "body");
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "bls-plandoc-src-"));
    const src = path.join(srcDir, "f.txt");
    fs.writeFileSync(src, "f");
    store.attachFile("plan-1", "doc-2", src);

    store.deletePlanDir("plan-1");

    expect(fs.existsSync(path.join(root, ".blacksite", "plans", "plan-1"))).toBe(false);
    expect(store.readMarkdown("plan-1", "doc-1")).toBe("");
  });

  it("is a no-op (does not throw) for a plan with no doc directory", () => {
    expect(() => store.deletePlanDir("never-existed")).not.toThrow();
  });
});
