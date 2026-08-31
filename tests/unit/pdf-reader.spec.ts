import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPdfFile, readPdfFile, visitPdfPages } from "../../packages/file-content/src/pdf-reader.js";
import { minimalPdfBytes } from "./helpers/minimal-pdf.js";

const roots: string[] = [];

function fixture(texts: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-pdf-reader-"));
  roots.push(root);
  const filePath = path.join(root, "large.pdf");
  fs.writeFileSync(filePath, minimalPdfBytes(texts));
  return filePath;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("page-aware PDF reader", () => {
  it("inspects a document without flattening it and reads only the requested range", async () => {
    const filePath = fixture(["Page One", "Page Two", "Page Three", "Page Four"]);
    const manifest = await inspectPdfFile(filePath);
    expect(manifest.pageCount).toBe(4);

    const result = await readPdfFile(filePath, { startPage: 2, endPage: 3 });
    expect(result.pages.map((page) => page.pageNumber)).toEqual([2, 3]);
    expect(result.pages[0]!.text).toContain("Page Two");
    expect(result.pages[1]!.text).toContain("Page Three");
  });

  it("walks a long document through one callback at a time", async () => {
    const filePath = fixture(Array.from({ length: 25 }, (_, index) => `Evidence ${index + 1}`));
    const visited: number[] = [];
    const manifest = await visitPdfPages(filePath, { onPage: (page) => { visited.push(page.pageNumber); } });
    expect(manifest.pageCount).toBe(25);
    expect(visited).toHaveLength(25);
    expect(visited.at(-1)).toBe(25);
  });

  it("honours cancellation before opening a document", async () => {
    const filePath = fixture(["Never read"]);
    const controller = new AbortController();
    controller.abort();
    await expect(readPdfFile(filePath, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
