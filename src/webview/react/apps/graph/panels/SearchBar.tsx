/* The Map's command panel: where you are (breadcrumb and index status), how
   the scope is drawn (Systems, Focus, All files), and search. Search covers the
   render sample locally and, when the index holds more files than the canvas
   draws, the whole index through the host (search_corpus); picking a file
   beyond the sample scopes into its codebase so it is fetched and drawn. */

import { useEffect, useMemo, useRef, useState } from "react";
import { actions } from "../store";
import { cssColor, folderColor } from "@/lib/graph/colors";
import { baseName, groupIndexFor, searchHighlightSegments, searchMatches, type GraphViewState } from "@/lib/graph/view-model";
import { breadcrumb, type ScopeMode } from "@/lib/graph/scope";
import type { GraphNode } from "@/lib/graph/protocol";
import { ChevronRight, CornerLeftUp, Search } from "lucide-react";
import { MapKbd, MapSegmented } from "./ui";

const PHASE_LABELS: Record<string, string> = {
  discover: "Discovering",
  scan: "Reading files",
  resolve: "Resolving imports",
  layout: "Laying out",
};

const MODES: Array<{ mode: ScopeMode; label: string; title: string }> = [
  { mode: "systems", label: "Systems", title: "One node per codebase, with the relationships between them" },
  { mode: "focus", label: "Focus", title: "Everything in scope, folded into areas when it exceeds the focus budget" },
  { mode: "all", label: "All files", title: "Every file in the render sample, unfolded" },
];

