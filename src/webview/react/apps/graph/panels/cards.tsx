/* Overview bodies for the Map inspector, one per kind of selection. The
   inspector draws the shared header (kind, name, path, close); these draw what
   is specific to a file, a folded folder, a service, or a ticket. */

import { useMemo } from "react";
import { actions, useGraphStore } from "../store";
import { SYMBOL_RELATION_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import {
  annotationsForNode,
  baseName,
  isClusterNode,
  nodeConnections,
  serviceRelationshipBundles,
  shortClusterLabel,
  symbolRelationTargets,
  symbolRelationVerb,
  type GraphViewState,
} from "@/lib/graph/view-model";
import type { GraphNode, SymbolRelation } from "@/lib/graph/protocol";
import { CATEGORY_META, relationKindLabel } from "@/lib/notes/categories";
import { ExternalLink, GitCommitHorizontal, Waypoints } from "lucide-react";
import { NOTE_CATEGORY_ICONS, relationshipKindLabel, relationshipColor, servicePeerLabel, commitAge } from "./shared";
import { MapButton, MapSection, MapSegmented, MapStat } from "./ui";

/** How a file sits in the import graph, in a few words. */
export function fileArchitectureRole(node: GraphNode): string {
  const links = node.inDegree + node.outDegree;
  if (links === 0) return "Isolated file";
  if (node.inDegree >= Math.max(4, node.outDegree * 2)) return "Shared dependency";
  if (node.outDegree >= Math.max(4, node.inDegree * 2)) return "Coordinator";
  if (links >= 12) return "Connectivity hub";
  return "Connected file";
}

/** One click-to-navigate neighbour: direction, folder swatch, name, where it lives.
    A neighbour folded into a collapsed folder surfaces as that folder. */
export function ConnectionRow({ peer, direction, onFocus }: {
  peer: GraphNode;
  direction: "in" | "out";
  onFocus: (id: string) => void;
}) {
  const cluster = isClusterNode(peer);
  const name = cluster ? shortClusterLabel(peer.dir) : baseName(peer.id);
  return (
    <button
      type="button"
      className="map-inspector-row"
      onClick={() => onFocus(peer.id)}
      title={`${direction === "out" ? "Imports" : "Imported by"} ${cluster ? peer.dir : peer.id}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-2xs ${direction === "out" ? "map-dir-out" : "map-dir-in"}`} aria-hidden>
        {direction === "out" ? "→" : "←"}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(peer.dir)) }} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono">{cluster ? `▤ ${name}` : name}</span>
      <span className="max-w-[96px] shrink-0 truncate text-2xs text-[color:var(--map-text-3)]">{cluster ? `${(peer.fileCount ?? 0).toLocaleString()} files` : peer.dir}</span>
    </button>
  );
}

function CommitLine({ churn, lastCommitAt }: { churn?: number; lastCommitAt?: number }) {
  if (!churn && !lastCommitAt) return null;
  const age = commitAge(lastCommitAt);
  return (
    <div className="flex items-center gap-1.5 text-2xs text-[color:var(--map-text-3)]" title="Commits touching this in the recent git window">
      <GitCommitHorizontal className="size-3.5" aria-hidden />
      {churn ? `${churn} recent commit${churn === 1 ? "" : "s"}` : "Tracked"}
      {age ? ` · last ${age}` : ""}
    </div>
  );
}

