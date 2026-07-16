/* eslint-disable @typescript-eslint/no-explicit-any */
import { useDataStore } from "./store";

export function RagTab() {
  const s = useDataStore();
  const vectors = s.catalog?.groups?.find((g: any) => g.id === "vectors");
  const objects: any[] = vectors?.objects || [];

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <div className="text-sm leading-relaxed text-muted-foreground">
        Retrieval sources, chunking, embedding status, and traces. Documents and chunks land here as ingestion jobs run.
      </div>
      <div className="text-2xs font-bold uppercase tracking-[0.07em] text-muted-foreground">Vector Collections</div>
      {objects.length === 0 ? (
        <div className="text-sm text-muted-foreground">No collections yet.</div>
      ) : objects.map((o) => (
        <div key={o.name} className="flex items-center justify-between gap-2 rounded-md border border-border bg-white/[0.03] px-2 py-1.5">
          <div className="min-w-0">
            <div className="truncate text-base text-foreground">{o.name}</div>
            {o.detail && <div className="truncate font-mono text-xs text-muted-foreground">{o.detail}</div>}
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{o.rowCount || 0}</span>
        </div>
      ))}
    </div>
  );
}
