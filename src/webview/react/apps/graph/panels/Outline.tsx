/* The Map's outline rail: the workspace hierarchy (root → codebase → project
   → area) as a tree with the host's true file counts and what is happening
   in each part — open tickets, notes, the agent working there right now, and
   recent change heat. Clicking a row scopes the map to it; hovering previews
   it on the canvas. It replaces the flat "Territories" and "Hubs" rail
   sections, which could only list folders in the render sample.

   It publishes its height as --map-outline-height so panels stacked below it
   (the language-server panel) never overlap it. */

import { useEffect, useMemo, useRef, useState } from "react";
import { actions } from "../store";
import { cssColor, folderColor } from "@/lib/graph/colors";
import { baseName, groupIndexFor, topHubs, type GraphViewState } from "@/lib/graph/view-model";
import { ancestorsOf, groupChain } from "@/lib/graph/scope";
import type { MapGroup } from "@/lib/graph/protocol";
import { ChevronDown, ChevronRight, ListTree } from "lucide-react";

const MAX_CHILDREN = 40;

interface Rollup {
  tickets: number;
  notes: number;
  live: number;
}

const LEVEL_LABEL: Record<string, string> = {
  root: "folder",
  codebase: "codebase",
  project: "project",
  area: "area",
};

function useRollups(view: GraphViewState): Map<string, Rollup> {
  return useMemo(() => {
    const index = groupIndexFor(view.hierarchy);
    const out = new Map<string, Rollup>();
    if (index.byId.size === 0) return out;
    const byId = new Map(view.nodes.map((node) => [node.id, node]));
    const chainCache = new Map<string, string[]>();
    const chainOf = (id: string): string[] => {
      const cached = chainCache.get(id);
      if (cached) return cached;
      const node = byId.get(id);
      const chain = node ? groupChain(node, index) : [];
      chainCache.set(id, chain);
      return chain;
    };
    const bump = (id: string, key: keyof Rollup): void => {
      for (const group of chainOf(id)) {
        const entry = out.get(group) ?? { tickets: 0, notes: 0, live: 0 };
        entry[key] += 1;
        out.set(group, entry);
      }
    };
    for (const ticket of view.tickets) {
      /* One ticket counts once per group, however many of its files are there. */
      const groups = new Set(ticket.files.flatMap((file) => chainOf(file)));
      for (const group of groups) {
        const entry = out.get(group) ?? { tickets: 0, notes: 0, live: 0 };
        entry.tickets += 1;
        out.set(group, entry);
      }
    }
    for (const note of view.annotations) bump(note.from, "notes");
    for (const live of view.liveActivity) bump(live.path, "live");
    return out;
  }, [view.hierarchy, view.nodes, view.tickets, view.annotations, view.liveActivity]);
}

