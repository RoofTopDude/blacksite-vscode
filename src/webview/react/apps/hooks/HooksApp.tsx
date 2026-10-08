import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, BookOpen, CheckCircle2, FileJson, Pencil, Play, Plus, ScrollText, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { PanelHeader } from "@/components/PanelHeader";
import { post, onMessage } from "@/lib/bridge";
import { cn } from "@/lib/utils";

type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "Notification";

interface Hook {
  event: HookEvent;
  command: string;
  args?: string[];
  tools?: string[];
  timeoutMs?: number;
}

interface Entry {
  index: number;
  hook: Hook | null;
  raw: unknown;
  problem: string | null;
  found: string | null;
  test: { summary: string; tone: string } | null;
}

interface Run {
  at: string;
  event: string;
  command: string;
  toolName?: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

interface State {
  events: HookEvent[];
  trusted: boolean;
  shadowed: boolean;
  tooMany: boolean;
  entries: Entry[];
  runs: Run[];
}

/** Short labels; the tooltip says what the event does and how a script talks back. */
const EVENT_INFO: Record<HookEvent, { label: string; hint: string; tools: boolean }> = {
  UserPromptSubmit: {
    label: "Before a prompt",
    hint: "Runs when you send a message. A nonzero exit blocks the prompt. Printing {\"additionalContext\": \"…\"} adds a note for the agent.",
    tools: false,
  },
  PreToolUse: {
    label: "Before a tool",
    hint: "Runs before each matching tool call. A nonzero exit (or {\"decision\":\"block\"}) stops the call and tells the agent why.",
    tools: true,
  },
  PostToolUse: {
    label: "After a tool",
    hint: "Runs after each matching tool call. Exit 2 (or {\"decision\":\"block\",\"reason\":\"…\"}) sends the reason to the agent as feedback. Other failures are warnings.",
    tools: true,
  },
  Stop: {
    label: "When the agent stops",
    hint: "Runs when a run ends normally. Exit 2 (or {\"decision\":\"block\"}) asks the agent to keep going, at most twice per run.",
    tools: false,
  },
  Notification: {
    label: "When it needs you",
    hint: "Fire-and-forget when an approval or a question is waiting for you. Its result is ignored.",
    tools: false,
  },
};

interface Draft {
  event: HookEvent;
  command: string;
  args: string;
  tools: string;
  timeout: string;
}

const EMPTY_DRAFT: Draft = { event: "PostToolUse", command: "", args: "", tools: "", timeout: "10" };

/** Split an argument line the way a shell would for plain words and quoted strings. */
function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
    }
  }
  if (started || current) args.push(current);
  return args;
}

