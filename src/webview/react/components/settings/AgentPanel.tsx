import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ALL_TOOL_NAMES, TOOL_GROUPS, toolDisplayName } from "@/lib/format";
import { actions, useStore } from "@/lib/store";
import { Field, Note, Row, Section } from "./common";

export function AgentPanel() {
  const store = useStore();
  const { settings, memoryStats } = store;
  const disabled = new Set(settings.disabledTools);
  const memoryEnabled = !!settings.agentMemory?.enabled;

  return (
    <Section>
      <Field label="Max Iterations" hint="Maximum agent tool-loop rounds before stopping.">
        <Input
          type="number" min={1} max={200}
          value={settings.maxIterations ?? 40}
          onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 1) actions.setMaxIterations(n); }}
          className="h-7 w-24 text-[11px]"
        />
      </Field>

      <Separator />

      <Field label="Tool Access">
        <div className="-mt-0.5 mb-1 flex gap-1.5">
          <Button size="xs" variant="outline" onClick={() => actions.toggleAllTools(ALL_TOOL_NAMES, true)}>Enable all</Button>
          <Button size="xs" variant="outline" onClick={() => actions.toggleAllTools(ALL_TOOL_NAMES, false)}>Disable all</Button>
        </div>
        <div className="flex flex-col gap-2.5">
          {TOOL_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{group.label}</div>
              <div className="flex flex-wrap gap-1">
                {group.tools.map((name) => {
                  const enabled = !disabled.has(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      title={name}
                      onClick={() => actions.toggleTool(name, !enabled)}
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors",
                        enabled
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border bg-white/[0.02] text-muted-foreground opacity-60 hover:opacity-100",
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", enabled ? "bg-primary" : "bg-muted-foreground/50")} />
                      {toolDisplayName(name)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Field>

      <Separator />

      <Field label="Agent Memory">
        <Note>
          Builds a local vector index over past tool calls, compressed history, and notes for semantic recall.
          Enables the <code className="rounded bg-primary/15 px-1 text-[9.5px] text-primary">memory_search</code> tool.
        </Note>
        <Row label="Enable memory index">
          <Switch checked={memoryEnabled} onCheckedChange={(c) => actions.setMemoryIndex(c)} />
        </Row>
        {memoryEnabled && memoryStats && (
          <div className="rounded-md border border-border bg-white/[0.02] px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">{memoryStats.total ?? 0}</span> entries indexed — {memoryStats.toolCalls ?? 0} tool calls · {memoryStats.chunks ?? 0} history chunks · {memoryStats.memories ?? 0} notes
          </div>
        )}
      </Field>
    </Section>
  );
}
