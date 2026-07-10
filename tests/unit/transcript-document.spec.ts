import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceStore } from "../../src/reference-store.js";
import { TRANSCRIPT_DOCUMENT_SCHEMA, TranscriptDocumentService } from "../../src/transcript-document.js";

const dirs: string[] = [];

function service(): { root: string; service: TranscriptDocumentService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-transcript-doc-"));
  dirs.push(root);
  return { root, service: new TranscriptDocumentService(new ReferenceStore(root)) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptDocumentService", () => {
  it("stores full Markdown as a conversation attachment while returning a bounded preview", () => {
    const { root, service: docs } = service();
    const body = `# Architecture\n\n${"Detailed design. ".repeat(800)}`;
    const result = docs.create({ title: "Architecture Report", docType: "architecture", markdown: body }, "s_conversation");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.schema).toBe(TRANSCRIPT_DOCUMENT_SCHEMA);
    expect(result.document.documentId).toBe(result.document.filename);
    expect(result.document.previewMarkdown.length).toBeLessThan(result.document.sizeChars);
    expect(fs.readFileSync(path.join(root, ".blacksite", "reference", "s_conversation", result.document.filename), "utf8")).toBe(body.trim());
    expect(docs.read(result.document.documentId, "s_conversation")).toEqual({ ok: true, markdown: body.trim() });
  });

  it("keeps documents scoped to the conversation that created them", () => {
    const { service: docs } = service();
    const created = docs.create({ title: "Runbook", sections: [{ heading: "Recovery", content: "Restart the worker." }] }, "s_one");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(docs.read(created.document.documentId, "s_two")).toEqual({
      ok: false,
      error: "Transcript document not found in this conversation.",
    });
  });
});