function joinArgs(args: string[] | undefined): string {
  return (args ?? []).map((arg) => (arg === "" || /[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function draftFrom(hook: Hook): Draft {
  return {
    event: hook.event,
    command: hook.command,
    args: joinArgs(hook.args),
    tools: (hook.tools ?? []).join(", "),
    timeout: String((hook.timeoutMs ?? 10_000) / 1000),
  };
}

/** A form prefilled from an entry that failed validation, keeping whatever parts are usable —
 *  including the `matcher` and `timeout` spellings other agents' hook formats use. */
function draftFromRaw(raw: unknown): Draft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const event = typeof r.event === "string" && r.event in EVENT_INFO ? r.event as HookEvent : EMPTY_DRAFT.event;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []);
  const timeout = typeof r.timeoutMs === "number" ? r.timeoutMs / 1000 : typeof r.timeout === "number" ? r.timeout : 10;
  return {
    event,
    command: typeof r.command === "string" ? r.command : "",
    args: joinArgs(strings(r.args)),
    tools: [...strings(r.tools), ...strings(r.matcher)].join(", "),
    timeout: String(timeout),
  };
}

function hookFrom(draft: Draft): Hook {
  const seconds = Number(draft.timeout);
  const tools = EVENT_INFO[draft.event].tools ? draft.tools.split(",").map((tool) => tool.trim()).filter(Boolean) : [];
  return {
    event: draft.event,
    command: draft.command.trim(),
    args: splitArgs(draft.args),
    tools,
    timeoutMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 10_000,
  };
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

export function HooksApp() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  /** "new" for the add form, an entry index while editing one. */
  const [editing, setEditing] = useState<"new" | number | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === "hooks_state") {
        setState(msg as State);
        setError("");
      }
      if (msg.type === "hooks_error") setError(String(msg.message ?? "Something went wrong."));
    });
    post({ type: "ready" });
    return off;
  }, []);

  const valid = useMemo(() => (state?.entries ?? []).filter((entry) => entry.hook), [state]);
  const broken = useMemo(() => (state?.entries ?? []).filter((entry) => !entry.hook), [state]);
  const grouped = useMemo(
    () => (state?.events ?? []).map((event) => ({ event, entries: valid.filter((entry) => entry.hook!.event === event) })),
    [state, valid],
  );

  function startAdd(event?: HookEvent) {
    setDraft({ ...EMPTY_DRAFT, event: event ?? EMPTY_DRAFT.event });
    setEditing("new");
  }

  function save() {
    const hook = hookFrom(draft);
    if (editing === "new") post({ type: "add", hook });
    else if (typeof editing === "number") post({ type: "update", index: editing, hook });
    setEditing(null);
  }

  if (!state) {
    return <div className="p-3 text-xs text-muted-foreground">Loading hooks…</div>;
  }

  const notFound = valid.filter((entry) => !entry.found).length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2.5">
        <PanelHeader
          title="Hooks"
          eyebrow="Lifecycle scripts"
          sub={
            valid.length === 0
              ? "Scripts that run at points in the agent's work. None yet."
              : `${valid.length} hook${valid.length === 1 ? "" : "s"}${notFound ? ` · ${notFound} not found` : ""} · from your user settings`
          }
          status={state.trusted ? undefined : { label: "Untrusted", tone: "warn" }}
          actions={
            <>
              <Button size="icon-sm" variant="ghost" title="Open blacksite.hooks.commands in user settings.json" aria-label="Open settings.json" onClick={() => post({ type: "open_settings_json" })}><FileJson /></Button>
              <Button size="icon-sm" variant="ghost" title="Show the Blacksite Hooks output, which logs every run" aria-label="Show log" onClick={() => post({ type: "show_log" })}><ScrollText /></Button>
              <Button size="icon-sm" variant="ghost" title="How hooks work: events, exit codes and JSON output" aria-label="Open documentation" onClick={() => post({ type: "open_docs" })}><BookOpen /></Button>
              <Button size="sm" variant={editing === "new" ? "ghost" : "default"} disabled={state.tooMany} onClick={() => (editing === "new" ? setEditing(null) : startAdd())}>
                {editing === "new" ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
                {editing === "new" ? "Close" : "Add hook"}
              </Button>
            </>
          }
        />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {error && <Notice tone="error">{error}</Notice>}
        {!state.trusted && (
          <Notice tone="warn">This workspace is not trusted, so no hooks run here. Trust the workspace to run and test them.</Notice>
        )}
        {state.shadowed && (
          <Notice tone="warn">blacksite.hooks.commands is also set in this workspace's settings. That copy is ignored: hooks come from your user settings only, so a repository cannot install one.</Notice>
        )}

        {editing === "new" && <HookForm draft={draft} onChange={setDraft} onCancel={() => setEditing(null)} onSave={save} title="New hook" />}

        {valid.length === 0 && editing !== "new" && (
          <div className="mb-4 rounded-md border border-dashed border-border px-3 py-6 text-center">
            <p className="mx-auto max-w-md text-xs text-muted-foreground">
              A hook runs a program of yours when something happens: before a tool call (to block it), after an edit (to
              format or lint), or when the agent finishes (to run tests). It gets the event as JSON on stdin.
            </p>
            <Button size="sm" className="mt-3" onClick={() => startAdd()}><Plus className="size-3.5" />Add hook</Button>
          </div>
        )}

        {broken.length > 0 && (
          <section className="mb-4">
            <h2 className="eyebrow mb-1.5 text-destructive" title="These entries are in your settings but cannot run. A broken entry for a blocking event stops prompts and tool calls until it is fixed.">
              Needs fixing · {broken.length}
            </h2>
            <div className="space-y-1.5">
              {broken.map((entry) => (
                <div key={entry.index} className="rounded-md border border-destructive/40 bg-card px-2.5 py-2">
                  <p className="text-2xs text-destructive">{entry.problem}</p>
                  <pre className="mt-1 max-h-24 overflow-auto rounded bg-background/40 p-1.5 font-mono text-2xs text-muted-foreground">{JSON.stringify(entry.raw, null, 2)}</pre>
                  <div className="mt-1.5 flex gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => { setDraft(draftFromRaw(entry.raw)); setEditing(entry.index); }}><Pencil />Fix</Button>
                    <Button size="xs" variant="ghost" onClick={() => post({ type: "remove", index: entry.index })}><Trash2 />Remove</Button>
                  </div>
                  {editing === entry.index && <HookForm draft={draft} onChange={setDraft} onCancel={() => setEditing(null)} onSave={save} title="Fix hook" />}
                </div>
              ))}
            </div>
          </section>
        )}

        {grouped.map(({ event, entries }) => (
          (entries.length > 0 || valid.length > 0) && (
            <section key={event} className="mb-4">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h2 className="eyebrow" title={EVENT_INFO[event].hint}>
                  {EVENT_INFO[event].label} <span className="font-mono normal-case text-muted-foreground/70">{event}</span>{entries.length ? ` · ${entries.length}` : ""}
                </h2>
                <Button size="xs" variant="ghost" title={`Add a ${event} hook`} onClick={() => startAdd(event)}><Plus />Add</Button>
              </div>
              {entries.length === 0
                ? <p className="text-2xs text-muted-foreground/70">None.</p>
                : (
                  <div className="space-y-1.5">
                    {entries.map((entry, position) => (
                      <HookRow
                        key={entry.index}
                        entry={entry}
                        trusted={state.trusted}
                        canMoveUp={position > 0}
                        canMoveDown={position < entries.length - 1}
                        onMove={(direction) => {
                          const neighbour = entries[position + direction];
                          if (neighbour) post({ type: "move", index: entry.index, to: neighbour.index });
                        }}
                        editing={editing === entry.index}
                        onEdit={() => { setDraft(draftFrom(entry.hook!)); setEditing(entry.index); }}
                        form={editing === entry.index
                          ? <HookForm draft={draft} onChange={setDraft} onCancel={() => setEditing(null)} onSave={save} title="Edit hook" />
                          : null}
                      />
                    ))}
                  </div>
                )}
            </section>
          )
        ))}

        <section className="mb-2">
          <h2 className="eyebrow mb-1.5" title="Every hook run since this window opened, newest first. The Blacksite Hooks output keeps the full log.">
            Recent runs{state.runs.length ? ` · ${state.runs.length}` : ""}
          </h2>
          {state.runs.length === 0
            ? <p className="text-2xs text-muted-foreground/70">No hook has run in this window yet.</p>
            : (
              <ul className="space-y-1">
                {state.runs.map((run, index) => (
                  <li key={`${run.at}-${index}`} className="flex items-start gap-1.5 text-2xs">
                    {run.ok ? <CheckCircle2 className="mt-px size-3 shrink-0 text-ok" /> : <XCircle className="mt-px size-3 shrink-0 text-destructive" />}
                    <span className="shrink-0 text-muted-foreground" title={new Date(run.at).toLocaleString()}>{relativeTime(run.at)}</span>
                    <span className="shrink-0 text-muted-foreground">{run.event}{run.toolName ? ` ${run.toolName}` : ""}</span>
                    <span className="min-w-0 truncate font-mono text-foreground/80" title={run.command}>{run.command}</span>
                    <span className={cn("ml-auto shrink-0", run.ok ? "text-muted-foreground" : "text-destructive")} title={run.detail}>
                      {run.ok ? run.detail : run.detail.slice(0, 60)} · {run.elapsedMs} ms
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  return (
    <p className={cn("mb-3 flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-2xs", tone === "error" ? "border-destructive/40 text-destructive" : "border-warn/40 text-warn")}>
      <AlertTriangle className="mt-px size-3 shrink-0" /><span>{children}</span>
    </p>
  );
}

function HookRow({ entry, trusted, canMoveUp, canMoveDown, onMove, editing, onEdit, form }: {
  entry: Entry;
  trusted: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  editing: boolean;
  onEdit: () => void;
  form: React.ReactNode;
}) {
  const hook = entry.hook!;
  const commandLine = [hook.command, joinArgs(hook.args)].filter(Boolean).join(" ");
  const running = entry.test?.tone === "live";
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-foreground" title={commandLine}>{commandLine}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
            {entry.found
              ? <span className="inline-flex items-center gap-1" title={`Found at ${entry.found}`}><CheckCircle2 className="size-3 text-ok" />found</span>
              : <span className="inline-flex items-center gap-1 text-warn" title="Not found on PATH or at that path. Use a full path, or a program on your PATH."><AlertTriangle className="size-3" />not found</span>}
            {EVENT_INFO[hook.event].tools && (
              <span title="Tool names this hook runs for. * matches any run of characters.">
                {hook.tools?.length ? `tools: ${hook.tools.join(", ")}` : "every tool"}
              </span>
            )}
            <span title="The hook is stopped after this long. For a blocking event a timeout blocks.">{(hook.timeoutMs ?? 10_000) / 1000}s limit</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="icon-xs" variant="ghost" disabled={!canMoveUp} title="Run earlier. Hooks for one event run in order, and a blocking one stops the rest." aria-label="Move up" onClick={() => onMove(-1)}><ArrowUp /></Button>
          <Button size="icon-xs" variant="ghost" disabled={!canMoveDown} title="Run later" aria-label="Move down" onClick={() => onMove(1)}><ArrowDown /></Button>
          <Button size="icon-xs" variant="ghost" disabled={!trusted || running} title="Run once now with a sample payload, the way the agent would" aria-label="Test" onClick={() => post({ type: "test", index: entry.index })}><Play /></Button>
          <Button size="icon-xs" variant="ghost" title="Edit" aria-label="Edit" onClick={onEdit}><Pencil /></Button>
          <Button size="icon-xs" variant="ghost" title="Remove" aria-label="Remove" onClick={() => post({ type: "remove", index: entry.index })}><Trash2 /></Button>
        </div>
      </div>
      {entry.test && (
        <p className={cn(
          "mt-1.5 break-words text-2xs",
          entry.test.tone === "ok" ? "text-ok" : entry.test.tone === "warn" ? "text-warn" : entry.test.tone === "live" ? "text-muted-foreground signal-pulse" : "text-destructive",
        )}>
          {entry.test.summary}
        </p>
      )}
      {editing && form}
    </div>
  );
}

function HookForm({ draft, onChange, onCancel, onSave, title }: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  title: string;
}) {
  const info = EVENT_INFO[draft.event];
  const update = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const preview = [draft.command.trim(), joinArgs(splitArgs(draft.args))].filter(Boolean).join(" ");
  return (
    <div className="my-2 rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-xs font-medium text-foreground">{title}</div>
      <div className="grid gap-2.5">
        <div>
          <Label>When</Label>
          <Select
            value={draft.event}
            ariaLabel="Event"
            options={(Object.keys(EVENT_INFO) as HookEvent[]).map((event) => ({ value: event, label: EVENT_INFO[event].label, hint: event }))}
            onChange={(value) => update({ event: value as HookEvent })}
          />
          <p className="mt-1 text-2xs text-muted-foreground">{info.hint}</p>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2.5">
          <div>
            <Label htmlFor="hook-command">Program</Label>
            <Input id="hook-command" className="font-mono" value={draft.command} placeholder="node" onChange={(event) => update({ command: event.target.value })} />
          </div>
          <div>
            <Label htmlFor="hook-args">Arguments</Label>
            <Input id="hook-args" className="font-mono" value={draft.args} placeholder="scripts/check-edit.js --strict" onChange={(event) => update({ args: event.target.value })} />
          </div>
        </div>
        <p className="-mt-1.5 text-2xs text-muted-foreground">
          Started directly, without a shell: no pipes or variables. A name is looked up on your PATH; npm, npx and other .cmd
          programs work on Windows. Run scripts through node, python or pwsh. The working directory is the workspace.
        </p>
        <div className={cn("grid gap-2.5", info.tools ? "grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]")}>
          {info.tools && (
            <div>
              <Label htmlFor="hook-tools">Tools</Label>
              <Input id="hook-tools" className="font-mono" value={draft.tools} placeholder="file_edit, file_write, shell_*" onChange={(event) => update({ tools: event.target.value })} />
              <p className="mt-1 text-2xs text-muted-foreground">Comma-separated, * as a wildcard. Empty runs for every tool.</p>
            </div>
          )}
          <div>
            <Label htmlFor="hook-timeout">Time limit (s)</Label>
            <Input id="hook-timeout" type="number" min={0.1} max={60} step={0.5} value={draft.timeout} onChange={(event) => update({ timeout: event.target.value })} />
          </div>
        </div>
        {preview && <p className="truncate font-mono text-2xs text-muted-foreground" title={preview}>Runs: {preview}</p>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!draft.command.trim()} onClick={onSave}>Save</Button>
      </div>
    </div>
  );
}
