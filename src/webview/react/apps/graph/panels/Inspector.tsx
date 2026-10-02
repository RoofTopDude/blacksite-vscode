/* One inspector for whatever is selected on the Map — a file, a folded area,
   a codebase/project/root group, a service, or a ticket — with tabs that pull
   the newer surfaces into the same place:

     Overview    the existing card for that kind of node
     Relations   grouped by kind and by counterpart codebase, with provenance
     Work        open tickets covering it; file a new one for it
     Activity    Chat requests that changed it, and Execution Runs that touched it (replay on the map)
     Notes       map notes on it (or inside it); open them in the timeline
     References  attached documents that name it

   Runs and references are host data fetched per selection (request_context);
   everything else is already in the view. The panel publishes its height as
   --map-inspector-height so the outline above it shrinks instead of
   overlapping. */

import { useEffect, useMemo, useRef, useState } from "react";
import { actions } from "../store";
import { RELATIONSHIP_EDGE_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import {
  annotationsForNode,
  baseName,
  groupIndexFor,
  isClusterNode,
  type GraphViewState,
} from "@/lib/graph/view-model";
import { groupChain, isHierarchyGroupId } from "@/lib/graph/scope";
import type { GraphAnnotation, GraphEdge, GraphNode, MapGroup, MapGroupEdge } from "@/lib/graph/protocol";
import { ClusterCard, NodeCard, ServiceCard, TicketCard } from "./cards";
import { commitAge } from "./shared";

type Tab = "overview" | "relations" | "work" | "activity" | "notes" | "references";
const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "overview", label: "Overview" },
  { tab: "relations", label: "Relations" },
  { tab: "work", label: "Work" },
  { tab: "activity", label: "Activity" },
  { tab: "notes", label: "Notes" },
  { tab: "references", label: "Refs" },
];

const KIND_LABEL: Record<string, string> = {
  import: "Imports",
  api: "API calls",
  event: "Events",
  data: "Shared data",
  config: "Config",
  cochange: "Changed together",
  project_ref: "Declared dependency",
  call: "Calls",
  reference: "References",
  supertype: "Inherits",
};

