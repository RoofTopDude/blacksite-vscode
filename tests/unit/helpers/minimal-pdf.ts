/** Build a small, dependency-free PDF fixture with one text stream per page. */
export function minimalPdfBytes(pageTexts: string[]): Uint8Array {
  const texts = pageTexts.length > 0 ? pageTexts : [""];
  const pageCount = texts.length;
  const firstPageId = 3;
  const firstContentId = firstPageId + pageCount;
  const fontId = firstContentId + pageCount;
  const kids = texts.map((_text, index) => `${firstPageId + index} 0 R`).join(" ");
  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`,
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj`,
  ];
  for (let index = 0; index < pageCount; index += 1) {
    objects.push(
      `${firstPageId + index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${firstContentId + index} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj`,
    );
  }
  for (let index = 0; index < pageCount; index += 1) {
    const safeText = texts[index]!.replace(/([\\()])/g, "\\$1");
    const stream = `BT /F1 18 Tf 40 700 Td (${safeText}) Tj ET`;
    objects.push(`${firstContentId + index} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`);
  }
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);
  const pdf = `%PDF-1.4\n${objects.join("\n")}\ntrailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
