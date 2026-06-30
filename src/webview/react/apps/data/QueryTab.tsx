/* eslint-disable @typescript-eslint/no-explicit-any */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { actions, useDataStore } from "./store";
import { Grid } from "./Grid";

export function QueryTab() {
  const s = useDataStore();
  const result = s.queryResult;
  const isRead = result?.ok && result?.kind !== "write";

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <Input value={s.queryName} onChange={(e) => actions.setQueryName(e.target.value)} placeholder="Query name (for saving)" className="h-7 text-[11px]" />
      <Textarea
        value={s.sql}
        onChange={(e) => actions.setSql(e.target.value)}
        placeholder="SELECT * FROM v_recent_agent_activity LIMIT 50;"
        className="min-h-[120px] resize-y font-mono text-[12px] leading-relaxed"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => actions.runQuery(false)}>Run</Button>
        <Button size="sm" variant="outline" onClick={() => actions.saveQuery()}>Save</Button>
        <span className="font-mono text-[10.5px] text-muted-foreground">{s.queryStatus}</span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        Read queries are capped at {s.settings.maxQueryRows} row(s). Change `blacksite.data.maxQueryRows` in VS Code settings if you need a different limit.
      </div>

      {s.confirm && (
        <div className="rounded-lg border border-[color:var(--s-warn)]/40 bg-[color:var(--s-warn)]/10 p-2.5 text-[11px]">
          <div className="text-foreground">{s.confirm}</div>
          <div className="mt-2 flex gap-2">
            <Button size="xs" variant="destructive" onClick={() => actions.runQuery(true)}>Run anyway</Button>
            <Button size="xs" variant="ghost" onClick={() => actions.cancelConfirm()}>Cancel</Button>
          </div>
        </div>
      )}

      {isRead && <Grid columns={result.columns} rows={result.rows} onRowClick={(row) => actions.openDrawer(row)} />}

      <div className="mt-1 text-[9px] font-bold uppercase tracking-[0.07em] text-muted-foreground">Saved Queries</div>
      {s.savedQueries.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">No saved queries yet.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {s.savedQueries.map((q: any) => (
            <div key={q.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-white/[0.03] px-2 py-1.5">
              <div className="min-w-0">
                <div className="truncate text-[11.5px] text-foreground">{q.name}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{q.sql}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="xs" variant="ghost" onClick={() => actions.openSaved(q.id)}>Open</Button>
                <Button size="xs" variant="ghost" onClick={() => actions.deleteSaved(q.id)}>×</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
