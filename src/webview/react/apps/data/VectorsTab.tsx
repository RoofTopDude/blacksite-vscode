/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { actions, useDataStore } from "./store";

const BACKEND_OPTIONS = [
  { value: "exact_local", label: "exact_local", hint: "embedded" },
  { value: "pgvector_container", label: "pgvector_container", hint: "sidecar" },
];

export function VectorsTab() {
  const s = useDataStore();
  const [text, setText] = useState("");
  const stats = s.vectorStats;

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") actions.vectorSearch(text); }} placeholder="Search text (embedded locally)…" className="h-7 flex-1 text-sm" />
        <Select
          value={s.vectorCollection}
          onChange={(value) => actions.setVectorCollection(value)}
          ariaLabel="Vector collection"
          className="w-32 shrink-0"
          options={[
            { value: "", label: "All collections" },
            ...(stats?.collections || []).map((c: any) => ({ value: c.name, label: c.name, hint: String(c.count) })),
          ]}
        />
        <Button size="sm" onClick={() => actions.vectorSearch(text)}>Search</Button>
      </div>

      {stats && <div className="text-sm text-muted-foreground">Backend: {stats.backend} · {stats.total} vectors across {stats.collections.length} collection(s).</div>}

      <div className="fade-in flex flex-col gap-1.5">
        {s.vectorResults && (s.vectorResults.length === 0
          ? <div className="chat-surface border-dashed p-4 text-sm text-muted-foreground">No matches.</div>
          : s.vectorResults.map((h: any, i) => {
            const txt = (h.payload && (h.payload.text || h.payload.content || h.payload.title)) || h.id;
            return (
              <div key={i} className="lift chat-surface p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-foreground">{String(txt).slice(0, 240)}</div>
                  <span className="shrink-0 font-mono text-xs text-primary">{Number(h.score).toFixed(3)}</span>
                </div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">{h.collection} · {h.id}</div>
              </div>
            );
          }))}
      </div>

      <div className="eyebrow mt-1">Vector Backend</div>
      <div className="chat-surface flex flex-col gap-2 p-2.5">
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
          <Select value={s.backend} onChange={(value) => actions.setBackend(value)} options={BACKEND_OPTIONS} ariaLabel="Vector backend" className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => actions.applyBackend()}>Use backend</Button>
        </div>
        {s.sidecarMsg && <div className="font-mono text-xs text-muted-foreground">{s.sidecarMsg}</div>}
      </div>
    </div>
  );
}
