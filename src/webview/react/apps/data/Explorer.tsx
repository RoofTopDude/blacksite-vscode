/* eslint-disable @typescript-eslint/no-explicit-any */
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { actions, useDataStore } from "./store";
import { Grid } from "./Grid";

export function Explorer() {
  const s = useDataStore();
  const cat = s.catalog;
  const desc = s.description;
  const preview = s.preview;

  return (
    <div className="grid flex-1 grid-cols-[180px_1fr] overflow-hidden">
      <div className="overflow-y-auto border-r border-border p-2">
        {!cat ? (
          <div className="p-2 text-[11px] text-muted-foreground">No catalog.</div>
        ) : cat.groups.map((group: any) => (
          <div key={group.id}>
            <div className="mx-1.5 mb-1 mt-2.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">{group.label} ({group.objects.length})</div>
            {group.objects.map((obj: any) => {
              const active = s.selectedObject === obj.name && (group.type === "table" || group.type === "view");
              const clickable = group.type === "table" || group.type === "view" || group.type === "saved_query";
              return (
                <div
                  key={obj.name}
                  onClick={clickable ? () => (group.type === "saved_query" ? actions.openSaved(obj.detail) : actions.selectObject(obj.name)) : undefined}
                  className={`flex items-center justify-between gap-1.5 rounded-md px-1.5 py-1 ${clickable ? "cursor-pointer hover:bg-white/[0.05]" : ""} ${active ? "bg-primary/15" : ""}`}
                >
                  <span className="truncate text-[11.5px] text-foreground">{obj.name}</span>
                  {obj.rowCount != null ? <span className="font-mono text-[9.5px] text-muted-foreground">{obj.rowCount}</span> : obj.detail ? <span className="truncate font-mono text-[9px] text-muted-foreground">{obj.detail}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="overflow-y-auto p-3">
        {!s.selectedObject ? (
          <div className="rounded-lg border border-dashed border-border bg-white/[0.02] p-4 text-[11px] text-muted-foreground">Select a table or view to preview its rows.</div>
        ) : (
          <>
            {desc && (
              <div className="mb-2">
                <div className="text-[13px] font-semibold text-foreground">{desc.name} <span className="font-normal text-muted-foreground">{desc.type}</span></div>
                <div className="text-[10.5px] text-muted-foreground">{desc.rowCount} rows · {desc.columns.length} columns · {desc.indexes.length} index(es)</div>
                <div className="my-2 flex flex-wrap gap-1">
                  {desc.columns.map((c: any) => (
                    <span key={c.name} title={`${c.type}${c.notNull ? " NOT NULL" : ""}`} className={`rounded-full border px-2 py-px font-mono text-[10px] ${c.primaryKey ? "border-primary/50 text-primary" : "border-border bg-white/5 text-muted-foreground"}`}>{c.name}</span>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <Input
                    defaultValue={s.previewReq.filter}
                    placeholder="Filter rows…"
                    onKeyDown={(e) => { if (e.key === "Enter") actions.setFilter((e.target as HTMLInputElement).value); }}
                    className="h-7 flex-1 text-[11px]"
                  />
                </div>
              </div>
            )}
            {preview && (
              <>
                <Grid
                  columns={preview.columns}
                  rows={preview.rows}
                  sortCol={s.previewReq.orderBy}
                  sortDir={s.previewReq.orderDir}
                  onSort={(c) => actions.sort(c)}
                  onRowClick={(row) => actions.openDrawer(row)}
                />
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Button size="xs" variant="outline" disabled={preview.offset <= 0} onClick={() => actions.page(-1)}>Prev</Button>
                  <span>{preview.offset + 1}–{preview.offset + preview.rows.length} of {preview.totalRows}</span>
                  <Button size="xs" variant="outline" disabled={preview.offset + preview.rows.length >= preview.totalRows} onClick={() => actions.page(1)}>Next</Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
