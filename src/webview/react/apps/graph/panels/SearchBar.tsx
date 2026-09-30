/* The Map's command panel: title and index status, the scope bar (breadcrumb
   and view mode — Systems, Focus, All files), and search. Search covers the
   render sample locally and, when the index holds more files than the canvas
   draws, the whole index through the host (search_corpus); picking a file
   beyond the sample scopes into its codebase so it is fetched and drawn. */

import { useEffect, useMemo, useRef, useState } from "react";
import { actions } from "../store";
import { cssColor, folderColor } from "@/lib/graph/colors";
import { groupIndexFor, searchHighlightSegments, searchMatches, type GraphViewState } from "@/lib/graph/view-model";
import { breadcrumb, type ScopeMode } from "@/lib/graph/scope";
import type { GraphNode } from "@/lib/graph/protocol";
import { ChevronRight, CornerLeftUp, Search } from "lucide-react";

const PHASE_LABELS: Record<string, string> = {
  discover: "Discovering files",
  scan: "Reading files",
  resolve: "Resolving imports",
  layout: "Laying out",
};

const MODES: Array<{ mode: ScopeMode; label: string; title: string }> = [
  { mode: "systems", label: "Systems", title: "One node per codebase, with the relationships between them" },
  { mode: "focus", label: "Focus", title: "Everything in scope, folded into areas when it exceeds the focus budget" },
  { mode: "all", label: "All files", title: "Every file in the render sample, unfolded" },
];

