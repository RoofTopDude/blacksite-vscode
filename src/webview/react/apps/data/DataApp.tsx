import { useEffect, useRef } from "react";
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

function RowDetailDrawer({ row }: { row: unknown }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") actions.closeDrawer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  return (
    <div
      className="data-drawer-backdrop fade-in"
      onMouseDown={(event) => { if (event.target === event.currentTarget) actions.closeDrawer(); }}
    >
      <aside className="data-drawer" role="dialog" aria-modal="true" aria-labelledby="data-drawer-title">
        <header className="data-drawer-header">
          <div className="min-w-0">
            <div className="eyebrow">Record inspector</div>
            <h2 id="data-drawer-title" className="mt-0.5 truncate text-base font-semibold text-foreground">Row detail</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => actions.closeDrawer()}
            aria-label="Close row detail"
            title="Close (Escape)"
            className="chat-interactive inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-white/[0.07] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        <pre className="detail-pre data-drawer-content chat-sunken mt-3 flex-1 overflow-auto p-2.5">{JSON.stringify(row, null, 2)}</pre>
      </aside>
    </div>
  );
}

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
              className={cn("tab-strip-item rounded-t-md px-2.5 py-1.5 text-base", s.tab === t.id && "is-active")}
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
        <div className="fade-in m-3 rounded-lg border border-[color:var(--s-err)]/30 bg-[color:var(--s-err)]/10 p-2.5 text-sm text-foreground">
          Database engine unavailable. {s.status.reason}<br />The rest of Blacksite still works; reconnect once a SQLite binding is present.
        </div>
      )}

      <div key={s.tab} className="fade-in flex flex-1 flex-col overflow-hidden">
        {s.tab === "explorer" && <Explorer />}
        {s.tab === "query" && <QueryTab />}
        {s.tab === "assistant" && <AssistantTab />}
        {s.tab === "vectors" && <VectorsTab />}
        {s.tab === "rag" && <RagTab />}
      </div>

      {s.drawerRow && (
        <RowDetailDrawer row={s.drawerRow} />
      )}
    </div>
  );
}
