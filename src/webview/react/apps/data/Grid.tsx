/* eslint-disable @typescript-eslint/no-explicit-any */

interface GridProps {
  columns: string[];
  rows: any[];
  sortCol?: string;
  sortDir?: "asc" | "desc";
  onSort?: (col: string) => void;
  onRowClick?: (row: any) => void;
}

/** Compact, scrollable result table shared by Explorer preview and Query results. */
export function Grid({ columns, rows, sortCol, sortDir, onSort, onRowClick }: GridProps) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-dashed border-border bg-white/[0.02] p-4 text-sm text-muted-foreground">No rows.</div>;
  }
  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse font-mono text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                onClick={onSort ? () => onSort(c) : undefined}
                className="sticky top-0 max-w-[340px] cursor-pointer truncate border-b border-border bg-background px-2 py-1 text-left font-semibold text-muted-foreground"
                title={c}
              >
                {c}{sortCol === c ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="hover:bg-white/[0.04]">
              {columns.map((c) => {
                const v = row[c];
                const str = v == null ? "" : String(v);
                const long = str.length > 60;
                return (
                  <td
                    key={c}
                    onClick={long && onRowClick ? () => onRowClick(row) : undefined}
                    title={str.slice(0, 400)}
                    className={`max-w-[340px] truncate border-b border-border px-2 py-1 ${long && onRowClick ? "cursor-pointer text-primary" : "text-foreground"}`}
                  >
                    {str.slice(0, 80)}{str.length > 80 ? "…" : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
