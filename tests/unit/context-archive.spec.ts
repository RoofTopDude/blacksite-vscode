import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextArchive, archiveFileName, nodeArchiveDisk, type ArchiveDisk } from "../../src/context/archive.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-archive-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ContextArchive, memory only", () => {
  it("keeps every result until the memory ceiling, then releases the oldest", () => {
    const archive = new ContextArchive({ memoryChars: 25 });
    archive.put("a", "a".repeat(10));
    archive.put("b", "b".repeat(10));
    expect(archive.get("a")).toBe("a".repeat(10));

    archive.put("c", "c".repeat(10));
    expect(archive.get("a")).toBeUndefined();
    expect(archive.has("a")).toBe(false);
    expect(archive.get("b")).toBe("b".repeat(10));
    expect(archive.get("c")).toBe("c".repeat(10));
    expect(archive.memoryChars).toBe(20);
  });

  it("never releases the entry it is storing, even when that alone is over the ceiling", () => {
    const archive = new ContextArchive({ memoryChars: 5 });
    archive.put("big", "x".repeat(50));
    expect(archive.get("big")).toBe("x".repeat(50));
  });

  it("bounds the entry count", () => {
    const archive = new ContextArchive({ maxEntries: 3 });
    for (const id of ["a", "b", "c", "d"]) archive.put(id, id);
    expect(archive.size).toBe(3);
    expect(archive.get("a")).toBeUndefined();
    expect(archive.get("d")).toBe("d");
  });

  it("replaces an entry put twice under one id", () => {
    const archive = new ContextArchive();
    archive.put("a", "first");
    archive.put("a", "second");
    expect(archive.size).toBe(1);
    expect(archive.get("a")).toBe("second");
    expect(archive.memoryChars).toBe("second".length);
  });

  it("is not persistent and reports metadata", () => {
    const archive = new ContextArchive();
    archive.put("a", "abc", "file_read");
    expect(archive.persistent).toBe(false);
    expect(archive.meta("a")).toMatchObject({ id: "a", toolName: "file_read", chars: 3 });
  });
});

describe("ContextArchive, on disk", () => {
  it("writes every entry and serves it from disk after memory releases it", async () => {
    const dir = path.join(tempDir(), "session");
    const archive = new ContextArchive({ dir, memoryChars: 15 });
    archive.put("toolu_1", "one".repeat(4));
    await archive.flush();
    archive.put("toolu_2", "two".repeat(4));
    await archive.flush();

    expect(fs.readFileSync(path.join(dir, archiveFileName("toolu_1")), "utf8")).toBe("one".repeat(4));
    expect(archive.memoryChars).toBeLessThanOrEqual(15);
    expect(archive.get("toolu_1")).toBe("one".repeat(4));
    expect(archive.persistent).toBe(true);
  });

  it("reads back what an earlier archive for the same session wrote (a window reload)", async () => {
    const dir = path.join(tempDir(), "session");
    const before = new ContextArchive({ dir });
    before.put("toolu_9", "kept across reload");
    await before.flush();

    const after = new ContextArchive({ dir });
    expect(after.has("toolu_9")).toBe(false);
    expect(after.get("toolu_9")).toBe("kept across reload");
  });

  it("evicts the oldest entries from disk past the disk ceiling", async () => {
    const dir = path.join(tempDir(), "session");
    const archive = new ContextArchive({ dir, maxDiskChars: 25 });
    for (const id of ["a", "b", "c"]) {
      archive.put(id, id.repeat(10));
      await archive.flush();
    }
    expect(archive.get("a")).toBeUndefined();
    expect(fs.existsSync(path.join(dir, archiveFileName("a")))).toBe(false);
    expect(archive.get("c")).toBe("c".repeat(10));
  });

  it("keeps a failed write in memory, and evicts it like a memory-only entry", async () => {
    const failing: ArchiveDisk = { ...nodeArchiveDisk, mkdir: () => {}, write: () => Promise.reject(new Error("disk full")) };
    const archive = new ContextArchive({ dir: path.join(tempDir(), "s"), memoryChars: 15, disk: failing });
    archive.put("a", "a".repeat(10));
    await archive.flush();
    expect(archive.get("a")).toBe("a".repeat(10));

    archive.put("b", "b".repeat(10));
    await archive.flush();
    expect(archive.get("a")).toBeUndefined();
    expect(archive.get("b")).toBe("b".repeat(10));
  });

  it("never writes an entry stored with persist: false", async () => {
    const dir = path.join(tempDir(), "session");
    const archive = new ContextArchive({ dir, memoryChars: 15 });
    archive.put("secret", "s".repeat(10), "browser_type", { persist: false });
    archive.put("plain", "p".repeat(4), "file_read");
    await archive.flush();
    expect(archive.get("secret")).toBe("s".repeat(10));
    expect(fs.existsSync(path.join(dir, archiveFileName("secret")))).toBe(false);
    expect(fs.existsSync(path.join(dir, archiveFileName("plain")))).toBe(true);

    // Memory was its only copy, so memory pressure drops it rather than leaving it on disk.
    archive.put("next", "n".repeat(10), "file_read");
    await archive.flush();
    expect(archive.get("secret")).toBeUndefined();
  });

  it("clear removes the session directory", async () => {
    const dir = path.join(tempDir(), "session");
    const archive = new ContextArchive({ dir });
    archive.put("a", "x");
    await archive.flush();
    archive.clear();
    expect(fs.existsSync(dir)).toBe(false);
    expect(archive.get("a")).toBeUndefined();
  });

  it("prunes stale sibling session directories and keeps the current one", () => {
    const root = tempDir();
    for (const name of ["old", "current", "fresh"]) fs.mkdirSync(path.join(root, name));
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(root, "old"), past, past);
    fs.utimesSync(path.join(root, "current"), past, past);

    expect(ContextArchive.pruneStale(root, "current")).toBe(1);
    expect(fs.readdirSync(root).sort()).toEqual(["current", "fresh"]);
  });

  it("keeps only the newest session directories, counting the current one", () => {
    const root = tempDir();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const dir = path.join(root, `s${i}`);
      fs.mkdirSync(dir);
      const when = new Date(now - (5 - i) * 60_000);
      fs.utimesSync(dir, when, when);
    }
    fs.mkdirSync(path.join(root, "current"));
    expect(ContextArchive.pruneStale(root, "current", undefined, undefined, now, 3)).toBe(3);
    expect(fs.readdirSync(root).sort()).toEqual(["current", "s3", "s4"]);
  });
});

describe("archiveFileName", () => {
  it("is safe on every platform and distinct for ids that sanitize alike", () => {
    expect(archiveFileName("toolu_01:ab/c")).toMatch(/^[A-Za-z0-9_-]+\.txt$/);
    expect(archiveFileName("a:b")).not.toBe(archiveFileName("a/b"));
  });
});
