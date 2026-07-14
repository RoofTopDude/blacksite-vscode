import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFile, searchFiles, glob, writeFile, copyPath } from "../../../../packages/local-runtime/src/file-ops.js";

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

describe("readFile — encodings (BOM/UTF-16) and long-line clipping", () => {
  it("strips a UTF-8 BOM so the first line is edit-matchable, and reports it", () => {
    fs.writeFileSync(path.join(root, "bom.ts"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;\nconst b = 2;", "utf8")]));
    const res = readFile(root, "bom.ts") as ReadOk;
    expect(res.ok).toBe(true);
    expect(res.content).toBe("const a = 1;\nconst b = 2;"); // no invisible
    expect(res.bom).toBe(true);
    expect(res.encoding).toBe("utf8");
  });

  it("decodes a UTF-16 LE file (PowerShell redirect output) instead of calling it binary", () => {
    fs.writeFileSync(path.join(root, "utf16le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello\nwörld", "utf16le")]));
    const res = readFile(root, "utf16le.txt") as ReadOk;
    expect(res.ok).toBe(true);
    expect(res.content).toBe("hello\nwörld");
    expect(res.encoding).toBe("utf16le");
    expect(res.lines).toBe(2);
  });

  it("decodes a UTF-16 BE file via byte-swap", () => {
    const le = Buffer.from("big endian\nline two", "utf16le");
    const be = Buffer.from(le); be.swap16();
    fs.writeFileSync(path.join(root, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    const res = readFile(root, "utf16be.txt") as ReadOk;
    expect(res.ok).toBe(true);
    expect(res.content).toBe("big endian\nline two");
    expect(res.encoding).toBe("utf16be");
  });

  it("still refuses a binary blob whose first bytes coincide with a UTF-16 BOM", () => {
    // 0xFF 0xFE start sniffs as utf16le, but the decoded content contains U+0000 code
    // units — a real-text impossibility — so the binary guard must still fire.
    fs.writeFileSync(path.join(root, "fake-bom.bin"), Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x03]));
    const res = readFile(root, "fake-bom.bin");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/binary/i);
  });

  it("reports plain UTF-8 files without encoding noise", () => {
    write("plain.txt", "ordinary");
    const res = readFile(root, "plain.txt") as ReadOk;
    expect(res.encoding).toBeUndefined();
    expect(res.bom).toBeUndefined();
  });

  it("clips long lines at the default cap with a notice, and maxLineChars raises the cap", () => {
    write("minified.js", `const x = "${"a".repeat(5000)}";\nshort`);
    const clipped = readFile(root, "minified.js") as ReadOk;
    expect(clipped.content).toContain("… (line truncated)");
    expect(clipped.notice).toContain("maxLineChars");

    const full = readFile(root, "minified.js", { maxLineChars: 10_000 }) as ReadOk;
    expect(full.content).not.toContain("… (line truncated)");
    expect(full.content.split("\n")[0]!.length).toBeGreaterThan(5000);
    expect(full.notice).toBeUndefined();
  });
});

describe("writeFile — modes and overwrite visibility", () => {
  it("reports created:true for a new file and requires confirmation first", () => {
    const unconfirmed = writeFile(root, "new.txt", "hello", false);
    expect(unconfirmed.ok).toBe(false);
    expect((unconfirmed as { requiresConfirmation?: boolean }).requiresConfirmation).toBe(true);

    const res = writeFile(root, "new.txt", "hello", true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(true);
      expect(res.mode).toBe("overwrite");
      expect(res.replacedSizeBytes).toBeUndefined();
      expect(res.notice).toBeUndefined();
    }
  });

  it("flags an overwrite of an existing file with its previous size", () => {
    write("existing.txt", "a".repeat(400));
    const res = writeFile(root, "existing.txt", "tiny", true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(false);
      expect(res.replacedSizeBytes).toBe(400);
      expect(res.notice).toMatch(/replaced an existing file/i);
    }
  });

  it("append mode lands a large file in chunks with a running size", () => {
    const first = writeFile(root, "chunked.txt", "part1\n", true, { mode: "append" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.created).toBe(true);
    const second = writeFile(root, "chunked.txt", "part2\n", true, { mode: "append" });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.mode).toBe("append");
      expect(second.sizeBytes).toBe(12);
      expect(second.notice).toBeUndefined(); // append is not an overwrite
    }
    expect(fs.readFileSync(path.join(root, "chunked.txt"), "utf8")).toBe("part1\npart2\n");
  });
});

