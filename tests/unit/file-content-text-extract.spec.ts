import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractReadableTextFromBytes, parseXlsxSheetCells } from "../../packages/file-content/src/text-extract.js";

// Real worksheets omit unstyled blank cells entirely and self-close styled-but-empty
// ones (`<c r="B2" s="4"/>`). parseXlsxSheetCells is the shared source of truth for both
// the flattened-text extractor and xlsx-rows.ts's JSON-rows extractor, which maps
// columns[i] -> row[i] positionally — so a dropped cell silently shifts every later
// value into the wrong column.
describe("parseXlsxSheetCells", () => {
  it("keeps cells aligned to their column ref when cells are skipped or self-closed", () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="C1" t="inlineStr"><is><t>Score</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Ann</t></is></c><c r="B2" s="4"/><c r="C2"><v>10</v></c></row>
    </sheetData>`;

    const rows = parseXlsxSheetCells(xml, []);

    expect(rows[0]).toEqual(["Name", "", "Score"]);
    expect(rows[1]).toEqual(["Ann", "", "10"]);
  });

  it("ignores a corrupt/hostile column ref instead of hanging on an astronomical fill loop", () => {
    // A 10-letter column ref is ~26^10 columns — well past Excel's real ceiling (XFD, 16384
    // columns). Falling back to document-order placement keeps this bounded and fast.
    const xml = `<sheetData><row r="1"><c r="ZZZZZZZZZZ1" t="inlineStr"><is><t>X</t></is></c></row></sheetData>`;
    const start = Date.now();
    const rows = parseXlsxSheetCells(xml, []);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(rows[0]).toEqual(["X"]);
  });
});

describe("extractReadableTextFromBytes", () => {
  it("orders OOXML parts numerically, not lexically (slide2 before slide10)", async () => {
    const bytes = zipSync({
      "ppt/slides/slide1.xml": strToU8("<p:sld><a:t>MARKER_ONE</a:t></p:sld>"),
      "ppt/slides/slide2.xml": strToU8("<p:sld><a:t>MARKER_TWO</a:t></p:sld>"),
      "ppt/slides/slide10.xml": strToU8("<p:sld><a:t>MARKER_TEN</a:t></p:sld>"),
    });

    const text = await extractReadableTextFromBytes({
      fileName: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes,
    });

    expect(text).not.toBeNull();
    const one = text!.indexOf("MARKER_ONE");
    const two = text!.indexOf("MARKER_TWO");
    const ten = text!.indexOf("MARKER_TEN");
    expect(one).toBeGreaterThanOrEqual(0);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(ten);
  });

  it("decodes XML entities in one pass without double-unescaping or mangling astral code points", async () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        "<w:document><w:body><w:p><w:r><w:t>"
        + "A:&amp;amp; B:&amp;#65; C:&#9731; D:&#128512;"
        + "</w:t></w:r></w:p></w:body></w:document>",
      ),
    });

    const text = await extractReadableTextFromBytes({
      fileName: "doc.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes,
    });

    expect(text).not.toBeNull();
    // Doubly-escaped entities must decode exactly one level, not recurse.
    expect(text).toContain("A:&amp;");
    expect(text).toContain("B:&#65;");
    expect(text).not.toContain("B:A");
    // Plain numeric refs still decode, including outside the BMP.
    expect(text).toContain("C:\u2603");
    expect(text).toContain("D:\u{1F600}");
  });

  it("leaves a lone-surrogate numeric entity undecoded rather than emitting a corrupt code unit", async () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        "<w:document><w:body><w:p><w:r><w:t>Before&#xD800;After</w:t></w:r></w:p></w:body></w:document>",
      ),
    });

    const text = await extractReadableTextFromBytes({
      fileName: "doc.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes,
    });

    expect(text).not.toBeNull();
    // The entity must not decode to a lone surrogate — String.fromCodePoint(0xD800) would
    // silently mangle to U+FFFD on the next UTF-8 re-encode.
    expect(text).not.toMatch(/Before[\uD800-\uDFFF]After/);
    expect(text).toContain("Before&#xD800;After");
  });
});