/** Where the map is scoped, as a breadcrumb that doubles as the panel's title. */
function Breadcrumb({ view }: { view: GraphViewState }) {
  const index = useMemo(() => groupIndexFor(view.hierarchy), [view.hierarchy]);
  const crumbs = useMemo(() => breadcrumb(view.scope, index), [view.scope, index]);
  const atWorkspace = view.scope.length === 0;
  return (
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
            {i > 0 && <ChevronRight className="map-crumb-sep" aria-hidden="true" />}
            <button
              type="button"
              className={`map-crumb ${last ? "map-crumb-current" : ""}`}
              aria-current={last ? "location" : undefined}
              onClick={() => actions.setScopeTo(crumb.id)}
              title={crumb.id ? `${crumb.level}: ${crumb.label}` : "The whole workspace"}
              style={crumb.id && crumb.level !== "area" && !last ? { color: cssColor(folderColor(index.byId.get(crumb.id)?.key ?? crumb.label)) } : undefined}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/** How the current scope is drawn. Hidden until the host sends a hierarchy. */
export function ScopeBar({ view }: { view: GraphViewState }) {
  if (!view.hierarchy || view.display.lens !== "files") return null;
  const hasGroups = view.hierarchy.groups.some((group) => group.level === "codebase" || group.level === "root");
  const atWorkspace = view.scope.length === 0;
  const modes = MODES.filter(({ mode }) => mode !== "systems" || hasGroups);
  const active = modes.find(({ mode }) => view.scopeMode === mode && (mode !== "systems" || atWorkspace))?.mode ?? modes[modes.length - 1]!.mode;
  return (
    <div className="map-scope-bar" data-map-region="scope">
      <MapSegmented
        label="View mode"
        value={active}
        options={modes.map(({ mode, label, title }) => ({ value: mode, label, title, control: `mode-${mode}` }))}
        onChange={(mode) => (mode === "all" && atWorkspace ? actions.showAllFiles() : actions.setScopeMode(mode))}
      />
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
  const folderCount = useMemo(() => new Set(nodes.map((node) => node.dir.replace(/#\d+$/, ""))).size, [nodes]);
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

  const busy = indexing || relationshipIndexing;
  const phase = view.indexingPhase ? PHASE_LABELS[view.indexingPhase] ?? "Indexing" : "Indexing";
  const progress = indexing && view.indexingProgress !== null ? Math.round(view.indexingProgress * 100) : null;
  const statusText = indexing
    ? `${phase}${progress !== null ? ` ${progress}%` : ""}`
    : relationshipIndexing ? "Tracing services" : `${indexedFileCount.toLocaleString()} indexed`;
  const statusTitle = indexing
    ? "Building the map in the background — the canvas updates as it lands"
    : relationshipIndexing
      ? "Detecting API, event, and data contracts between services"
      : `${indexedFileCount.toLocaleString()} files indexed${sampled ? `, ${nodes.length.toLocaleString()} drawn` : ""}`;

  return (
    <section ref={panelRef} className="map-panel map-command-panel pointer-events-auto absolute left-3 top-3" aria-label="Map scope and search" data-map-region="command">
      <div className="map-command-head">
        <Breadcrumb view={view} />
        <span className={`map-status ${busy ? "map-status-live" : ""}`} role="status" aria-live="polite" title={statusTitle}>
          {busy && <span className="map-live-pip" aria-hidden />}
          {statusText}
        </span>
      </div>
      <ScopeBar view={view} />
      <label className="sr-only" htmlFor="map-search">{servicesMode ? "Search services" : "Search files and folders"}</label>
      <div className="map-search-field">
        <Search aria-hidden="true" />
        <input
          id="map-search"
          ref={inputRef}
          value={search}
          onChange={(e) => actions.setSearch(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={servicesMode ? "Find a service…" : "Find a file or folder…"}
          spellCheck={false}
          className="map-search-input w-full"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(search.trim())}
          aria-controls="map-search-results"
          aria-activedescendant={search.trim() && matches[active] ? `map-search-result-${active}` : undefined}
        />
        <MapKbd>/</MapKbd>
      </div>
      {search.trim() && (
        <div id="map-search-results" className="map-results" role="listbox">
          {matches.length === 0 && beyond.length === 0 && <div className="map-hint px-2 py-1.5">No matches</div>}
          {matches.map((node, i) => {
            const label = node.kind === "service" ? node.dir.replace(/^svc:/, "") : node.id;
            const slash = label.lastIndexOf("/");
            const nameStart = node.kind === "service" ? 0 : slash + 1;
            const segments = searchHighlightSegments(label, search);
            /* Split the highlighted path at the last slash: name prominent, folder quiet. */
            let offset = 0;
            const name: React.ReactNode[] = [];
            const dir: React.ReactNode[] = [];
            segments.forEach((segment, s) => {
              const start = offset;
              offset += segment.text.length;
              const pieces: Array<[string, boolean]> = [];
              if (offset <= nameStart) pieces.push([segment.text, false]);
              else if (start >= nameStart) pieces.push([segment.text, true]);
              else pieces.push([segment.text.slice(0, nameStart - start), false], [segment.text.slice(nameStart - start), true]);
              pieces.forEach(([text, inName], p) => {
                if (!text) return;
                const element = segment.hit ? <strong key={`${s}:${p}`} className="map-result-hit">{text}</strong> : <span key={`${s}:${p}`}>{text}</span>;
                (inName ? name : dir).push(element);
              });
            });
            return (
              <button
                id={`map-search-result-${i}`}
                key={node.id}
                type="button"
                className="map-result"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => {
                  setActive(i);
                  /* Preview: light the star (hover spotlight) before committing. */
                  actions.hover(node.id);
                }}
                onMouseLeave={() => actions.hover(null)}
                onClick={() => pick(node.id)}
                title={node.kind === "service" ? `${label} · service · ${node.inDegree} in · ${node.outDegree} out` : node.id}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
                <span className="map-result-name">{name.length ? name : baseName(label)}</span>
                {dir.length > 0 && <span className="map-result-dir"><bdi>{dir}</bdi></span>}
              </button>
            );
          })}
          {beyond.length > 0 && (
            <>
              <div className="map-results-label" title="These files are indexed but not drawn yet; picking one opens its codebase">Not drawn yet</div>
              {beyond.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="map-result"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    actions.revealCorpusFile(row.id, row.dir, row.codebase);
                    actions.setSearch("");
                    inputRef.current?.blur();
                  }}
                  title={`${row.id} — opens its codebase and draws it`}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-white/40" aria-hidden />
                  <span className="map-result-name">{baseName(row.id)}</span>
                  <span className="map-result-dir"><bdi>{row.dir}</bdi></span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <div className="map-meta-line">
        <span title={`${indexedFileCount.toLocaleString()} files indexed in this workspace`}><strong>{indexedFileCount.toLocaleString()}</strong> files</span>
        <span title="Resolved import links between indexed files"><strong>{indexedImportCount.toLocaleString()}</strong> links</span>
        <span title="Folders with drawn files"><strong>{folderCount.toLocaleString()}</strong> folders</span>
        {view.gitignoreApplied && !indexing && (
          <span data-map-region="gitignore" title="Files your .gitignore excludes (generated, vendored, build output) are left out">
            Following .gitignore ·{" "}
            <button
              type="button"
              className="map-meta-link"
              data-map-control="include-gitignored"
              title="Also index files your .gitignore excludes. Rebuilds the map."
              onClick={() => actions.setRespectGitignore(false)}
            >
              include
            </button>
          </span>
        )}
        {/* Removing a large slice of a workspace has to be legible: somebody who
            wanted .github on the map otherwise has no way to learn why it went
            away. Only shown when the policy actually dropped something. */}
        {hiddenByPolicyCount > 0 && excludeDotDirectories && !indexing && (
          <span data-map-region="hidden-files" title="Files in dot-directories such as .github and .vscode-test are not indexed. .git and .blacksite never are.">
            {hiddenByPolicyCount.toLocaleString()} in dot-folders hidden ·{" "}
            <button
              type="button"
              className="map-meta-link"
              data-map-control="show-dot-directories"
              title="Index dot-directories too. Rebuilds the map."
              onClick={() => actions.setExcludeDotDirectories(false)}
            >
              show
            </button>
          </span>
        )}
      </div>
      {busy && (
        <div className={`map-progress ${progress === null ? "map-progress-indeterminate" : ""}`} aria-hidden>
          <i style={progress === null ? undefined : { width: `${Math.max(4, progress)}%` }} />
        </div>
      )}
    </section>
  );
}