describe("copyPath", () => {
  it("requires confirmation before touching the filesystem, like writeFile/deletePath", () => {
    write("tpl/base.txt", "template");
    const unconfirmed = copyPath(root, "tpl/base.txt", "out.txt", false, false);
    expect(unconfirmed.ok).toBe(false);
    expect((unconfirmed as { requiresConfirmation?: boolean; tier?: string }).requiresConfirmation).toBe(true);
    expect((unconfirmed as { tier?: string }).tier).toBe("write");
    expect(fs.existsSync(path.join(root, "out.txt"))).toBe(false); // nothing happened

    // Replacing an existing destination is destructive-tier.
    write("out2.txt", "precious");
    const destructive = copyPath(root, "tpl/base.txt", "out2.txt", true, false);
    expect(destructive.ok).toBe(false);
    expect((destructive as { tier?: string }).tier).toBe("destructive");
    expect(fs.readFileSync(path.join(root, "out2.txt"), "utf8")).toBe("precious");
  });

  it("copies a file and refuses to clobber an existing destination without overwrite", () => {
    write("tpl/base.txt", "template");
    const res = copyPath(root, "tpl/base.txt", "out.txt", false, true);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe("template");

    write("out2.txt", "precious");
    const refused = copyPath(root, "tpl/base.txt", "out2.txt", false, true);
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toMatch(/overwrite:true/);
    expect(fs.readFileSync(path.join(root, "out2.txt"), "utf8")).toBe("precious");

    const forced = copyPath(root, "tpl/base.txt", "out2.txt", true, true);
    expect(forced.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "out2.txt"), "utf8")).toBe("template");
  });

  it("copies a directory recursively", () => {
    write("dir/a.txt", "1");
    write("dir/sub/b.txt", "2");
    const res = copyPath(root, "dir", "dir-copy", false, true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.kind).toBe("directory");
    expect(fs.readFileSync(path.join(root, "dir-copy/sub/b.txt"), "utf8")).toBe("2");
  });
});

describe("searchFiles — skip reporting and exclusion overrides", () => {
  it("counts over-size files instead of skipping them silently, and maxFileBytes widens the net", () => {
    write("big.log", `needle ${"x".repeat(600 * 1024)}`);
    write("small.ts", "no match here");

    const skippedRun = searchFiles(root, ".", "needle") as SearchOk;
    expect(skippedRun.totalMatches).toBe(0);
    expect(skippedRun.skipped?.largeFiles).toBe(1);

    const widened = searchFiles(root, ".", "needle", { maxFileBytes: 2 * 1024 * 1024 }) as SearchOk;
    expect(widened.totalMatches).toBe(1);
    expect(widened.skipped).toBeUndefined();
  });

  it("reports excluded-directory pruning and includeExcluded opens it up", () => {
    write("node_modules/pkg/index.js", "const secret = 1");
    write("src/app.ts", "const other = 2");

    const pruned = searchFiles(root, ".", "secret") as SearchOk;
    expect(pruned.totalMatches).toBe(0);
    expect(pruned.skipped?.excludedDirs).toBeGreaterThanOrEqual(1);

    const open = searchFiles(root, ".", "secret", { includeExcluded: true }) as SearchOk;
    expect(open.totalMatches).toBe(1);
  });

  it("extraExcludes prunes additional generated trees", () => {
    write("target/gen.rs", "let needle = 1;");
    const res = searchFiles(root, ".", "needle", { extraExcludes: ["target"] }) as SearchOk;
    expect(res.totalMatches).toBe(0);
    expect(res.skipped?.excludedDirs).toBe(1);
  });

  it("reports depth-limited subtrees", () => {
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join("/");
    write(`${deep}/deep.ts`, "const needle = 1;");
    const res = searchFiles(root, ".", "needle") as SearchOk;
    expect(res.totalMatches).toBe(0);
    expect(res.skipped?.depthLimited).toBeGreaterThanOrEqual(1);
  });
});

describe("glob — skip reporting and exclusion overrides", () => {
  it("reports excluded-directory pruning and includeExcluded opens it up", () => {
    write("node_modules/pkg/index.js", "x");
    write("src/app.ts", "x");

    const pruned = glob(root, ".", "**/*.js");
    expect(pruned.ok).toBe(true);
    if (pruned.ok) {
      expect(pruned.results).toEqual([]);
      expect(pruned.skipped?.excludedDirs).toBeGreaterThanOrEqual(1);
    }

    const open = glob(root, ".", "**/*.js", 200, { includeExcluded: true });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.results).toContain("node_modules/pkg/index.js");
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
