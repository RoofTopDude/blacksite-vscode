import { describe, expect, it } from "vitest";
import { extractTextFromPdf } from "../../packages/file-content/src/text-extract.js";

// De-risks pdfjs-dist running inside the bare-Node (no DOM/Worker) extension host —
// see Phase B of the file-attachment plan. This is the first time @blacksite/file-content
// runs outside the Chrome extension's DOM/Worker-having context. Whether pdfjs-dist's
// worker path resolves or not, extractTextFromPdf must still produce correct text (via
// its own regex-based fallback if needed) — that graceful degradation is what this
// asserts, not which internal path was taken.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 20 100 Td (Hello World) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF
`;

function pdfBuffer(): ArrayBuffer {
  const bytes = new TextEncoder().encode(MINIMAL_PDF);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("extractTextFromPdf in the bare-Node extension host", () => {
  it("extracts real text from a minimal PDF without a DOM/Worker environment", async () => {
    const text = await extractTextFromPdf(pdfBuffer());
    expect(text).toContain("Hello World");
  }, 20_000);
});
