import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFile, searchFiles, glob } from "../../../../packages/local-runtime/src/file-ops.js";

/**
 * Coverage for the file toolset's parity features: windowed reads (offset/limit) over
 * arbitrarily large files, image reads, binary refusal, and file_search's context lines /
 * output modes / glob include / multiline. The windowing in particular is what removed the
 * old hard "File too large (>256KB)" failure — a file over that size used to be completely
 * unreadable, which pushed the agent into the re-read + paging loops seen in the execution logs.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-fileops-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

type ReadOk = Extract<ReturnType<typeof readFile>, { ok: true; content: string }>;
type ReadImage = Extract<ReturnType<typeof readFile>, { ok: true; mediaDataUrl: string }>;
type SearchOk = Extract<ReturnType<typeof searchFiles>, { ok: true }>;

describe("readFile — windowed reads", () => {
  it("returns the whole file with accurate metadata when it fits in the window", () => {
    write("a.txt", "one\ntwo\nthree");
    const res = readFile(root, "a.txt") as ReadOk;
    expect(res.ok).toBe(true);
    expect(res.content).toBe("one\ntwo\nthree");
    expect(res.lines).toBe(3);
    expect(res.startLine).toBe(1);
    expect(res.endLine).toBe(3);
    expect(res.hasMore).toBe(false);
    expect(res.notice).toBeUndefined();
  });

  it("honours offset and limit, reporting the true total line count (not the window's)", () => {
    write("a.txt", Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
    const res = readFile(root, "a.txt", { offset: 10, limit: 5 }) as ReadOk;
    expect(res.content).toBe("line 10\nline 11\nline 12\nline 13\nline 14");
    expect(res.startLine).toBe(10);
    expect(res.endLine).toBe(14);
    expect(res.lines).toBe(100); // total, not the 5 returned
    expect(res.hasMore).toBe(true);
    expect(res.notice).toContain("offset: 15");
  });

  it("reads a file far larger than the old 256KB hard limit, a window at a time", () => {
    // ~1.2 MB — the old readFile rejected this outright with "File too large".
    const lineCount = 40_000;
    write("big.txt", Array.from({ length: lineCount }, (_, i) => `row ${i + 1} ${"x".repeat(20)}`).join("\n"));

    const head = readFile(root, "big.txt", { limit: 3 }) as ReadOk;
    expect(head.ok).toBe(true);
    expect(head.lines).toBe(lineCount);
    expect(head.content.split("\n")[0]).toContain("row 1 ");
    expect(head.hasMore).toBe(true);

    // Jump straight to the tail — no paging from the top required.
    const tail = readFile(root, "big.txt", { offset: lineCount - 1, limit: 5 }) as ReadOk;
    expect(tail.content.split("\n")[0]).toContain(`row ${lineCount - 1} `);
    expect(tail.endLine).toBe(lineCount);
    expect(tail.hasMore).toBe(false);
  });

  it("caps limit at 5000 lines so one read can't blow the result budget", () => {
    write("big.txt", Array.from({ length: 6000 }, (_, i) => `l${i}`).join("\n"));
    const res = readFile(root, "big.txt", { limit: 99_999 }) as ReadOk;
    expect(res.content.split("\n")).toHaveLength(5000);
    expect(res.hasMore).toBe(true);
  });

  it("adds line numbers only when asked (they would corrupt a copied file_edit oldString)", () => {
    write("a.txt", "alpha\nbeta");
    expect((readFile(root, "a.txt") as ReadOk).content).toBe("alpha\nbeta");
    const numbered = readFile(root, "a.txt", { lineNumbers: true }) as ReadOk;
    expect(numbered.content).toBe("     1\talpha\n     2\tbeta");
  });

  it("numbers lines with their absolute position when reading from an offset", () => {
    write("a.txt", "a\nb\nc\nd");
    const res = readFile(root, "a.txt", { offset: 3, lineNumbers: true }) as ReadOk;
    expect(res.content).toBe("     3\tc\n     4\td");
  });

  it("reports an offset past EOF instead of silently returning nothing", () => {
    write("a.txt", "only\ntwo");
    const res = readFile(root, "a.txt", { offset: 50 }) as ReadOk;
    expect(res.content).toBe("");
    expect(res.notice).toContain("past the end");
    expect(res.lines).toBe(2);
  });

  it("handles an empty file and CRLF line endings", () => {
    write("empty.txt", "");
    const empty = readFile(root, "empty.txt") as ReadOk;
    expect(empty.lines).toBe(0);
    expect(empty.content).toBe("");

    write("crlf.txt", "one\r\ntwo\r\n");
    const crlf = readFile(root, "crlf.txt") as ReadOk;
    expect(crlf.content).toBe("one\ntwo");
    expect(crlf.lines).toBe(2);
  });

  it("returns an image as a data URL so the model sees a real picture, not mojibake", () => {
    // 1x1 transparent PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(root, "pixel.png"), png);
    const res = readFile(root, "pixel.png") as ReadImage;
    expect(res.ok).toBe(true);
    expect(res.mediaType).toBe("image/png");
    expect(res.mediaDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("refuses a binary file with a clear reason rather than returning garbage text", () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    const res = readFile(root, "blob.bin");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/binary/i);
  });

  it("points at file_list when handed a directory", () => {
    fs.mkdirSync(path.join(root, "sub"));
    const res = readFile(root, "sub");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/file_list/);
  });
});

describe("searchFiles — output modes, context, include globs, multiline", () => {
  beforeEach(() => {
    write("src/a.ts", "import x\nconst target = 1\nconst other = 2\ntarget again\n");
    write("src/b.ts", "nothing here\n");
    write("src/c.js", "const target = 3\n");
  });

  it("content mode (default) returns matching lines with file + line number", () => {
    const res = searchFiles(root, ".", "target") as SearchOk;
    expect(res.outputMode).toBe("content");
    expect(res.totalMatches).toBe(3);
    expect(res.results.map((r) => `${r.file}:${r.line}`).sort()).toEqual(["src/a.ts:2", "src/a.ts:4", "src/c.js:1"]);
  });

  it("attaches surrounding context lines when asked", () => {
    const res = searchFiles(root, ".", "const target = 1", { contextLines: 1 }) as SearchOk;
    const hit = res.results[0]!;
    expect(hit.before).toEqual(["import x"]);
    expect(hit.after).toEqual(["const other = 2"]);
  });

  it("files_with_matches returns just the paths (cheap 'where does this live')", () => {
    const res = searchFiles(root, ".", "target", { outputMode: "files_with_matches" }) as SearchOk;
    expect(res.files?.sort()).toEqual(["src/a.ts", "src/c.js"]);
    expect(res.results).toEqual([]);
  });

  it("count returns per-file tallies (cheap blast-radius sizing)", () => {
    const res = searchFiles(root, ".", "target", { outputMode: "count" }) as SearchOk;
    expect(res.counts?.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "src/a.ts", count: 2 },
      { file: "src/c.js", count: 1 },
    ]);
    expect(res.totalMatches).toBe(3);
  });

  it("include accepts a glob — '*.ts' used to be impossible as a substring filter", () => {
    const res = searchFiles(root, ".", "target", { include: "*.ts" }) as SearchOk;
    expect(res.results.every((r) => r.file.endsWith(".ts"))).toBe(true);
    expect(res.results.some((r) => r.file.endsWith(".js"))).toBe(false);
  });

  it("include still accepts a plain substring (backward compatible)", () => {
    const res = searchFiles(root, ".", "target", { include: "c.js" }) as SearchOk;
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.file).toBe("src/c.js");
  });

  it("multiline lets a pattern span lines", () => {
    const single = searchFiles(root, ".", "const target = 1.*const other") as SearchOk;
    expect(single.totalMatches).toBe(0); // line-by-line: can't span
    const multi = searchFiles(root, ".", "const target = 1.*const other", { multiline: true }) as SearchOk;
    expect(multi.totalMatches).toBe(1);
    expect(multi.results[0]!.line).toBe(2); // reports the starting line
  });

  it("searches a single file when handed a file path", () => {
    const res = searchFiles(root, "src/a.ts", "target") as SearchOk;
    expect(res.totalMatches).toBe(2);
  });

  it("a global regex's lastIndex never causes a false negative on the next file", () => {
    // Regression guard: the `g` flag makes .test() stateful. Every file must match independently.
    const res = searchFiles(root, ".", "const", { outputMode: "files_with_matches" }) as SearchOk;
    expect(res.files?.sort()).toEqual(["src/a.ts", "src/c.js"]);
  });
});

describe("glob — most-recently-modified first", () => {
  it("sorts results by mtime so the files a task is about surface at the top", () => {
    write("old.ts", "x");
    write("mid.ts", "x");
    write("new.ts", "x");
    fs.utimesSync(path.join(root, "old.ts"), new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(path.join(root, "mid.ts"), new Date(2_000_000), new Date(2_000_000));
    fs.utimesSync(path.join(root, "new.ts"), new Date(3_000_000), new Date(3_000_000));

    const res = glob(root, ".", "*.ts");
    expect(res.ok).toBe(true);
    expect((res as { results: string[] }).results).toEqual(["new.ts", "mid.ts", "old.ts"]);
  });
});
