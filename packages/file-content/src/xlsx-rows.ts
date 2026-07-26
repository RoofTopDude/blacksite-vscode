import { unzipSync } from "fflate";
import { decodeUtf8, parseSharedStrings, parseXlsxSheetCells } from "./text-extract.js";

export interface XlsxSheetRows {
  name: string;
  columns: string[];
  rows: Record<string, string>[];
}

function extractAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}=["']([^"']*)["']`, "i");
  return tag.match(re)?.[1] ?? null;
}

/** `<sheet name="Data" sheetId="2" r:id="rId2"/>` entries from xl/workbook.xml, in workbook order. */
function parseWorkbookSheetRefs(workbookXml: string): Array<{ name: string; rId: string }> {
  const sheets: Array<{ name: string; rId: string }> = [];
  const sheetTagRe = /<sheet\b[^>]*\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetTagRe.exec(workbookXml)) !== null) {
    const tag = m[0];
    const name = extractAttr(tag, "name");
    const rId = extractAttr(tag, "r:id");
    if (name && rId) sheets.push({ name, rId });
  }
  return sheets;
}

/** `<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>` entries from xl/_rels/workbook.xml.rels. */
function parseRelationshipTargets(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relTagRe = /<Relationship\b[^>]*\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = relTagRe.exec(relsXml)) !== null) {
    const tag = m[0];
    const id = extractAttr(tag, "Id");
    const target = extractAttr(tag, "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

/** Resolve real display sheet names to their worksheet XML paths, in workbook order. */
export function resolveXlsxSheetRefs(entries: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const workbookEntry = entries["xl/workbook.xml"];
  if (!workbookEntry) return [];
  const workbookXml = decodeUtf8(workbookEntry);
  const relsEntry = entries["xl/_rels/workbook.xml.rels"];
  const relsXml = relsEntry ? decodeUtf8(relsEntry) : "";

  const sheetRefs = parseWorkbookSheetRefs(workbookXml);
  const relTargets = parseRelationshipTargets(relsXml);

  const result: Array<{ name: string; path: string }> = [];
  for (const ref of sheetRefs) {
    const target = relTargets.get(ref.rId);
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    if (entries[path]) result.push({ name: ref.name, path });
  }
  return result;
}

/** Convert a worksheet's cell grid into JSON rows, treating the first row as headers. */
export function cellsToJsonRows(cells: string[][]): { columns: string[]; rows: Record<string, string>[] } {
  const [headerRow, ...dataRows] = cells;
  if (!headerRow || headerRow.length === 0) return { columns: [], rows: [] };

  const columns = headerRow.map((h, i) => h.trim() || `column_${i + 1}`);
  const rows = dataRows
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => {
      const record: Record<string, string> = {};
      columns.forEach((col, i) => { record[col] = row[i] ?? ""; });
      return record;
    });
  return { columns, rows };
}

/**
 * Parse every worksheet in an XLSX/ODS archive into named, JSON-row-shaped tables,
 * so the reference_query_spreadsheet tool can address "which sheet" by real name and
 * run jq filters against structured rows instead of flattened text.
 */
export function extractXlsxJsonRows(bytes: Uint8Array): XlsxSheetRows[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return [];
  }

  const sharedEntry = entries["xl/sharedStrings.xml"];
  const sharedStrings = sharedEntry ? parseSharedStrings(decodeUtf8(sharedEntry)) : [];

  const sheetRefs = resolveXlsxSheetRefs(entries);
  return sheetRefs.map((ref, index) => {
    const xml = decodeUtf8(entries[ref.path]!);
    const cells = parseXlsxSheetCells(xml, sharedStrings);
    const { columns, rows } = cellsToJsonRows(cells);
    return { name: ref.name || `Sheet${index + 1}`, columns, rows };
  });
}