/** Breadcrumb and view-mode control. */
export function ScopeBar({ view }: { view: GraphViewState }) {
  const index = useMemo(() => groupIndexFor(view.hierarchy), [view.hierarchy]);
  const crumbs = useMemo(() => breadcrumb(view.scope, index), [view.scope, index]);
  if (!view.hierarchy || view.display.lens !== "files") return null;
  const hasGroups = view.hierarchy.groups.some((group) => group.level === "codebase" || group.level === "root");
  const atWorkspace = view.scope.length === 0;
  return (
    <div className="map-scope-bar" data-map-region="scope">
      <nav className="map-breadcrumb" aria-label="Map scope">
        {!atWorkspace && (
          <button type="button" className="map-crumb-up" onClick={() => actions.scopeUp()} title="Up one level (Backspace)" aria-label="Up one level">
            <CornerLeftUp size={12} aria-hidden="true" />
          </button>
        )}
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={crumb.id ?? "workspace"} className="flex min-w-0 items-center">
              {i > 0 && <ChevronRight size={11} className="shrink-0 opacity-50" aria-hidden="true" />}
              <button
                type="button"
                className={`map-crumb ${last ? "map-crumb-current" : ""}`}
                aria-current={last ? "location" : undefined}
                onClick={() => actions.setScopeTo(crumb.id)}
                title={crumb.id ? `${crumb.level}: ${crumb.label}` : "The whole workspace"}
                style={crumb.id && crumb.level !== "area" ? { color: cssColor(folderColor(index.byId.get(crumb.id)?.key ?? crumb.label)) } : undefined}
              >
                {crumb.label}
              </button>
            </span>
          );
        })}
      </nav>
      <div className="map-mode-switch" role="group" aria-label="View mode">
        {MODES.map(({ mode, label, title }) => {
          if (mode === "systems" && !hasGroups) return null;
          const active = view.scopeMode === mode && (mode !== "systems" || atWorkspace);
          return (
            <button
              key={mode}
              type="button"
              className={`map-tool-button ${active ? "map-tool-button-active" : ""}`}
              aria-pressed={active}
              title={title}
              data-map-control={`mode-${mode}`}
              onClick={() => (mode === "all" && atWorkspace ? actions.showAllFiles() : actions.setScopeMode(mode))}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SearchBar({ view, search, nodes, searchNodes, indexedFileCount, indexedImportCount, hiddenByPolicyCount, excludeDotDirectories, indexing, relationshipIndexing, inputRef, onPick }: {
  view: GraphViewState;
  search: string;
  /** Active-lens targets. Files remain searchable in the file view; the
      Services lens supplies its semantic service nodes instead. */
  searchNodes: GraphNode[];
  nodes: GraphNode[];
  indexedFileCount: number;
  indexedImportCount: number;
  hiddenByPolicyCount: number;
  excludeDotDirectories: boolean;
  indexing: boolean;
  relationshipIndexing: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      panel.parentElement?.style.setProperty("--map-command-height", panel.offsetHeight + "px");
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const matches = useMemo(() => searchMatches(searchNodes, search, 8), [searchNodes, search]);
  const moduleCount = useMemo(() => new Set(nodes.map((node) => node.dir)).size, [nodes]);
  const servicesMode = searchNodes.some((node) => node.kind === "service");
  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [search]);

  /* The render sample may not hold the file: ask the host to search the
     whole index when it is larger than what the canvas draws. */
  const sampled = indexedFileCount > nodes.length;
  useEffect(() => {
    if (!servicesMode && sampled && search.trim().length >= 2) actions.searchCorpus(search);
  }, [search, sampled, servicesMode]);
  const local = useMemo(() => new Set(matches.map((node) => node.id)), [matches]);
  const beyond = useMemo(() => {
    const corpus = view.corpusSearch;
    if (!sampled || !corpus || corpus.query !== search.trim()) return [];
    const present = new Set(nodes.map((node) => node.id));
    return corpus.results.filter((row) => !local.has(row.id) && !present.has(row.id)).slice(0, 6);
  }, [view.corpusSearch, search, sampled, local, nodes]);

  const pick = (id: string) => {
    actions.hover(null); /* retire any result-row preview highlight */
    onPick(id);
    actions.setSearch("");
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const node = matches[Math.min(active, matches.length - 1)];
      if (node) pick(node.id);
    }
  };

  const phase = view.indexingPhase ? PHASE_LABELS[view.indexingPhase] ?? "Indexing" : "Indexing files";
  const progress = view.indexingProgress !== null ? ` ${Math.round(view.indexingProgress * 100)}%` : "";

  return (
    <section ref={panelRef} className="map-panel map-command-panel pointer-events-auto absolute left-3 top-3 w-[min(340px,calc(100vw-24px))]" aria-label="Architecture map search and summary" data-map-region="command">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="map-eyebrow">Blacksite · Workspace</div>
          <div className="map-command-title">Codebase map</div>
        </div>
        <div className={`map-status ${indexing || relationshipIndexing ? "map-status-live" : ""}`} role="status" aria-live="polite">
          {indexing
            ? `${phase}${progress}`
            : relationshipIndexing
              ? "Tracing services"
              : `${indexedFileCount.toLocaleString()} indexed`}
        </div>
      </div>
      <ScopeBar view={view} />
      <div className="map-stats">
        <div className="map-stat">
          <span>Files</span>
          <strong>{indexedFileCount.toLocaleString()}</strong>
        </div>
        <div className="map-stat">
          <span>Links</span>
          <strong>{indexedImportCount.toLocaleString()}</strong>
        </div>
        <div className="map-stat">
          <span>Modules</span>
          <strong>{moduleCount.toLocaleString()}</strong>
        </div>
      </div>
      {/* Removing a large slice of a workspace has to be legible: somebody who
          wanted .github on the map otherwise has no way to learn why it went
          away. Only shown when the policy actually dropped something. */}
      {hiddenByPolicyCount > 0 && excludeDotDirectories && !indexing && (
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground" data-map-region="hidden-files">
          <span>
            {hiddenByPolicyCount.toLocaleString()} {hiddenByPolicyCount === 1 ? "file" : "files"} in dot-directories hidden
          </span>
          <button
            type="button"
            className="map-layer-toggle shrink-0"
            data-map-control="show-dot-directories"
            title="Index dot-directories such as .vscode-test and .github. Rebuilds the map. .git and .blacksite are never indexed."
            onClick={() => actions.setExcludeDotDirectories(false)}
          >
            Show
          </button>
        </div>
      )}
      {view.gitignoreApplied && !indexing && (
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground" data-map-region="gitignore">
          <span>Following .gitignore</span>
          <button
            type="button"
            className="map-layer-toggle shrink-0"
            data-map-control="include-gitignored"
            title="Also index files your .gitignore excludes (generated, vendored, build output). Rebuilds the map."
            onClick={() => actions.setRespectGitignore(false)}
          >
            Include ignored
          </button>
        </div>
      )}
      <label className="sr-only" htmlFor="map-search">{servicesMode ? "Search services" : "Search files and modules"}</label>
      <div className="map-search-field">
        <Search size={15} aria-hidden="true" />
        <input
          id="map-search"
          ref={inputRef}
          value={search}
          onChange={(e) => actions.setSearch(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={servicesMode ? "Find a service…" : "Find a file or module…"}
          spellCheck={false}
          className="map-search-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(search.trim())}
          aria-controls="map-search-results"
          aria-activedescendant={search.trim() && matches[active] ? `map-search-result-${active}` : undefined}
        />
        <kbd aria-hidden="true">/</kbd>
      </div>
      {search.trim() && (
        <div id="map-search-results" className="map-results mt-1 flex flex-col gap-px overflow-hidden" role="listbox">
          {matches.length === 0 && beyond.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>}
          {matches.map((node, i) => (
            <button
              id={`map-search-result-${i}`}
              key={node.id}
              className={`px-2 py-1 text-left font-mono text-xs text-foreground ${i === active ? "bg-white/12" : "hover:bg-white/10"}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => {
                setActive(i);
                /* Preview: light the star (hover spotlight) before committing. */
                actions.hover(node.id);
              }}
              onMouseLeave={() => actions.hover(null)}
              onClick={() => pick(node.id)}
              title={node.id}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: cssColor(folderColor(node.dir)) }}
                  aria-hidden
                />
                <span className="block truncate">
                  {searchHighlightSegments(node.kind === "service" ? node.dir : node.id, search).map((segment, s) => (
                    segment.hit
                      ? <strong key={s} className="map-result-hit">{segment.text}</strong>
                      : <span key={s}>{segment.text}</span>
                  ))}
                </span>
              </span>
              {node.kind === "service" && (
                <span className="mt-0.5 block text-2xs uppercase tracking-wide text-cyan-200/70">
                  service · {node.inDegree} in · {node.outDegree} out
                </span>
              )}
            </button>
          ))}
          {beyond.length > 0 && (
            <>
              <div className="px-2 pt-1 text-2xs uppercase tracking-wide text-muted-foreground">Beyond the drawn sample</div>
              {beyond.map((row) => (
                <button
                  key={row.id}
                  className="px-2 py-1 text-left font-mono text-xs text-foreground/85 hover:bg-white/10"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    actions.revealCorpusFile(row.id, row.dir, row.codebase);
                    actions.setSearch("");
                    inputRef.current?.blur();
                  }}
                  title={`${row.id} — opens its codebase and draws it`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-white/40" aria-hidden />
                    <span className="block truncate">{row.id}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
