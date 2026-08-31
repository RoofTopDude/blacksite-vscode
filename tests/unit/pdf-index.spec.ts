import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../src/data/database-manager.js";
import { getPdfIndexState, indexPdfDocument } from "../../src/pdf-index.js";
import { minimalPdfBytes } from "./helpers/minimal-pdf.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PDF page index", () => {
  it("persists page text and completed job progress in schema v3", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-pdf-index-"));
    roots.push(root);
    const filePath = path.join(root, "manual.pdf");
    fs.writeFileSync(filePath, minimalPdfBytes(["Alpha", "Beta", "Gamma"]));
    const db = new DatabaseManager(":memory:");
    db.open();
    db.driver.run("INSERT INTO core_sources (id, kind, uri, title) VALUES ('src', 'file', ?, 'manual.pdf')", [filePath]);
    db.driver.run("INSERT INTO core_documents (id, source_id, title, mime) VALUES ('doc', 'src', 'manual.pdf', 'application/pdf')");

    const result = await indexPdfDocument(db, { documentId: "doc", title: "manual.pdf", filePath });
    expect(result).toMatchObject({ ok: true, totalPages: 3, indexedPages: 3, textPages: 3 });
    expect(getPdfIndexState(db, "doc")).toMatchObject({ status: "done", totalPages: 3, indexedPages: 3 });
    const pages = db.all<{ page_number: number; text: string }>(
      "SELECT page_number, text FROM core_document_pages WHERE document_id = 'doc' ORDER BY page_number",
    );
    expect(pages.map((page) => page.page_number)).toEqual([1, 2, 3]);
    expect(pages[1]!.text).toContain("Beta");
    expect(db.get<{ status: string }>("SELECT status FROM core_jobs WHERE kind = 'pdf_index'")?.status).toBe("done");
    db.close();
  });
});
