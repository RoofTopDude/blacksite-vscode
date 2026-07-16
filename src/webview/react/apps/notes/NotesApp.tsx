/* Map Notes timeline webview: an interactive, scrollable history of the
   working-memory notes attached to the Codebase Map, grouped by day, with
   revision trails, per-file git history, and one-click commit diffs. State is
   plain useState — this surface is a reader over host-pushed notes_state, not
   a second store of truth. */

import { useEffect, useMemo, useState } from "react";
import { post, onMessage } from "@/lib/bridge";
import { cssColor, folderColor } from "@/lib/graph/colors";
import type { GraphAnnotation } from "@/lib/graph/protocol";
import { baseName } from "@/lib/graph/view-model";
import { isNotesHostMessage, type NoteFileCommit, type NotesWebviewMessage } from "@/lib/notes/protocol";
import { filterNotes, groupNotesByDay, isRelationNote, relativeTime, type NoteScopeFilter } from "@/lib/notes/timeline";

function send(message: NotesWebviewMessage): void {
  post(message);
}

interface FileHistoryState {
  loading: boolean;
  commits: NoteFileCommit[];
  error?: string;
}

/** Clickable endpoint chip: territory-colored dot + file name, full path on
    hover, opens the file in the editor. */
function FileChip({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  return (
    <button
      className="flex min-w-0 items-center gap-1.5 rounded border border-white/8 bg-white/[0.04] px-1.5 py-0.5 hover:bg-white/[0.1]"
      onClick={() => onOpen(path)}
      title={`Open ${path}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(dir)) }} aria-hidden />
      <span className="truncate font-mono text-sm text-foreground">{baseName(path)}</span>
      <span className="max-w-[220px] truncate font-mono text-2xs text-muted-foreground">{dir === "." ? "" : dir}</span>
    </button>
  );
}

function GitHistoryDrawer({ path, history, onLoad, onOpenDiff }: {
  path: string;
  history: FileHistoryState | undefined;
  onLoad: (path: string) => void;
  onOpenDiff: (path: string, commit: NoteFileCommit) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !history) onLoad(path);
  };
  return (
    <div className="mt-1.5">
      <button
        className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="text-xs">{open ? "▾" : "▸"}</span>
        Git history · {baseName(path)}
        {history?.loading && <span className="notes-pulse-dot" aria-hidden />}
      </button>
      {open && history && !history.loading && (
        <div className="mt-1 flex flex-col gap-px border-l border-white/10 pl-2.5">
          {history.error && <div className="py-0.5 text-xs text-amber-200/75">{history.error}</div>}
          {!history.error && history.commits.length === 0 && (
            <div className="py-0.5 text-xs text-muted-foreground">No commits touch this file yet.</div>
          )}
          {history.commits.map((commit) => (
            <button
              key={commit.hash}
              className="group flex items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-white/[0.07]"
              onClick={() => onOpenDiff(path, commit)}
              title={`Open the diff for ${commit.hash.slice(0, 7)} — ${commit.subject}`}
            >
              <span className="shrink-0 font-mono text-2xs text-cyan-200/75">{commit.hash.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground/90 group-hover:text-foreground">{commit.subject}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">{commit.author} · {relativeTime(commit.at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NoteCard({ note, history, onLoadHistory, onOpenDiff }: {
  note: GraphAnnotation;
  history: Record<string, FileHistoryState>;
  onLoadHistory: (path: string) => void;
  onOpenDiff: (path: string, commit: NoteFileCommit) => void;
}) {
  const [showRevisions, setShowRevisions] = useState(false);
  const relation = isRelationNote(note);
  const revised = note.history?.length ?? 0;
  const accent = cssColor(folderColor(note.from.includes("/") ? note.from.slice(0, note.from.lastIndexOf("/")) : "."));
  const openFile = (path: string) => send({ type: "open_file", path });
  return (
    <article className="notes-card" style={{ borderLeftColor: `${accent}66` }}>
      <div className="flex items-center gap-2">
        <span className={`notes-scope-badge ${relation ? "notes-scope-badge-relation" : ""}`}>
          {relation ? "Relation" : "File note"}
        </span>
        <span className="text-2xs text-muted-foreground" title={new Date(note.updatedAt).toLocaleString()}>
          {relativeTime(note.updatedAt)}
        </span>
        {revised > 0 && (
          <button
            className="text-2xs text-amber-200/80 hover:text-amber-100"
            onClick={() => setShowRevisions((s) => !s)}
            aria-expanded={showRevisions}
            title="This note was refined across sessions — click to read the prior versions"
          >
            revised {revised + 1}× {showRevisions ? "▾" : "▸"}
          </button>
        )}
        <span className="ml-auto flex shrink-0 gap-1">
          <button
            className="rounded bg-white/5 px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-white/15 hover:text-foreground"
            onClick={() => send({ type: "reveal_on_map", path: note.from })}
            title="Fly the Map camera to this file's star"
          >
            Show on map
          </button>
          <button
            className="rounded bg-white/5 px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-red-400/20 hover:text-red-200"
            onClick={() => send({ type: "remove_note", id: note.id })}
            title="Delete this note"
          >
            Remove
          </button>
        </span>
      </div>
      <p className="mt-1.5 text-base leading-relaxed text-foreground">{note.note}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <FileChip path={note.from} onOpen={openFile} />
        {relation && note.to && (
          <>
            <span className="text-xs text-muted-foreground" aria-hidden>→</span>
            <FileChip path={note.to} onOpen={openFile} />
          </>
        )}
        <span className="ml-auto text-2xs text-muted-foreground">
          {note.author === "agent" ? "left by the agent" : "left by you"}
          {note.sessionId ? ` · session ${note.sessionId.slice(0, 8)}` : ""}
        </span>
      </div>
      {showRevisions && revised > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-l border-amber-200/25 pl-2.5">
          {note.history!.map((revision, index) => (
            <div key={`${revision.updatedAt}-${index}`} className="text-xs text-muted-foreground">
              <span className="text-2xs text-amber-200/70" title={new Date(revision.updatedAt).toLocaleString()}>
                {relativeTime(revision.updatedAt)}
              </span>
              <div className="mt-0.5">{revision.note}</div>
            </div>
          ))}
        </div>
      )}
      <GitHistoryDrawer path={note.from} history={history[note.from]} onLoad={onLoadHistory} onOpenDiff={onOpenDiff} />
      {relation && note.to && (
        <GitHistoryDrawer path={note.to} history={history[note.to]} onLoad={onLoadHistory} onOpenDiff={onOpenDiff} />
      )}
    </article>
  );
}

const SCOPE_FILTERS: Array<{ value: NoteScopeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "file", label: "File notes" },
  { value: "relation", label: "Relations" },
];

export function NotesApp() {
  const [notes, setNotes] = useState<GraphAnnotation[]>([]);
  const [workspaceName, setWorkspaceName] = useState("workspace");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<NoteScopeFilter>("all");
  const [history, setHistory] = useState<Record<string, FileHistoryState>>({});

  useEffect(() => {
    const off = onMessage((msg) => {
      if (!isNotesHostMessage(msg)) return;
      if (msg.type === "notes_state") {
        setNotes(msg.notes);
        setWorkspaceName(msg.workspaceName || "workspace");
      } else if (msg.type === "file_history") {
        setHistory((current) => ({
          ...current,
          [msg.path]: { loading: false, commits: msg.commits, ...(msg.error ? { error: msg.error } : {}) },
        }));
      }
    });
    send({ type: "ready" });
    return off;
  }, []);

  const loadHistory = (path: string) => {
    setHistory((current) => current[path]?.loading ? current : { ...current, [path]: { loading: true, commits: [] } });
    send({ type: "file_history", path });
  };
  const openDiff = (path: string, commit: NoteFileCommit) =>
    send({ type: "open_commit_diff", path, hash: commit.hash, subject: commit.subject });

  const filtered = useMemo(() => filterNotes(notes, scope, query), [notes, scope, query]);
  const groups = useMemo(() => groupNotesByDay(filtered), [filtered]);
  const relationCount = useMemo(() => notes.filter((note) => isRelationNote(note)).length, [notes]);

  return (
    <div className="notes-root h-screen w-full overflow-y-auto text-foreground">
      <div className="mx-auto flex w-full max-w-[760px] flex-col px-5 pb-16 pt-6">
        <header className="notes-header sticky top-0 z-10 -mx-5 px-5 pb-3 pt-1">
          <div className="map-eyebrow">Project Relay · Working memory</div>
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-xl font-semibold text-foreground">Map notes — {workspaceName}</h1>
            <span className="shrink-0 text-xs text-muted-foreground">
              {notes.length.toLocaleString()} note{notes.length === 1 ? "" : "s"} · {relationCount.toLocaleString()} relation{relationCount === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Durable knowledge the agent (and you) attached to files and relations while working — refined across
            sessions, kept in <span className="font-mono">.blacksite/graph.json</span>, and shown on the Map as gold marks.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes, files, relations…"
              spellCheck={false}
              className="map-search-input flex-1"
              aria-label="Search notes"
            />
            <div className="flex shrink-0 gap-1" role="group" aria-label="Filter by note scope">
              {SCOPE_FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  className={`map-tool-button ${scope === value ? "map-tool-button-active" : ""}`}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </header>

        {notes.length === 0 && (
          <div className="mt-14 flex flex-col items-center gap-2 text-center">
            <span className="text-lg font-semibold text-foreground">No map notes yet</span>
            <p className="max-w-[420px] text-sm leading-relaxed text-muted-foreground">
              As the agent works in this project it records what it learns — a file&apos;s role, a gotcha, a
              non-import relationship — as notes pinned to the Codebase Map. They accumulate here as a timeline
              you can scroll, search, and audit.
            </p>
          </div>
        )}
        {notes.length > 0 && filtered.length === 0 && (
          <div className="mt-10 text-center text-sm text-muted-foreground">No notes match the current filter.</div>
        )}

        {groups.map((group) => (
          <section key={group.key} className="mt-5">
            <div className="notes-day-header">
              <span>{group.label}</span>
              <span className="text-2xs text-muted-foreground">{group.notes.length} note{group.notes.length === 1 ? "" : "s"}</span>
            </div>
            <div className="notes-rail mt-2 flex flex-col gap-2.5">
              {group.notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  history={history}
                  onLoadHistory={loadHistory}
                  onOpenDiff={openDiff}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
