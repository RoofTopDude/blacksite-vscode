import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { Field, Note, Section } from "./common";
import { KEY_PROVIDERS } from "./helpers";

export function AdvancedPanel() {
  const store = useStore();
  const turns = store.logStats?.turnCount ?? 0;

  return (
    <Section>
      <Field label="Execution Logs">
        <Note>
          Every tool call, iteration, diagnostic, and error is written to
          <code className="mx-1 rounded bg-white/10 px-1 text-xs">.blacksite/execution.log</code>
          plus structured JSONL.
        </Note>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => actions.showLogs()}>Open Output Panel</Button>
          <Button size="xs" variant="outline" onClick={() => actions.exportLogs()}>Open Log File</Button>
        </div>
        {turns > 0 && <div className="text-xs text-muted-foreground">{turns} turn{turns === 1 ? "" : "s"} logged this session</div>}
      </Field>

      <Separator />

      <Field label="API Keys">
        <div className="flex flex-col gap-1">
          {KEY_PROVIDERS.map((p) => {
            const set = !!store.keyStatus[p.id];
            return (
              <div key={p.id} className="flex items-center gap-2 rounded-md border border-border bg-white/[0.02] px-2 py-1">
                <span className="flex-1 truncate text-sm text-foreground">{p.label}</span>
                <span className={cn("rounded-full px-1.5 py-px text-2xs font-semibold", set ? "text-[color:var(--s-ok)]" : "text-muted-foreground")}>{set ? "Set" : "—"}</span>
                <Button size="xs" variant="ghost" onClick={() => actions.setApiKey(p.id)}>{set ? "Change" : "Set"}</Button>
                {set && <Button size="xs" variant="ghost" onClick={() => actions.clearApiKey(p.id)}>Clear</Button>}
              </div>
            );
          })}
        </div>
      </Field>

      <Separator />

      <Field label="VS Code Settings">
        <Note>
          Some extension-level options still live in VS Code Settings rather than the chat panel:
          browser headless mode, workspace root override, Data workbench limits, and MCP server configuration.
        </Note>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => actions.openSettings("@ext:blacksite blacksite.")}>Open Extension Settings</Button>
          <Button size="xs" variant="outline" onClick={() => actions.openSettings("blacksite.data")}>Open Data Settings</Button>
        </div>
      </Field>
    </Section>
  );
}