export function NodeCard({ node, onFocus }: { node: GraphNode; onFocus: (id: string) => void }) {
  const { view, pendingSymbolPath } = useGraphStore();
  const annotations = annotationsForNode(node.id, view.annotations);
  const expansion = view.symbolsByPath[node.id];
  const tracing = pendingSymbolPath === node.id;
  const relationTargets = useMemo(() => [...symbolRelationTargets(expansion)], [expansion]);
  const relationsPresent = useMemo(() => {
    const order: SymbolRelation[] = ["reference", "call", "extends", "implements"];
    const set = new Set<SymbolRelation>();
    for (const edge of expansion?.edges ?? []) set.add(edge.relation ?? "reference");
    return order.filter((r) => set.has(r));
  }, [expansion]);
  const targetsBySymbol = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const edge of expansion?.edges ?? []) {
      const list = grouped.get(edge.from) ?? [];
      if (!list.includes(edge.toPath)) list.push(edge.toPath);
      grouped.set(edge.from, list);
    }
    return grouped;
  }, [expansion]);
  const connections = useMemo(
    () => nodeConnections(node.id, view.displayNodes, view.displayEdges),
    [node.id, view.displayEdges, view.displayNodes],
  );
  return (
    <div className="map-inspector-content">
      <div className="flex flex-col gap-2">
        <div className="map-stat-strip">
          <MapStat value={node.inDegree.toLocaleString()} label="Dependents" title="Files that import this one — what a change here can break" />
          <MapStat value={node.outDegree.toLocaleString()} label="Imports" title="Files this one imports" />
          <MapStat value={`${(node.sizeBytes / 1024).toFixed(1)}`} label="KB" title={`${node.sizeBytes.toLocaleString()} bytes on disk`} />
        </div>
        <CommitLine churn={node.churn} lastCommitAt={node.lastCommitAt} />
      </div>

      {(connections.dependencies.total > 0 || connections.dependents.total > 0) && (
        <MapSection title={`Connections · ${connections.dependencies.total + connections.dependents.total}`}>
          <div className="flex max-h-40 flex-col overflow-y-auto">
            {connections.dependencies.nodes.map((peer) => (
              <ConnectionRow key={`dep:${peer.id}`} peer={peer} direction="out" onFocus={onFocus} />
            ))}
            {connections.dependencies.total > connections.dependencies.nodes.length && (
              <div className="map-hint px-1">+{connections.dependencies.total - connections.dependencies.nodes.length} more imports</div>
            )}
            {connections.dependents.nodes.map((peer) => (
              <ConnectionRow key={`use:${peer.id}`} peer={peer} direction="in" onFocus={onFocus} />
            ))}
            {connections.dependents.total > connections.dependents.nodes.length && (
              <div className="map-hint px-1">+{connections.dependents.total - connections.dependents.nodes.length} more dependents</div>
            )}
          </div>
        </MapSection>
      )}

      {annotations.length > 0 && (
        <MapSection
          title={`Notes · ${annotations.length}`}
          action={<button type="button" className="map-text-link" onClick={() => actions.openNotesTimeline()} title="Open every map note as a timeline with revisions and git history">Timeline</button>}
        >
          {annotations.map((a) => {
            const relation = a.scope === "edge" || (a.scope === undefined && Boolean(a.to));
            const categoryMeta = a.category ? CATEGORY_META[a.category] : undefined;
            const CategoryIcon = a.category ? NOTE_CATEGORY_ICONS[a.category] : undefined;
            const relKindLabel = relation ? relationKindLabel(a.relationKind) : undefined;
            return (
              <div key={a.id} className="map-inspector-item text-xs text-[color:var(--map-text-2)]">
                <div className="flex flex-wrap items-center gap-1">
                  {categoryMeta && CategoryIcon && (
                    <span className={`notes-category-badge notes-category-badge-${categoryMeta.className}`} title={categoryMeta.description}>
                      <CategoryIcon size={10} aria-hidden />
                      {categoryMeta.label}
                    </span>
                  )}
                  {relKindLabel && <span className="notes-relation-tag">{relKindLabel}</span>}
                  {relation && (
                    <span className="truncate font-mono text-2xs text-[color:var(--map-text-3)]">
                      {a.from === node.id ? "→ " : "← "}{baseName(a.from === node.id ? a.to ?? "" : a.from)}
                    </span>
                  )}
                </div>
                {a.title && <div className="font-semibold text-[color:var(--map-text)]">{a.title}</div>}
                <div className="leading-relaxed">{a.note}</div>
                <div className="flex items-center gap-3">
                  {a.history && a.history.length > 0 && <span className="map-hint">revised {a.history.length + 1}×</span>}
                  {(a.category === "todo" || a.category === "risk") && (
                    <button
                      type="button"
                      className="map-text-link"
                      onClick={() => actions.makeTicketFromNote(a.id)}
                      title="File the work this note identifies. The note stays as code knowledge."
                    >
                      Make a ticket
                    </button>
                  )}
                  <button type="button" className="map-text-link map-text-link-danger" onClick={() => actions.removeAnnotation(a.id)} title="Delete this note">Remove</button>
                </div>
              </div>
            );
          })}
        </MapSection>
      )}

      <MapSection
        title="Symbol relationships"
        action={
          <MapButton
            size="xs"
            variant="outline"
            icon={Waypoints}
            disabled={tracing}
            onClick={() => expansion ? actions.collapseSymbols(node.id) : actions.traceRelationships(node.id)}
            title={expansion ? "Hide this file's traced symbols" : "Ask the language server for this file's symbols and who calls, references, or extends them. Related files light up on the map."}
          >
            {tracing ? "Tracing…" : expansion ? "Collapse" : "Trace"}
          </MapButton>
        }
      >
        {!expansion && !tracing && (
          <div className="map-hint">References, calls, and inheritance for this file, from the language server.</div>
        )}
        {tracing && <div className="map-hint">Querying the language server…</div>}
        {expansion && (
          <>
            <div className="map-hint">{expansion.symbols.length} symbols · {relationTargets.length} related files</div>
            {relationsPresent.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {relationsPresent.map((relation) => (
                  <span key={relation} className="flex items-center gap-1 text-2xs text-[color:var(--map-text-3)]">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(SYMBOL_RELATION_COLORS[relation]) }} />
                    {symbolRelationVerb(relation)}
                  </span>
                ))}
              </div>
            )}
            {expansion.error && <div className="map-callout map-callout-warn">{expansion.error}</div>}
            {!expansion.error && expansion.symbols.length === 0 && <div className="map-hint">No top-level symbols were surfaced for this file.</div>}
            {!expansion.error && expansion.symbols.length > 0 && relationTargets.length === 0 && (
              <div className="map-hint">Symbols were found, but no related files were returned.</div>
            )}
            {!expansion.error && expansion.symbols.length > 0 && (
              <div className="flex max-h-40 flex-col overflow-auto">
                {expansion.symbols.map((symbol) => {
                  const targets = targetsBySymbol.get(symbol.id) ?? [];
                  return (
                    <button
                      key={symbol.id}
                      type="button"
                      className="map-inspector-row"
                      onClick={() => actions.openFile(node.id, symbol.startLine)}
                      title={[`Open at line ${symbol.startLine + 1}`, ...targets].join("\n")}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{symbol.name}</span>
                      <span className="shrink-0 text-2xs text-[color:var(--map-text-3)]">{symbol.kind}</span>
                      <span className="w-8 shrink-0 text-right font-mono text-2xs text-[color:var(--map-text-3)]" title={`${targets.length} related file${targets.length === 1 ? "" : "s"}`}>{targets.length || ""}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </MapSection>

      <MapSection title="Isolate" action={
        <MapSegmented
          label="Isolate by import hops"
          size="xs"
          className="w-[132px]"
          value={view.filter.isolateDepth}
          onChange={(isolateDepth) => actions.setFilter({ isolateDepth })}
          options={[0, 1, 2, 3].map((depth) => ({
            value: depth,
            label: depth === 0 ? "Off" : String(depth),
            title: depth === 0 ? "Show the whole map" : `Dim everything more than ${depth} import hop${depth === 1 ? "" : "s"} away`,
          }))}
        />
      }>
        <span className="sr-only">Dim everything beyond N import hops from this file.</span>
      </MapSection>

      <div className="map-inspector-actions">
        <MapButton variant="primary" icon={ExternalLink} onClick={() => actions.openFile(node.id)} title={`Open ${node.id}`}>Open file</MapButton>
      </div>
    </div>
  );
}

/** Inspector body for a synthetic Work-lens ticket. The queue remains the
 *  editing surface; this explains why the ticket sits where it does. */
export function TicketCard({ node, view }: { node: GraphNode; view: GraphViewState }) {
  const scope = view.displayEdges.filter((edge) => edge.kind === "ticket_scope" && edge.from === node.id);
  const blockers = view.displayEdges.filter((edge) => edge.kind === "ticket_blocked" && edge.from === node.id);
  const overlaps = view.displayEdges.filter((edge) => edge.kind === "ticket_overlap" && (edge.from === node.id || edge.to === node.id));
  return (
    <div className="map-inspector-content">
      <div className="map-stat-strip">
        <MapStat value={node.ticketPriority ?? "—"} label="Priority" />
        <MapStat value={scope.length} label="Files" title="Files in this ticket's territory" />
        <MapStat value={overlaps.length} label="Overlaps" title="Other open tickets whose territory overlaps this one" />
      </div>
      {blockers.length > 0 && (
        <div className="map-callout map-callout-warn">Blocked by {blockers.map((edge) => edge.to.replace(/^ticket:/, "")).join(", ")}</div>
      )}
      {scope.length === 0 && <div className="map-hint">No territory yet — it sits in the unlocated-work gutter.</div>}
      <div className="map-inspector-actions">
        <MapButton variant="primary" onClick={() => actions.openTickets()}>Open in Tickets</MapButton>
      </div>
    </div>
  );
}

/** Body for a folded folder's star: what it stands for, and the way back in. */
export function ClusterCard({ node }: { node: GraphNode }) {
  const { view } = useGraphStore();
  /* A folder collapsed by hand expands in place; one folded by the scope or
     the focus budget is entered instead, so its files get the whole budget. */
  const handCollapsed = view.collapsedClusters.includes(node.dir);
  return (
    <div className="map-inspector-content">
      <div className="map-stat-strip">
        <MapStat value={(node.fileCount ?? 0).toLocaleString()} label="Files" />
        <MapStat value={(node.inDegree + node.outDegree).toLocaleString()} label="Links out" title="Import links crossing this folder's edge" />
        <MapStat value={node.churn ?? 0} label="Commits" title="Recent commits touching files in this folder" />
      </div>
      <CommitLine lastCommitAt={node.lastCommitAt} />
      <div className="map-inspector-actions">
        <MapButton variant="primary" onClick={() => (handCollapsed ? actions.setClusterCollapsed(node.dir, false) : actions.enterGroup(node.id))}>
          {handCollapsed ? "Unfold" : "Open folder"}
        </MapButton>
        <span className="map-hint">or double-click the star</span>
      </div>
    </div>
  );
}

export function ServiceCard({ node, view }: { node: GraphNode; view: GraphViewState }) {
  /* Camera movement updates the outer map at rendering cadence. Keep this
     evidence projection tied to graph inputs rather than re-bundling a large
     relationship corpus every time the viewport changes. */
  const bundles = useMemo(
    () => serviceRelationshipBundles(view.displayNodes, view.displayEdges)
      .filter((bundle) => bundle.from === node.id || bundle.to === node.id)
      .slice(0, 8),
    [node.id, view.displayEdges, view.displayNodes],
  );
  return (
    <div className="map-inspector-content">
      <div className="map-stat-strip">
        <MapStat value={(node.fileCount ?? 0).toLocaleString()} label="Files" title="Drawn files this service stands for" />
        <MapStat value={node.inDegree} label="Inbound" />
        <MapStat value={node.outDegree} label="Outbound" />
      </div>
      <MapSection title="Routes">
        {bundles.length === 0 && <div className="map-hint">No visible routes for the active layers.</div>}
        <div className="flex max-h-56 flex-col gap-1.5 overflow-auto">
          {bundles.map((bundle) => {
            const edge = bundle.representative;
            const color = relationshipColor(edge);
            const confidence = Math.round(bundle.averageConfidence * 100);
            const direction = bundle.from === node.id ? "out" : "in";
            return (
              <div key={bundle.id} className="map-service-edge" style={{ borderColor: `${color}40`, background: `linear-gradient(90deg, ${color}12, transparent)` }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-[color:var(--map-text)]">
                    {edge.label ?? relationshipKindLabel(bundle.kind)}{bundle.count > 1 ? ` · ${bundle.count}×` : ""}
                  </span>
                  <span className="map-service-kind" style={{ color }}>{relationshipKindLabel(bundle.kind)}</span>
                </div>
                <div className="truncate text-2xs text-[color:var(--map-text-3)]">
                  {direction === "out" ? "calls" : "called by"} {servicePeerLabel(edge, node)}
                </div>
                {edge.detail && <div className="text-2xs text-[color:var(--map-text-3)]">{edge.detail}</div>}
                <div className="map-service-confidence" title={`Average confidence ${confidence}% · range ${Math.round(bundle.minConfidence * 100)}–${Math.round(bundle.maxConfidence * 100)}%`}>
                  <span>{confidence}%</span>
                  <div><i style={{ width: `${confidence}%`, background: color }} /></div>
                </div>
                {edge.evidence?.length ? (
                  <div className="flex flex-wrap gap-1">
                    {edge.evidence.slice(0, 2).map((item) => <span key={item} className="map-service-evidence">{item}</span>)}
                  </div>
                ) : null}
                {edge.ambiguousCandidateCount && edge.ambiguousCandidateCount > 1 ? (
                  <div className="text-2xs text-[color:var(--s-warn)]">{edge.ambiguousCandidateCount} equally ranked provider candidates</div>
                ) : null}
                <div className="flex gap-3">
                  {edge.sourcePath && <button type="button" className="map-text-link" onClick={() => actions.openFile(edge.sourcePath!, edge.sourceLine)} title={edge.sourcePath}>Consumer</button>}
                  {edge.targetPath && <button type="button" className="map-text-link" onClick={() => actions.openFile(edge.targetPath!, edge.targetLine)} title={edge.targetPath}>Provider</button>}
                </div>
              </div>
            );
          })}
        </div>
      </MapSection>
    </div>
  );
}