function OutlineRow({ group, depth, view, expanded, onToggle, rollups, maxChurn }: {
  group: MapGroup;
  depth: number;
  view: GraphViewState;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  rollups: ReadonlyMap<string, Rollup>;
  maxChurn: number;
}) {
  const index = groupIndexFor(view.hierarchy);
  const children = (index.children.get(group.id) ?? []).slice().sort((a, b) => b.fileCount - a.fileCount || a.label.localeCompare(b.label));
  const open = expanded.has(group.id);
  const inScope = view.scope[view.scope.length - 1] === group.id;
  const onPath = view.scope.includes(group.id);
  const rollup = rollups.get(group.id);
  const heat = maxChurn > 0 ? Math.min(1, Math.log1p(group.churn) / Math.log1p(maxChurn)) : 0;
  const color = cssColor(folderColor(group.level === "area" ? group.key : group.key));
  const displayed = view.displayNodes.some((node) => node.id === group.id);
  /* Preview on the canvas: the folded node itself when it is drawn, else the
     area's stars through the territory-hover seam. Keyboard focus previews too. */
  const preview = (): void => {
    if (displayed) actions.hover(group.id);
    else if (group.level === "area") actions.hoverTerritory(group.key);
  };
  const clearPreview = (): void => {
    actions.hover(null);
    actions.hoverTerritory(null);
  };
  return (
    <li>
      <div
        className={`map-outline-row ${inScope ? "map-outline-row-scope" : onPath ? "map-outline-row-path" : ""}`}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {children.length > 0 ? (
          <button type="button" className="map-outline-twist" onClick={() => onToggle(group.id)} aria-expanded={open} aria-label={open ? `Collapse ${group.label}` : `Expand ${group.label}`}>
            {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
          </button>
        ) : (
          <span className="map-outline-twist" aria-hidden="true" />
        )}
        <button
          type="button"
          className="map-outline-label"
          onClick={() => actions.enterGroup(group.id)}
          onMouseEnter={preview}
          onMouseLeave={clearPreview}
          onFocus={preview}
          onBlur={clearPreview}
          title={`${LEVEL_LABEL[group.level]} · ${group.key}\n${group.fileCount.toLocaleString()} files${group.renderedCount < group.fileCount ? ` (${group.renderedCount.toLocaleString()} drawn until you scope in)` : ""}${group.projectKind ? `\n${group.projectKind} project` : ""}`}
        >
          <span className={`map-outline-swatch map-outline-swatch-${group.level}`} style={{ background: color }} aria-hidden="true" />
          <span className="truncate">{group.label}</span>
        </button>
        <span className="map-outline-badges">
          {rollup?.live ? <span className="map-outline-live" title={`The agent is working on ${rollup.live} file${rollup.live === 1 ? "" : "s"} here`} /> : null}
          {rollup?.tickets ? <span className="map-outline-badge map-outline-badge-ticket" title={`${rollup.tickets} open ticket${rollup.tickets === 1 ? "" : "s"}`}>{rollup.tickets}</span> : null}
          {rollup?.notes ? <span className="map-outline-badge map-outline-badge-note" title={`${rollup.notes} map note${rollup.notes === 1 ? "" : "s"}`}>{rollup.notes}</span> : null}
          <span className="map-outline-count">{group.fileCount.toLocaleString()}</span>
        </span>
        <span className="map-outline-heat" style={{ width: `${Math.round(heat * 100)}%` }} aria-hidden="true" />
      </div>
      {open && children.length > 0 && (
        <ul>
          {children.slice(0, MAX_CHILDREN).map((child) => (
            <OutlineRow key={child.id} group={child} depth={depth + 1} view={view} expanded={expanded} onToggle={onToggle} rollups={rollups} maxChurn={maxChurn} />
          ))}
          {children.length > MAX_CHILDREN && (
            <li className="map-outline-more" style={{ paddingLeft: 20 + depth * 12 }}>+{children.length - MAX_CHILDREN} more — scope in to see them</li>
          )}
        </ul>
      )}
    </li>
  );
}

export function OutlineRail({ view, onFocusNode, defaultOpen }: {
  view: GraphViewState;
  onFocusNode: (id: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? defaultOpen;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rollups = useRollups(view);
  const index = useMemo(() => groupIndexFor(view.hierarchy), [view.hierarchy]);
  const panelRef = useRef<HTMLElement>(null);

  /* Keep the scope's path open so the current location is always visible. */
  const scopeKey = view.scope.join("|");
  useEffect(() => {
    const target = view.scope[view.scope.length - 1];
    if (!target) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of ancestorsOf(target, index)) next.add(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, index]);

  useEffect(() => {
    const panel = panelRef.current;
    const host = panel?.parentElement;
    if (!panel || !host) return;
    const publish = (): void => host.style.setProperty("--map-outline-height", `${panel.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--map-outline-height");
    };
  }, []);

  const top = useMemo(() => (index.children.get(null) ?? []).slice().sort((a, b) => b.fileCount - a.fileCount || a.label.localeCompare(b.label)), [index]);
  const maxChurn = useMemo(() => Math.max(0, ...(view.hierarchy?.groups ?? []).filter((g) => g.level !== "area").map((g) => g.churn)), [view.hierarchy]);
  const hubs = useMemo(() => topHubs(view.displayNodes.filter((node) => !node.kind || node.kind === "file"), 5), [view.displayNodes]);
  const findings = (view.hierarchy?.usedUndeclared.length ?? 0) + (view.hierarchy?.declaredUnused.length ?? 0);

  if (!view.hierarchy || view.display.lens !== "files" || top.length === 0) return null;
  const toggle = (id: string): void => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <section ref={panelRef} className="map-panel map-outline pointer-events-auto absolute left-3" aria-label="Workspace outline" data-map-region="outline" data-open={shown}>
      <button type="button" className="map-outline-header" onClick={() => setOpen(!shown)} aria-expanded={shown}>
        <ListTree size={14} aria-hidden="true" />
        <span className="flex-1 text-left">Outline</span>
        <span className="text-2xs text-muted-foreground">{view.hierarchy.fileCount.toLocaleString()} files</span>
        <ChevronDown size={13} className={shown ? "" : "-rotate-90"} aria-hidden="true" />
      </button>
      {shown && (
        <div className="map-outline-body">
          <ul className="map-outline-tree">
            {top.map((group) => (
              <OutlineRow key={group.id} group={group} depth={0} view={view} expanded={expanded} onToggle={toggle} rollups={rollups} maxChurn={maxChurn} />
            ))}
          </ul>
          {findings > 0 && (
            <details className="map-outline-findings">
              <summary>Dependency findings · {findings}</summary>
              <ul>
                {view.hierarchy.usedUndeclared.slice(0, 8).map((finding) => (
                  <li key={`u:${finding.fromProject}:${finding.toProject}`} title="Files import across projects, but no manifest declares the dependency">
                    <strong>{finding.fromName}</strong> imports <strong>{finding.toName}</strong> ({finding.imports}) · undeclared
                  </li>
                ))}
                {view.hierarchy.declaredUnused.slice(0, 8).map((finding) => (
                  <li key={`d:${finding.fromProject}:${finding.toProject}`} title="Declared in the manifest, but no file imports it">
                    <strong>{finding.fromName}</strong> declares <strong>{finding.toName}</strong> · no imports
                  </li>
                ))}
              </ul>
            </details>
          )}
          {hubs.length > 0 && (
            <div className="map-outline-hubs">
              <div className="map-section-title" title="The most-connected files currently drawn">Hubs in view</div>
              {hubs.map((node) => (
                <button key={node.id} type="button" className="map-outline-hub" onClick={() => onFocusNode(node.id)} title={node.id}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono">{baseName(node.id)}</span>
                  <span className="shrink-0 text-muted-foreground">{node.inDegree + node.outDegree}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
