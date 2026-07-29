/* A raw NUL byte in a source file is invisible in an editor and changes how the whole
   toolchain treats the file: ripgrep reports "binary file matches" and refuses to print
   the hits, and git — which sniffs the first 8000 bytes — can classify the file binary,
   which silently exempts it from the repo's own `* text=auto eol=lf` normalization. Both
   happened here: src/ticket-store.ts could not be searched, and src/graph/layout.ts sat
   committed with mixed CRLF/LF endings for that reason. The separators themselves are
   deliberate (a NUL cannot occur inside a path or label, so it makes an unambiguous
   composite key) — they just have to be written as the `\u0000` escape. */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_DIRS = ["src", "scripts", "tests"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".css", ".html", ".json", ".md"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "out" || entry.name === "dist") continue;
      out.push(...sourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir))),
  // Root-level docs count too — the same slip lands just as easily in CHANGELOG.md.
  ...fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.join(ROOT, entry.name)),
];

describe("source hygiene", () => {
  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no raw NUL bytes — composite-key separators must use the \\u0000 escape", () => {
    const offenders = files
      .filter((file) => fs.readFileSync(file).includes(0))
      .map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});
