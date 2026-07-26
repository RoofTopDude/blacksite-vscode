export interface CsvTable {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * RFC 4180-aware record tokenizer: handles quoted fields, embedded delimiters/newlines
 * inside quotes, and doubled-quote escaping ("" -> "). Hand-rolled to match this
 * package's dependency-light style (see text-extract.ts's PDF/OOXML parsing).
 */
function parseDelimitedRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); records.push(row); row = []; };

  while (i < len) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === "\"") { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow(); i += 1; continue;
    }
    if (ch === "\n") { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  return records;
}

/** Parse delimited text (CSV/TSV) into column-named JSON rows, treating row 0 as headers. */
export function parseCsv(text: string, options?: { delimiter?: string }): CsvTable {
  const delimiter = options?.delimiter ?? ",";
  const records = parseDelimitedRecords(text, delimiter).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return { columns: [], rows: [] };

  const [headerRecord, ...dataRecords] = records;
  const columns = headerRecord!.map((h, i) => h.trim() || `column_${i + 1}`);
  const rows = dataRecords
    .filter((record) => record.some((cell) => cell.trim().length > 0))
    .map((record) => {
      const row: Record<string, string> = {};
      columns.forEach((col, i) => { row[col] = record[i] ?? ""; });
      return row;
    });

  return { columns, rows };
}

/** Picks tab for .tsv/.tab files, comma otherwise. */
export function delimiterForFileName(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return ext === "tsv" || ext === "tab" ? "\t" : ",";
}
