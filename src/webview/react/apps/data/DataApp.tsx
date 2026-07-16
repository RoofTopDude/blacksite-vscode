import { useEffect } from "react";
import { Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actions, initDataStore, useDataStore, type DataTab } from "./store";
import { Explorer } from "./Explorer";
import { QueryTab } from "./QueryTab";
import { AssistantTab } from "./AssistantTab";
import { VectorsTab } from "./VectorsTab";
import { RagTab } from "./RagTab";

const TABS: Array<{ id: DataTab; label: string }> = [
  { id: "explorer", label: "Explorer" },
  { id: "query", label: "Query" },
  { id: "assistant", label: "Assistant" },
  { id: "vectors", label: "Vectors" },
  { id: "rag", label: "RAG" },
];

export function DataApp() {
  const s = useDataStore();
  useEffect(() => { initDataStore(); }, []);

  const available = !!s.status?.available;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-3 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-lg font-semibold text-foreground">Data</div>
          <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full" style={{ background: available ? "var(--s-ok)" : "var(--s-err)" }} />
            {available ? `${s.status.engine} · schema v${s.status.schemaVersion}` : "engine unavailable"}
          </div>
        </div>
        <div className="mt-2 flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => actions.setTab(t.id)}
              className={cn(
                "rounded-t-md border-b-2 px-2.5 py-1.5 text-base transition-colors",
                s.tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 py-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Preview {s.settings.previewPageSize}/page</span>
            <span>Query cap {s.settings.maxQueryRows} rows</span>
            <span>Assistant {s.settings.enableAssistant ? "on" : "off"}</span>
            <span>Active backend {s.activeBackend}</span>
            {s.configuredBackend !== s.activeBackend && <span>Configured {s.configuredBackend}</span>}
          </div>
          <Button size="xs" variant="ghost" onClick={() => actions.openSettings("blacksite.data")}>
            <Settings2 className="size-3" /> Settings
          </Button>
        </div>
      </header>

      {!available && s.status?.reason && (
        <div className="m-3 rounded-lg border border-[color:var(--s-err)]/30 bg-[color:var(--s-err)]/10 p-2.5 text-sm text-foreground">
          Database engine unavailable. {s.status.reason}<br />The rest of Blacksite still works; reconnect once a SQLite binding is present.
        </div>
      )}

      {s.tab === "explorer" && <Explorer />}
      {s.tab === "query" && <QueryTab />}
      {s.tab === "assistant" && <AssistantTab />}
      {s.tab === "vectors" && <VectorsTab />}
      {s.tab === "rag" && <RagTab />}

      {s.drawerRow && (
        <div onClick={(e) => { if (e.target === e.currentTarget) actions.closeDrawer(); }} className="fixed inset-0 z-30 flex justify-end bg-black/45">
          <div className="flex w-[min(560px,92vw)] flex-col border-l border-border bg-background p-3">
            <div className="flex items-center justify-between">
              <strong className="text-base">Row detail</strong>
              <button onClick={() => actions.closeDrawer()} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            </div>
            <pre className="detail-pre mt-2 flex-1 overflow-auto rounded-md border border-border bg-white/[0.03] p-2.5">{JSON.stringify(s.drawerRow, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