function kindColor(kind: string): string {
  return cssColor(RELATIONSHIP_EDGE_COLORS[kind as GraphEdge["kind"]] ?? 0x8fa9d6);
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Files (by id) the selection stands for: the file itself, or every drawn
    file whose group chain includes the selected group. */
function useMemberIds(view: GraphViewState, node: GraphNode): Set<string> {
  return useMemo(() => {
    if (!isClusterNode(node)) return new Set([node.id]);
    const index = groupIndexFor(view.hierarchy);
    const out = new Set<string>();
    for (const file of view.nodes) {
      if (file.kind && file.kind !== "file") continue;
      if (groupChain(file, index).includes(node.id) || (!index.byId.has(node.id) && `▤${file.dir}` === node.id)) out.add(file.id);
    }
    return out;
  }, [view.hierarchy, view.nodes, node]);
}

/** Card for a folded codebase / project / root group. */
export function GroupCard({ node, group, view }: { node: GraphNode; group: MapGroup; view: GraphViewState }) {
  const levelLabel = group.level === "root" ? "Workspace folder" : group.level === "codebase" ? "Codebase" : "Project";
  const drawn = group.renderedCount;
  return (
    <div className="map-inspector-content">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: cssColor(folderColor(group.key)) }} aria-hidden />
        {levelLabel}{group.projectKind ? ` · ${group.projectKind}` : ""}
      </div>
      <div className="text-base font-semibold text-foreground">{group.label}</div>
      <div className="break-all font-mono text-2xs text-muted-foreground">{group.key === "." ? "(top-level files)" : group.key}</div>
      <div className="map-relationship-summary">
        <div>
          <span>Files</span>
          <strong>{group.fileCount.toLocaleString()}</strong>
          <small>{drawn < group.fileCount ? `${drawn.toLocaleString()} drawn` : "all drawn"}</small>
        </div>
        <div>
          <span>Links</span>
          <strong>{(node.inDegree + node.outDegree).toLocaleString()}</strong>
          <small>to groups in view</small>
        </div>
        <div>
          <span>Churn</span>
          <strong>{group.churn.toLocaleString()}</strong>
          <small>{commitAge(group.lastCommitAt) ? `last ${commitAge(group.lastCommitAt)}` : "commits"}</small>
        </div>
      </div>
      {group.langs.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {group.langs.map(([lang, count]) => (
            <span key={lang} className="map-service-evidence">{lang} · {count.toLocaleString()}</span>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20" onClick={() => actions.enterGroup(group.id)}>
          Open {group.level === "root" ? "folder" : group.level}
        </button>
        <button className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15" onClick={() => actions.select(null)}>
          Dismiss
        </button>
      </div>
      <div className="mt-1.5 text-2xs text-muted-foreground">Double-click the star to step inside.</div>
      {view.scope.length === 0 && view.scopeMode === "systems" && (
        <div className="mt-1 text-2xs text-muted-foreground">Systems view: each codebase is one node; lines are imports, routes, declared dependencies, and hidden coupling between them.</div>
      )}
    </div>
  );
}

function RelationsTab({ view, node, members }: { view: GraphViewState; node: GraphNode; members: ReadonlySet<string> }) {
  const index = groupIndexFor(view.hierarchy);
  const isGroup = isHierarchyGroupId(node.id) && index.byId.has(node.id);
  /* Codebases and folders relate at the Systems level; projects to projects. */
  const edgeLevel = index.byId.get(node.id)?.level === "project" ? "project" : "systems";
  const groupEdges = useMemo(
    () => (isGroup ? (view.hierarchy?.edges ?? []).filter((edge) => edge.level === edgeLevel && (edge.from === node.id || edge.to === node.id)) : []),
    [isGroup, view.hierarchy, node.id, edgeLevel],
  );
  const fileRows = useMemo(() => {
    if (isGroup) return [];
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const codebaseOf = (id: string): string => byId.get(id)?.codebase ?? byId.get(id)?.neighborhood ?? "";
    const own = codebaseOf(node.id);
    const rows: Array<{ key: string; kind: string; direction: "out" | "in"; peer: string; cross: boolean; detail?: string }> = [];
    const push = (edge: GraphEdge, detail?: string): void => {
      const out = members.has(edge.from);
      const peer = out ? edge.to : edge.from;
      if (members.has(peer)) return;
      rows.push({ key: `${edge.id}:${out}`, kind: edge.kind, direction: out ? "out" : "in", peer, cross: Boolean(own) && codebaseOf(peer) !== own, detail });
    };
    for (const edge of view.edges) if (members.has(edge.from) || members.has(edge.to)) push(edge);
    for (const edge of view.cochangeEdges) if (members.has(edge.from) || members.has(edge.to)) push(edge, edge.label);
    for (const edge of view.relationshipEdges) {
      const source = edge.sourcePath;
      const target = edge.targetPath;
      if (!source || !target || (!members.has(source) && !members.has(target))) continue;
      push({ ...edge, from: source, to: target }, edge.label);
    }
    return rows;
  }, [isGroup, view.edges, view.cochangeEdges, view.relationshipEdges, view.nodes, node.id, members]);

  if (isGroup) {
    const label = (id: string): string => index.byId.get(id)?.label ?? id.slice(1);
    const byKind = new Map<string, MapGroupEdge[]>();
    for (const edge of groupEdges) byKind.set(edge.kind, [...(byKind.get(edge.kind) ?? []), edge]);
    const findings = [
      ...(view.hierarchy?.usedUndeclared ?? []).filter((f) => `▣${f.fromProject}` === node.id || `▣${f.toProject}` === node.id).map((f) => `${f.fromName} imports ${f.toName} ${f.imports}× with no declared dependency`),
      ...(view.hierarchy?.declaredUnused ?? []).filter((f) => `▣${f.fromProject}` === node.id).map((f) => `${f.fromName} declares ${f.toName} but never imports it`),
    ];
    return (
      <div className="map-inspector-content">
        {groupEdges.length === 0 && <div className="text-xs text-muted-foreground">No relationships to other groups at this level.</div>}
        {[...byKind.entries()].map(([kind, edges]) => (
          <div key={kind} className="mt-1.5">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-300/80">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: kindColor(kind) }} aria-hidden />
              {KIND_LABEL[kind] ?? kind}
            </div>
            {edges.sort((a, b) => b.count - a.count).slice(0, 12).map((edge) => {
              const out = edge.from === node.id;
              const peer = out ? edge.to : edge.from;
              return (
                <button key={edge.id} className="map-inspector-row" onClick={() => actions.select(peer)} title={edge.evidence?.join("\n")}>
                  <span className={`w-3 shrink-0 text-center font-mono text-2xs ${out ? "text-cyan-200/80" : "text-amber-200/80"}`}>{out ? "→" : "←"}</span>
                  <span className="min-w-0 flex-1 truncate">{label(peer)}</span>
                  {edge.unexplained && <span className="map-inspector-flag" title="Changes together, but no import, route, or declared dependency connects them">hidden coupling</span>}
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">{edge.count.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        ))}
        {findings.length > 0 && (
          <div className="mt-2 rounded border border-amber-400/20 bg-amber-950/30 px-2 py-1 text-xs text-amber-100/85">
            {findings.map((finding) => <div key={finding}>{finding}</div>)}
          </div>
        )}
      </div>
    );
  }

  const byKind = new Map<string, typeof fileRows>();
  for (const row of fileRows) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
  const crossCount = fileRows.filter((row) => row.cross).length;
  return (
    <div className="map-inspector-content">
      {fileRows.length === 0 && <div className="text-xs text-muted-foreground">No relationships in the drawn map.</div>}
      {crossCount > 0 && <div className="text-2xs text-muted-foreground">{crossCount} cross-codebase link{crossCount === 1 ? "" : "s"}</div>}
      {[...byKind.entries()].map(([kind, rows]) => (
        <div key={kind} className="mt-1.5">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-300/80">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: kindColor(kind) }} aria-hidden />
            {KIND_LABEL[kind] ?? kind} · {rows.length}
          </div>
          {rows.slice(0, 14).map((row) => (
            <button key={row.key} className="map-inspector-row" onClick={() => actions.select(row.peer)} title={`${row.peer}${row.detail ? `\n${row.detail}` : ""}`}>
              <span className={`w-3 shrink-0 text-center font-mono text-2xs ${row.direction === "out" ? "text-cyan-200/80" : "text-amber-200/80"}`}>{row.direction === "out" ? "→" : "←"}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{baseName(row.peer)}</span>
              {row.cross && <span className="map-inspector-flag" title="The peer is in another codebase">cross-codebase</span>}
            </button>
          ))}
          {rows.length > 14 && <div className="px-1 text-2xs text-muted-foreground">+{rows.length - 14} more</div>}
        </div>
      ))}
    </div>
  );
}

function WorkTab({ view, node, members }: { view: GraphViewState; node: GraphNode; members: ReadonlySet<string> }) {
  const tickets = view.tickets.filter((ticket) => ticket.files.some((file) => members.has(file)));
  const group = groupIndexFor(view.hierarchy).byId.get(node.id);
  return (
    <div className="map-inspector-content">
      {tickets.length === 0 && <div className="text-xs text-muted-foreground">No open tickets cover this {group ? group.level : "file"}.</div>}
      {tickets.map((ticket) => (
        <div key={ticket.id} className="map-inspector-item">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-foreground">{ticket.title}</span>
            <span className="shrink-0 text-2xs uppercase text-muted-foreground">{ticket.priority}</span>
          </div>
          <div className="text-2xs text-muted-foreground">{ticket.id} · {ticket.status.replace(/_/g, " ")} · {ticket.files.filter((f) => members.has(f)).length} file(s) here</div>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
          onClick={() => (group
            ? actions.fileTicketForArea(`Work in ${group.label}`, [group.key === "." ? "" : group.key].filter(Boolean))
            : actions.fileTicketForArea(`Work in ${baseName(node.id)}`, [], [node.id]))}
          title="File a ticket whose territory is this selection"
        >
          File a ticket here
        </button>
        {tickets.length > 0 && (
          <button className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15" onClick={() => actions.openTickets()}>Open tickets</button>
        )}
      </div>
    </div>
  );
}

function ActivityTab({ view, members }: { view: GraphViewState; members: ReadonlySet<string> }) {
  const live = view.liveActivity.filter((activity) => members.has(activity.path));
  const runs = view.context?.runs ?? null;
  const changes = view.context?.changes ?? [];
  return (
    <div className="map-inspector-content">
      {live.length > 0 && (
        <div className="mb-1.5 rounded border border-cyan-300/20 bg-cyan-950/25 px-2 py-1 text-xs text-cyan-100/85">
          The agent is {live[0]!.kind === "read" ? "reading" : "working on"} {baseName(live[0]!.path)}{live.length > 1 ? ` and ${live.length - 1} more` : ""} now.
        </div>
      )}
      {changes.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-2xs uppercase tracking-wide text-muted-foreground">Changed in chat</div>
          {changes.map((change) => (
            <div key={`${change.path}:${change.at}:${change.sessionId}`} className="map-inspector-item">
              <div className="truncate text-sm text-foreground" title={change.request}>{change.request || "Untitled request"}</div>
              <div className="text-2xs text-muted-foreground">
                {relativeTime(new Date(change.at).toISOString())} · {baseName(change.path)} · <span className="text-emerald-300/80">+{change.additions}</span> <span className="text-rose-300/80">−{change.deletions}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {runs === null && <div className="text-xs text-muted-foreground">Looking up Execution Runs…</div>}
      {runs !== null && runs.length === 0 && <div className="text-xs text-muted-foreground">No retained Execution Run touched this.</div>}
      {runs?.map((run) => (
        <div key={run.runId} className="map-inspector-item">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-foreground">{run.title}</span>
            <span className="shrink-0 text-2xs uppercase text-muted-foreground">{run.status.replace(/_/g, " ")}</span>
          </div>
          <div className="text-2xs text-muted-foreground">
            {relativeTime(run.startedAt)} · {run.files.length} file{run.files.length === 1 ? "" : "s"} · {run.events} event{run.events === 1 ? "" : "s"}
          </div>
          <div className="mt-0.5 truncate font-mono text-2xs text-slate-300/70">{run.files.slice(0, 3).map((file) => baseName(file.path)).join("  ·  ")}</div>
          <div className="mt-1 flex gap-2">
            <button className="text-2xs uppercase tracking-wide text-cyan-200/80 hover:text-cyan-100" onClick={() => { actions.selectRun(run.runId); actions.seekRun(run.firstAt); }}>
              Replay on map
            </button>
            <button className="text-2xs uppercase tracking-wide text-slate-300/80 hover:text-foreground" onClick={() => actions.openRun(run.runId)}>
              Open run
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function NotesTab({ view, node, members }: { view: GraphViewState; node: GraphNode; members: ReadonlySet<string> }) {
  const group = groupIndexFor(view.hierarchy).byId.get(node.id);
  const notes: GraphAnnotation[] = group || isClusterNode(node)
    ? view.annotations.filter((note) => members.has(note.from) || (note.to !== undefined && members.has(note.to)))
    : annotationsForNode(node.id, view.annotations);
  const prefix = group ? group.key : isClusterNode(node) ? node.dir : node.id;
  return (
    <div className="map-inspector-content">
      {notes.length === 0 && <div className="text-xs text-muted-foreground">No map notes here yet.</div>}
      {notes.slice(0, 20).map((note) => (
        <div key={note.id} className="map-inspector-item">
          <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
            <span className="truncate font-mono">{baseName(note.from)}{note.to ? ` → ${baseName(note.to)}` : ""}</span>
            {note.category && <span className="uppercase">{note.category}</span>}
          </div>
          {note.title && <div className="text-xs font-semibold text-foreground/90">{note.title}</div>}
          <div className="text-xs text-muted-foreground">{note.note}</div>
        </div>
      ))}
      <div className="mt-2">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
          onClick={() => actions.openNotesTimeline(prefix && prefix !== "." ? { prefix, label: group?.label ?? baseName(prefix) } : undefined)}
        >
          Open in timeline
        </button>
      </div>
    </div>
  );
}

function ReferencesTab({ view }: { view: GraphViewState }) {
  const refs = view.context?.references ?? null;
  return (
    <div className="map-inspector-content">
      {refs === null && <div className="text-xs text-muted-foreground">Looking up attached references…</div>}
      {refs !== null && refs.length === 0 && (
        <div className="text-xs text-muted-foreground">No attached document names this. Attachments link to code through file paths, unambiguous file names, and API routes they mention.</div>
      )}
      {refs?.map((ref) => (
        <div key={ref.id} className="map-inspector-item">
          <button className="truncate text-left text-sm text-foreground hover:underline" onClick={() => actions.openFile(ref.openPath ?? ref.workspacePath)} title={ref.workspacePath}>
            {ref.kind === "context" ? "Extracted context" : ref.name}
          </button>
          <div className="text-2xs text-muted-foreground">conversation {ref.session.slice(0, 8)} · {ref.targets.length} match{ref.targets.length === 1 ? "" : "es"}</div>
          {ref.targets.slice(0, 3).map((target) => (
            <div key={target.path} className="truncate font-mono text-2xs text-slate-300/70" title={`${target.via}: ${target.evidence}`}>
              {target.via === "route" ? "route" : target.via === "path" ? "path" : "name"} · {target.evidence}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Inspector({ view, node, onFocus }: { view: GraphViewState; node: GraphNode; onFocus: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const panelRef = useRef<HTMLDivElement>(null);
  const members = useMemberIds(view, node);
  const index = groupIndexFor(view.hierarchy);
  const group = isClusterNode(node) ? index.byId.get(node.id) : undefined;
  const tabbed = node.kind !== "ticket" && node.kind !== "service";

  useEffect(() => {
    const panel = panelRef.current;
    const host = panel?.parentElement;
    if (!panel || !host) return;
    const publish = (): void => host.style.setProperty("--map-inspector-height", `${panel.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--map-inspector-height");
    };
  }, []);

  const overview = node.kind === "ticket"
    ? <TicketCard node={node} view={view} />
    : node.kind === "service"
      ? <ServiceCard node={node} view={view} />
      : group && group.level !== "area"
        ? <GroupCard node={node} group={group} view={view} />
        : isClusterNode(node)
          ? <ClusterCard node={node} />
          : <NodeCard node={node} onFocus={onFocus} />;

  const active = tabbed ? tab : "overview";
  return (
    <div
      ref={panelRef}
      className="map-panel map-card map-selection-panel map-inspector pointer-events-auto absolute bottom-3 left-3 w-[min(344px,calc(100vw-24px))]"
      data-map-region="inspector"
    >
      {tabbed && (
        <div className="map-inspector-tabs" role="tablist" aria-label="Inspector">
          {TABS.map(({ tab: value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active === value}
              className={`map-inspector-tab ${active === value ? "map-inspector-tab-active" : ""}`}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {active === "overview" && overview}
      {active === "relations" && <RelationsTab view={view} node={node} members={members} />}
      {active === "work" && <WorkTab view={view} node={node} members={members} />}
      {active === "activity" && <ActivityTab view={view} members={members} />}
      {active === "notes" && <NotesTab view={view} node={node} members={members} />}
      {active === "references" && <ReferencesTab view={view} />}
    </div>
  );
}
