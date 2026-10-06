/* One inspector for whatever is selected on the Map — a file, a folded area,
   a codebase/project/root group, a service, or a ticket — under one header
   (kind, name, where it lives, close) with tabs that pull the newer surfaces
   into the same place:

     Overview    the body for that kind of node (cards.tsx)
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
import { FILE_ROLE_COLORS, FILE_ROLE_LABELS, fileRole } from "@/lib/graph/file-role";
import { RELATIONSHIP_EDGE_COLORS, TICKET_STATUS_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import {
  annotationsForNode,
  baseName,
  groupIndexFor,
  isClusterNode,
  shortClusterLabel,
  type GraphViewState,
} from "@/lib/graph/view-model";
import { groupChain, isHierarchyGroupId } from "@/lib/graph/scope";
import type { GraphAnnotation, GraphEdge, GraphNode, MapGroup, MapGroupEdge } from "@/lib/graph/protocol";
import { X } from "lucide-react";
import { ClusterCard, NodeCard, ServiceCard, TicketCard, fileArchitectureRole } from "./cards";
import { commitAge } from "./shared";
import { MapButton, MapIconButton, MapSection, MapStat } from "./ui";

type Tab = "overview" | "relations" | "work" | "activity" | "notes" | "references";
const TABS: Array<{ tab: Tab; label: string; title: string }> = [
  { tab: "overview", label: "Overview", title: "What this is and how it connects" },
  { tab: "relations", label: "Relations", title: "Every relationship, grouped by kind" },
  { tab: "work", label: "Work", title: "Open tickets covering this" },
  { tab: "activity", label: "Activity", title: "Chat requests and Execution Runs that touched this" },
  { tab: "notes", label: "Notes", title: "Map notes on or inside this" },
  { tab: "references", label: "Refs", title: "Attached documents that mention this" },
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

/** Body for a folded codebase / project / root group. */
export function GroupCard({ node, group, view }: { node: GraphNode; group: MapGroup; view: GraphViewState }) {
  const drawn = group.renderedCount;
  return (
    <div className="map-inspector-content">
      <div className="map-stat-strip">
        <MapStat value={group.fileCount.toLocaleString()} label={drawn < group.fileCount ? `files · ${drawn.toLocaleString()} drawn` : "files"} title={drawn < group.fileCount ? "Scope in to draw the rest" : "Every file is drawn"} />
        <MapStat value={(node.inDegree + node.outDegree).toLocaleString()} label="Links" title="Links to other groups in view" />
        <MapStat value={group.churn.toLocaleString()} label={commitAge(group.lastCommitAt) ? `commits · ${commitAge(group.lastCommitAt)}` : "commits"} title="Recent commits touching this group" />
      </div>
      {group.langs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {group.langs.map(([lang, count]) => (
            <span key={lang} className="map-service-evidence">{lang} · {count.toLocaleString()}</span>
          ))}
        </div>
      )}
      {view.scope.length === 0 && view.scopeMode === "systems" && (
        <div className="map-hint">Systems view: one node per codebase; lines are imports, routes, declared dependencies, and hidden coupling between them.</div>
      )}
      <div className="map-inspector-actions">
        <MapButton variant="primary" onClick={() => actions.enterGroup(group.id)} title="Scope the map to this group">
          Open {group.level === "root" ? "folder" : group.level}
        </MapButton>
        <span className="map-hint">or double-click the star</span>
      </div>
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
        {groupEdges.length === 0 && <div className="map-hint">No relationships to other groups at this level.</div>}
        {[...byKind.entries()].map(([kind, edges]) => (
          <MapSection key={kind} title={<span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: kindColor(kind) }} aria-hidden />{KIND_LABEL[kind] ?? kind} · {edges.length}</span>}>
            <div className="flex flex-col">
              {edges.sort((a, b) => b.count - a.count).slice(0, 12).map((edge) => {
                const out = edge.from === node.id;
                const peer = out ? edge.to : edge.from;
                return (
                  <button key={edge.id} type="button" className="map-inspector-row" onClick={() => actions.select(peer)} title={edge.evidence?.join("\n")}>
                    <span className={`w-3 shrink-0 text-center font-mono text-2xs ${out ? "map-dir-out" : "map-dir-in"}`}>{out ? "→" : "←"}</span>
                    <span className="min-w-0 flex-1 truncate">{label(peer)}</span>
                    {edge.unexplained && <span className="map-inspector-flag" title="Changes together, but no import, route, or declared dependency connects them">hidden coupling</span>}
                    <span className="shrink-0 font-mono text-2xs text-[color:var(--map-text-3)]">{edge.count.toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          </MapSection>
        ))}
        {findings.length > 0 && (
          <div className="map-callout map-callout-warn">
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
      {fileRows.length === 0 && <div className="map-hint">No relationships in the drawn map.</div>}
      {crossCount > 0 && <div className="map-hint">{crossCount} cross-codebase link{crossCount === 1 ? "" : "s"}</div>}
      {[...byKind.entries()].map(([kind, rows]) => (
        <MapSection key={kind} title={<span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: kindColor(kind) }} aria-hidden />{KIND_LABEL[kind] ?? kind} · {rows.length}</span>}>
          <div className="flex flex-col">
            {rows.slice(0, 14).map((row) => (
              <button key={row.key} type="button" className="map-inspector-row" onClick={() => actions.select(row.peer)} title={`${row.peer}${row.detail ? `\n${row.detail}` : ""}`}>
                <span className={`w-3 shrink-0 text-center font-mono text-2xs ${row.direction === "out" ? "map-dir-out" : "map-dir-in"}`}>{row.direction === "out" ? "→" : "←"}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{baseName(row.peer)}</span>
                {row.cross && <span className="map-inspector-flag" title="The peer is in another codebase">cross-codebase</span>}
              </button>
            ))}
            {rows.length > 14 && <div className="map-hint px-1">+{rows.length - 14} more</div>}
          </div>
        </MapSection>
      ))}
    </div>
  );
}

function WorkTab({ view, node, members }: { view: GraphViewState; node: GraphNode; members: ReadonlySet<string> }) {
  const tickets = view.tickets.filter((ticket) => ticket.files.some((file) => members.has(file)));
  const group = groupIndexFor(view.hierarchy).byId.get(node.id);
  return (
    <div className="map-inspector-content">
      {tickets.length === 0 && <div className="map-hint">No open tickets cover this {group ? group.level : "file"}.</div>}
      {tickets.length > 0 && (
        <div className="flex flex-col gap-2">
          {tickets.map((ticket) => (
            <div key={ticket.id} className="map-inspector-item">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-[color:var(--map-text)]">{ticket.title}</span>
                <span className="shrink-0 text-2xs text-[color:var(--map-text-3)]">{ticket.priority}</span>
              </div>
              <div className="text-2xs text-[color:var(--map-text-3)]">{ticket.id} · {ticket.status.replace(/_/g, " ")} · {ticket.files.filter((f) => members.has(f)).length} file(s) here</div>
            </div>
          ))}
        </div>
      )}
      <div className="map-inspector-actions">
        <MapButton
          size="xs"
          onClick={() => (group
            ? actions.fileTicketForArea(`Work in ${group.label}`, [group.key === "." ? "" : group.key].filter(Boolean))
            : actions.fileTicketForArea(`Work in ${baseName(node.id)}`, [], [node.id]))}
          title="File a ticket whose territory is this selection"
        >
          File a ticket here
        </MapButton>
        {tickets.length > 0 && <MapButton size="xs" variant="ghost" onClick={() => actions.openTickets()}>Open Tickets</MapButton>}
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
        <div className="map-callout map-callout-live flex items-center gap-2">
          <span className="map-live-pip" aria-hidden />
          The agent is {live[0]!.kind === "read" ? "reading" : "working on"} {baseName(live[0]!.path)}{live.length > 1 ? ` and ${live.length - 1} more` : ""} now.
        </div>
      )}
      {changes.length > 0 && (
        <MapSection title="Changed in chat">
          {changes.map((change) => (
            <div key={`${change.path}:${change.at}:${change.sessionId}`} className="map-inspector-item">
              <div className="truncate text-xs text-[color:var(--map-text)]" title={change.request}>{change.request || "Untitled request"}</div>
              <div className="text-2xs text-[color:var(--map-text-3)]">
                {relativeTime(new Date(change.at).toISOString())} · {baseName(change.path)} · <span className="text-[color:var(--s-ok)]">+{change.additions}</span> <span className="text-[color:var(--s-err)]">−{change.deletions}</span>
              </div>
            </div>
          ))}
        </MapSection>
      )}
      <MapSection title="Execution Runs">
        {runs === null && <div className="map-hint">Looking up Execution Runs…</div>}
        {runs !== null && runs.length === 0 && <div className="map-hint">No retained Execution Run touched this.</div>}
        {runs?.map((run) => (
          <div key={run.runId} className="map-inspector-item">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-[color:var(--map-text)]">{run.title}</span>
              <span className="shrink-0 text-2xs text-[color:var(--map-text-3)]">{run.status.replace(/_/g, " ")}</span>
            </div>
            <div className="text-2xs text-[color:var(--map-text-3)]">
              {relativeTime(run.startedAt)} · {run.files.length} file{run.files.length === 1 ? "" : "s"} · {run.events} event{run.events === 1 ? "" : "s"}
            </div>
            <div className="truncate font-mono text-2xs text-[color:var(--map-text-3)]">{run.files.slice(0, 3).map((file) => baseName(file.path)).join("  ·  ")}</div>
            <div className="flex gap-3">
              <button type="button" className="map-text-link" onClick={() => { actions.selectRun(run.runId); actions.seekRun(run.firstAt); }} title="Play this run's activity back on the map">Replay on map</button>
              <button type="button" className="map-text-link" onClick={() => actions.openRun(run.runId)}>Open run</button>
            </div>
          </div>
        ))}
      </MapSection>
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
      {notes.length === 0 && <div className="map-hint">No map notes here yet.</div>}
      {notes.length > 0 && (
        <div className="flex flex-col gap-2">
          {notes.slice(0, 20).map((note) => (
            <div key={note.id} className="map-inspector-item">
              <div className="flex items-center justify-between gap-2 text-2xs text-[color:var(--map-text-3)]">
                <span className="truncate font-mono">{baseName(note.from)}{note.to ? ` → ${baseName(note.to)}` : ""}</span>
                {note.category && <span>{note.category}</span>}
              </div>
              {note.title && <div className="text-xs font-semibold text-[color:var(--map-text)]">{note.title}</div>}
              <div className="text-xs leading-relaxed text-[color:var(--map-text-2)]">{note.note}</div>
            </div>
          ))}
        </div>
      )}
      <div className="map-inspector-actions">
        <MapButton size="xs" onClick={() => actions.openNotesTimeline(prefix && prefix !== "." ? { prefix, label: group?.label ?? baseName(prefix) } : undefined)}>
          Open in timeline
        </MapButton>
      </div>
    </div>
  );
}

