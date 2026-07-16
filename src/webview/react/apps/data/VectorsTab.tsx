/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { actions, useDataStore } from "./store";

const selectCls = "h-7 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring";

export function VectorsTab() {
  const s = useDataStore();
  const [text, setText] = useState("");
  const stats = s.vectorStats;

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") actions.vectorSearch(text); }} placeholder="Search text (embedded locally)…" className="h-7 flex-1 text-sm" />
        <select value={s.vectorCollection} onChange={(e) => actions.setVectorCollection(e.target.value)} className={`${selectCls} w-32`}>
          <option value="">All collections</option>
          {(stats?.collections || []).map((c: any) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
        <Button size="sm" onClick={() => actions.vectorSearch(text)}>Search</Button>
      </div>

      {stats && <div className="text-sm text-muted-foreground">Backend: {stats.backend} · {stats.total} vectors across {stats.collections.length} collection(s).</div>}

      <div className="flex flex-col gap-1.5">
        {s.vectorResults && (s.vectorResults.length === 0
          ? <div className="rounded-lg border border-dashed border-border bg-white/[0.02] p-4 text-sm text-muted-foreground">No matches.</div>
          : s.vectorResults.map((h: any, i) => {
            const txt = (h.payload && (h.payload.text || h.payload.content || h.payload.title)) || h.id;
            return (
              <div key={i} className="rounded-md border border-border bg-white/[0.03] p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-foreground">{String(txt).slice(0, 240)}</div>
                  <span className="shrink-0 font-mono text-xs text-primary">{Number(h.score).toFixed(3)}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">{h.collection} · {h.id}</div>
              </div>
            );
          }))}
      </div>

      <div className="mt-1 text-2xs font-bold uppercase tracking-[0.07em] text-muted-foreground">Vector Backend</div>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-white/[0.03] p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-base text-foreground">PostgreSQL + pgvector sidecar</div>
            <div className="font-mono text-xs text-muted-foreground">{s.sidecarStatus}</div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="xs" variant="outline" onClick={() => actions.sidecarUp()}>Start</Button>
            <Button size="xs" variant="outline" onClick={() => actions.sidecarStop()}>Stop</Button>
            <Button size="xs" variant="ghost" onClick={() => actions.sidecarStatus()}>Check</Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={s.backend} onChange={(e) => actions.setBackend(e.target.value)} className={`${selectCls} flex-1`}>
            <option value="exact_local">exact_local (embedded)</option>
            <option value="pgvector_container">pgvector_container (sidecar)</option>
          </select>
          <Button size="xs" variant="outline" onClick={() => actions.applyBackend()}>Use backend</Button>
        </div>
        {s.sidecarMsg && <div className="font-mono text-xs text-muted-foreground">{s.sidecarMsg}</div>}
      </div>
    </div>
  );
}
