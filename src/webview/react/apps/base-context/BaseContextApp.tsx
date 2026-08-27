import { useEffect, useRef, useState } from "react";
import { FileText, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/PanelHeader";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { post, onMessage } from "@/lib/bridge";

interface FileRef { id: string; path: string; addedAt?: string; }
interface Topic { id: string; title: string; notes: string; enabled: boolean; pinned: boolean; updatedAt?: string; createdAt?: string; files: FileRef[]; }
interface Doc { topics: Topic[]; }

const EMPTY: Doc = { topics: [] };

export function BaseContextApp() {
  const [doc, setDoc] = useState<Doc>(EMPTY);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [workspaceRules, setWorkspaceRules] = useState("");
  const [workspaceRulesMaxChars, setWorkspaceRulesMaxChars] = useState(12_000);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const rulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkspaceRules = useRef<string | null>(null);

  useEffect(() => {
    const pendingTimers = timers.current;
    const off = onMessage((msg) => {
      if (msg.type === "base_context_state") {
        setDoc(msg.document || EMPTY);
        setActiveFile(typeof msg.activeFile === "string" ? msg.activeFile : null);
        const incomingRules = typeof msg.workspaceRules === "string" ? msg.workspaceRules : "";
        // Acknowledgements can arrive after the user has typed another change. Only accept an
        // older host state when there is no local edit waiting to be persisted.
        if (pendingWorkspaceRules.current === null || incomingRules === pendingWorkspaceRules.current) {
          setWorkspaceRules(incomingRules);
          pendingWorkspaceRules.current = null;
        }
        if (typeof msg.workspaceRulesMaxChars === "number") setWorkspaceRulesMaxChars(msg.workspaceRulesMaxChars);
      }
    });
    post({ type: "ready" });
    return () => {
      off();
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      if (rulesTimer.current) clearTimeout(rulesTimer.current);
    };
  }, []);

  function queueUpdate(topicId: string, patch: Record<string, unknown>): void {
    const key = `${topicId}:${Object.keys(patch).join(",")}`;
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);
    timers.current.set(key, setTimeout(() => {
      post({ type: "update_topic", topicId, ...patch });
      timers.current.delete(key);
    }, 220));
  }

  function saveWorkspaceRules(value: string, immediate = false): void {
    if (rulesTimer.current) clearTimeout(rulesTimer.current);
    const save = () => {
      post({ type: "update_workspace_rules", rules: value });
      rulesTimer.current = null;
    };
    if (immediate) save();
    else rulesTimer.current = setTimeout(save, 350);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="living-panel-header shrink-0 border-b border-border px-3 py-2.5">
        <PanelHeader
          eyebrow="Persistent memory"
          title="Base Context"
          sub="Reusable project knowledge loaded into every agent run."
          status={{
            label: `${doc.topics.filter((topic) => topic.enabled).length}/${doc.topics.length} active`,
            tone: doc.topics.some((topic) => topic.enabled) ? "ok" : "idle",
          }}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="xs" onClick={() => post({ type: "create_topic" })}><Plus className="size-3" /> New topic</Button>
          <Button size="xs" variant="outline" onClick={() => post({ type: "add_active_file" })}>Add active file</Button>
          <Button size="xs" variant="outline" onClick={() => post({ type: "refresh" })}>Refresh</Button>
        </div>
        <div className="mt-1.5 truncate font-mono text-xs text-muted-foreground">{activeFile ? `Active file: ${activeFile}` : "No active editor file."}</div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <section className="chat-surface mb-3 overflow-hidden">
          <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2.5">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Workspace Rules</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Explicit operating instructions loaded into every agent run. Higher-priority system and repository guidance still applies.</p>
            </div>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">{workspaceRules.length.toLocaleString()}/{workspaceRulesMaxChars.toLocaleString()}</span>
          </div>
          <div className="p-2.5">
            <Textarea
              value={workspaceRules}
              maxLength={workspaceRulesMaxChars}
              placeholder={"Examples:\n- Run the focused test before changing shared code.\n- Keep public APIs backward compatible.\n- Ask before changing deployment configuration."}
              onChange={(event) => {
                const next = event.target.value.slice(0, workspaceRulesMaxChars);
                setWorkspaceRules(next);
                pendingWorkspaceRules.current = next;
                saveWorkspaceRules(next);
              }}
              onBlur={(event) => {
                pendingWorkspaceRules.current = event.target.value;
                saveWorkspaceRules(event.target.value, true);
              }}
              className="min-h-[132px] resize-y rounded-lg text-base leading-relaxed"
            />
          </div>
        </section>

        {doc.topics.length === 0 ? (
          <div className="fade-in chat-surface border-dashed p-4 text-sm leading-relaxed text-muted-foreground">
            <div className="font-medium text-foreground">Give the agent durable project context.</div>
            <div className="mt-1">Create a topic for architecture, conventions, or constraints, then attach the files that ground it.</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {doc.topics.map((topic) => (
              <section key={topic.id} className="turn-in chat-surface overflow-hidden rounded-xl">
                <div className="flex items-start justify-between gap-2 p-2.5 pb-2">
                  <div className="min-w-0 flex-1">
                    <input
                      key={topic.id}
                      defaultValue={topic.title}
                      placeholder="Topic title"
                      onChange={(e) => queueUpdate(topic.id, { title: e.target.value })}
                      className="chat-interactive w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-lg font-semibold text-foreground outline-none focus:border-primary/50 focus:bg-white/[0.04]"
                    />
                    <div className="mt-1 flex flex-wrap gap-1 px-1.5 text-xs text-muted-foreground">
                      <span className="rounded-full border border-border bg-white/5 px-2 py-px">{topic.enabled ? "In prompt" : "Hidden"}</span>
                      <span className="rounded-full border border-border bg-white/5 px-2 py-px">{topic.files.length} file{topic.files.length === 1 ? "" : "s"}</span>
                      {topic.pinned && <span className="rounded-full border border-border bg-white/5 px-2 py-px">Pinned</span>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch size="sm" checked={topic.enabled} onCheckedChange={(c) => post({ type: "update_topic", topicId: topic.id, enabled: c })} /> Include
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch size="sm" checked={topic.pinned} onCheckedChange={(c) => post({ type: "update_topic", topicId: topic.id, pinned: c })} /> Pin
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-2 px-2.5 pb-2.5">
                  <Textarea
                    key={`${topic.id}:notes`}
                    defaultValue={topic.notes}
                    placeholder="Persistent context, assumptions, architecture notes, API references — anything the agent should always know for this topic."
                    onChange={(e) => queueUpdate(topic.id, { notes: e.target.value })}
                    className="min-h-[96px] resize-y rounded-lg text-base leading-relaxed"
                  />

                  <div className="flex flex-col gap-1.5">
                    {topic.files.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No linked files yet.</div>
                    ) : topic.files.map((file) => (
                      <div key={file.id} className="chat-interactive chat-sunken flex items-center justify-between gap-2 px-2 py-1.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <FileText className="size-3 shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono text-sm text-foreground" title={file.path}>{file.path}</span>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button size="xs" variant="ghost" onClick={() => post({ type: "open_file", path: file.path })}>Open</Button>
                          <Button size="xs" variant="ghost" onClick={() => post({ type: "remove_file", topicId: topic.id, fileId: file.id })}><Trash2 className="size-3" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Updated {topic.updatedAt || topic.createdAt || "recently"}</span>
                    <div className="flex gap-1.5">
                      <Button size="xs" variant="outline" onClick={() => post({ type: "add_file_to_topic", topicId: topic.id })}>Add active file</Button>
                      <Button size="xs" variant="ghost" onClick={() => post({ type: "delete_topic", topicId: topic.id })}>Delete</Button>
                    </div>
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