function ReferencesTab({ view }: { view: GraphViewState }) {
  const refs = view.context?.references ?? null;
  return (
    <div className="map-inspector-content">
      {refs === null && <div className="map-hint">Looking up attached references…</div>}
      {refs !== null && refs.length === 0 && (
        <div className="map-hint">No attached document names this. Attachments link to code through file paths, unambiguous file names, and API routes they mention.</div>
      )}
      {refs?.map((ref) => (
        <div key={ref.id} className="map-inspector-item">
          <button type="button" className="truncate text-left text-xs font-medium text-[color:var(--map-text)] hover:underline" onClick={() => actions.openFile(ref.openPath ?? ref.workspacePath)} title={ref.workspacePath}>
            {ref.kind === "context" ? "Extracted context" : ref.name}
          </button>
          <div className="text-2xs text-[color:var(--map-text-3)]">conversation {ref.session.slice(0, 8)} · {ref.targets.length} match{ref.targets.length === 1 ? "" : "es"}</div>
          {ref.targets.slice(0, 3).map((target) => (
            <div key={target.path} className="truncate font-mono text-2xs text-[color:var(--map-text-3)]" title={`${target.via}: ${target.evidence}`}>
              {target.via} · {target.evidence}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Kind, swatch, name, and location for the header — one place, every kind. */
function headerFor(node: GraphNode, group: MapGroup | undefined): { kind: string; name: string; path: string; swatch: string; shape: "dot" | "square" | "diamond"; badge?: { label: string; color: string } } {
  if (node.kind === "ticket") {
    const status = node.ticketStatus ?? "backlog";
    return { kind: `Ticket · ${status.replace(/_/g, " ")}`, name: node.ticketTitle ?? node.id, path: node.ticketId ?? "", swatch: cssColor(TICKET_STATUS_COLORS[status]), shape: "dot" };
  }
  if (node.kind === "service") {
    return { kind: "Service", name: node.dir.replace(/^svc:/, ""), path: node.dir.replace(/^svc:/, ""), swatch: cssColor(folderColor(node.dir)), shape: "diamond" };
  }
  if (group && group.level !== "area") {
    const level = group.level === "root" ? "Workspace folder" : group.level === "codebase" ? "Codebase" : "Project";
    return { kind: `${level}${group.projectKind ? ` · ${group.projectKind}` : ""}`, name: group.label, path: group.key === "." ? "(top-level files)" : group.key, swatch: cssColor(folderColor(group.key)), shape: "square" };
  }
  if (isClusterNode(node)) {
    return { kind: "Folded folder", name: shortClusterLabel(node.dir), path: node.dir, swatch: cssColor(folderColor(node.dir)), shape: "square" };
  }
  const role = fileRole(node.id);
  return {
    kind: fileArchitectureRole(node),
    name: baseName(node.id),
    path: node.dir === "." ? "(workspace root)" : node.id.slice(0, Math.max(0, node.id.length - baseName(node.id).length - 1)),
    swatch: cssColor(folderColor(node.dir)),
    shape: "dot",
    ...(role !== "source" ? { badge: { label: FILE_ROLE_LABELS[role], color: cssColor(FILE_ROLE_COLORS[role]) } } : {}),
  };
}

export function Inspector({ view, node, onFocus }: { view: GraphViewState; node: GraphNode; onFocus: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const panelRef = useRef<HTMLDivElement>(null);
  const members = useMemberIds(view, node);
  const index = groupIndexFor(view.hierarchy);
  const group = isClusterNode(node) ? index.byId.get(node.id) : undefined;
  const tabbed = node.kind !== "ticket" && node.kind !== "service";
  const header = headerFor(node, group);

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

  const noteCount = useMemo(
    () => (group || isClusterNode(node)
      ? view.annotations.filter((note) => members.has(note.from) || (note.to !== undefined && members.has(note.to))).length
      : annotationsForNode(node.id, view.annotations).length),
    [group, node, view.annotations, members],
  );
  const ticketCount = useMemo(() => view.tickets.filter((ticket) => ticket.files.some((file) => members.has(file))).length, [view.tickets, members]);
  const counts: Partial<Record<Tab, number>> = { work: ticketCount, notes: noteCount };

  const active = tabbed ? tab : "overview";
  const swatchClass = header.shape === "square" ? "rounded-[2px]" : header.shape === "diamond" ? "rotate-45 rounded-[1px]" : "rounded-full";
  return (
    <div
      ref={panelRef}
      className="map-panel map-card map-selection-panel map-inspector pointer-events-auto absolute bottom-3 left-3 w-[min(340px,calc(100%-24px))]"
      data-map-region="inspector"
    >
      <div className="map-inspector-head">
        <div className="map-inspector-titles">
          <div className="map-inspector-kind">
            <span className={`h-2 w-2 shrink-0 ${swatchClass}`} style={{ background: header.swatch }} aria-hidden />
            <span className="truncate">{header.kind}</span>
            {header.badge && (
              <span className="ml-auto shrink-0 rounded-full border px-1.5 text-2xs font-semibold" style={{ color: header.badge.color, borderColor: `color-mix(in srgb, ${header.badge.color} 40%, transparent)` }}>
                {header.badge.label}
              </span>
            )}
          </div>
          <div className="map-inspector-name" title={node.id}>{header.name}</div>
          {header.path && <div className="map-inspector-path" title={header.path}><bdi>{header.path}</bdi></div>}
        </div>
        <MapIconButton icon={X} label="Close (Esc)" onClick={() => actions.select(null)} />
      </div>
      {tabbed && (
        <div className="map-inspector-tabs" role="tablist" aria-label="Inspector">
          {TABS.map(({ tab: value, label, title }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active === value}
              className={`map-inspector-tab ${active === value ? "map-inspector-tab-active" : ""}`}
              onClick={() => setTab(value)}
              title={title}
            >
              {label}
              {counts[value] ? <span className="map-inspector-tab-count">{counts[value]}</span> : null}
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
