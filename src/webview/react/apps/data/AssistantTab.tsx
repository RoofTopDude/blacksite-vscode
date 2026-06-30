import { useState, type CSSProperties } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actions, useDataStore } from "./store";

const SAFETY_TONE: Record<string, string> = {
  read: "var(--s-ok)", write: "var(--s-warn)", ddl: "var(--s-warn)", destructive: "var(--s-err)", unknown: "var(--muted-foreground)",
};

function safetyStyle(safety: string): CSSProperties {
  const c = SAFETY_TONE[safety] || "var(--muted-foreground)";
  return { color: c, background: `color-mix(in srgb, ${c} 16%, transparent)` };
}

export function AssistantTab() {
  const s = useDataStore();
  const [input, setInput] = useState("");

  function ask(): void {
    if (!input.trim()) return;
    actions.askAssistant(input);
    setInput("");
  }

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <div className="text-[11px] leading-relaxed text-muted-foreground">
        Ask about your local database. The assistant inspects the live catalog, proposes SQL, explains it, and waits for your approval before any write.
      </div>
      {!s.settings.enableAssistant && (
        <div className="rounded-lg border border-[color:var(--s-warn)]/35 bg-[color:var(--s-warn)]/10 p-2.5 text-[11px] text-foreground">
          The database assistant is currently disabled in `blacksite.data.enableAssistant`.
          <div className="mt-2">
            <Button size="xs" variant="outline" onClick={() => actions.openSettings("blacksite.data.enableAssistant")}>
              Open setting
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") ask(); }} placeholder="e.g. show recent failed tool events" className="h-7 flex-1 text-[11px]" disabled={!s.settings.enableAssistant} />
        <Button size="sm" onClick={ask} disabled={!s.settings.enableAssistant}>Ask</Button>
      </div>

      <div className="flex flex-col gap-2">
        {s.assistantLog.map((entry) => (
          <div key={entry.id} className={cn("rounded-lg border border-border p-2.5", entry.role === "user" ? "border-primary/35 bg-primary/10" : "bg-white/[0.03]")}>
            {entry.pending ? (
              <div className="text-[11px] text-muted-foreground">Thinking…</div>
            ) : (
              <>
                <div className={cn("text-[11.5px]", entry.error ? "text-muted-foreground" : "text-foreground")}>{entry.text}</div>
                {entry.sql && (
                  <>
                    <pre className="mt-2 overflow-auto rounded-md bg-black/25 p-2 font-mono text-[11px] text-foreground">{entry.sql}</pre>
                    <div className="mt-1.5 flex items-center gap-2">
                      {entry.safety && (
                        <span className="rounded-full px-2 py-px font-mono text-[9.5px]" style={safetyStyle(entry.safety)}>
                          {entry.safety}{entry.needsConfirmation ? " · needs confirmation" : ""}
                        </span>
                      )}
                      <Button size="xs" variant="outline" onClick={() => actions.useSql(entry.sql!)}>Open in Query tab</Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
