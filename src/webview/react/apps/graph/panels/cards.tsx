/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { useMemo } from "react";
import { actions, useGraphStore } from "../store";
import { SYMBOL_RELATION_COLORS, TICKET_STATUS_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import { FILE_ROLE_COLORS, FILE_ROLE_LABELS, fileRole } from "@/lib/graph/file-role";
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
import { NOTE_CATEGORY_ICONS, relationshipKindLabel, relationshipColor, servicePeerLabel, commitAge } from "./shared";

/** One click-to-navigate neighbor in the node card's Connections list:
    direction arrow, territory swatch, name, and where it lives. A neighbor
    folded into a collapsed cluster surfaces as that cluster (▤) row. */
export function ConnectionRow({ peer, direction, onFocus }: {
  peer: GraphNode;
  direction: "in" | "out";
  onFocus: (id: string) => void;
}) {
  const cluster = isClusterNode(peer);
  const name = cluster ? shortClusterLabel(peer.dir) : baseName(peer.id);
  return (
    <button
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.08]"
      onClick={() => onFocus(peer.id)}
      title={`${direction === "out" ? "imports" : "imported by"} ${cluster ? peer.dir : peer.id}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-2xs ${direction === "out" ? "text-cyan-200/80" : "text-amber-200/80"}`} aria-hidden>
        {direction === "out" ? "→" : "←"}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(peer.dir)) }} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
        {cluster ? `▤ ${name}` : name}
      </span>
      <span className="max-w-[92px] shrink-0 truncate text-2xs text-muted-foreground">{cluster ? `${(peer.fileCount ?? 0).toLocaleString()} files` : peer.dir}</span>
    </button>
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
  const directLinks = node.inDegree + node.outDegree;
  const architectureRole = directLinks === 0
    ? "Isolated file"
    : node.inDegree >= Math.max(4, node.outDegree * 2)
      ? "Shared dependency"
      : node.outDegree >= Math.max(4, node.inDegree * 2)
        ? "Coordinator"
        : directLinks >= 12
          ? "Connectivity hub"
          : "Connected file";
  // The star's corner mark denotes this — naming it here is what makes the mark learnable.
  const functionalRole = fileRole(node.id);
  return (
    <div className="map-inspector-content">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
        {architectureRole}
        {functionalRole !== "source" && (
          <span
            className="ml-auto rounded-full border px-1.5 py-px text-2xs font-semibold uppercase tracking-wide"
            style={{
              color: cssColor(FILE_ROLE_COLORS[functionalRole]),
              borderColor: `color-mix(in srgb, ${cssColor(FILE_ROLE_COLORS[functionalRole])} 45%, transparent)`,
            }}
          >
            {FILE_ROLE_LABELS[functionalRole]}
          </span>
        )}
      </div>
      <div className="break-all font-mono text-sm text-foreground">{node.id}</div>
      <div className="map-relationship-summary">
        <div>
          <span>Dependents</span>
          <strong>{node.inDegree.toLocaleString()}</strong>
          <small>blast radius</small>
        </div>
        <div>
          <span>Dependencies</span>
          <strong>{node.outDegree.toLocaleString()}</strong>
          <small>outbound</small>
        </div>
        <div>
          <span>Size</span>
          <strong>{(node.sizeBytes / 1024).toFixed(1)}</strong>
          <small>KB</small>
        </div>
      </div>
      {(node.churn || node.lastCommitAt) && (
        <div className="mt-0.5 text-xs text-amber-200/70">
          {node.churn ? `${node.churn} recent commit${node.churn === 1 ? "" : "s"}` : "tracked"}
          {commitAge(node.lastCommitAt) ? ` · last ${commitAge(node.lastCommitAt)}` : ""}
        </div>
      )}
      {(connections.dependencies.total > 0 || connections.dependents.total > 0) && (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <div className="text-xs uppercase tracking-wide text-slate-300/80">Connections</div>
          <div className="mt-1 flex max-h-36 flex-col gap-px overflow-y-auto">
            {connections.dependencies.nodes.map((peer) => (
              <ConnectionRow key={`dep:${peer.id}`} peer={peer} direction="out" onFocus={onFocus} />
            ))}
            {connections.dependencies.total > connections.dependencies.nodes.length && (
              <div className="px-1 text-2xs text-muted-foreground">
                +{connections.dependencies.total - connections.dependencies.nodes.length} more dependencies
              </div>
            )}
            {connections.dependents.nodes.map((peer) => (
              <ConnectionRow key={`use:${peer.id}`} peer={peer} direction="in" onFocus={onFocus} />
            ))}
            {connections.dependents.total > connections.dependents.nodes.length && (
              <div className="px-1 text-2xs text-muted-foreground">
                +{connections.dependents.total - connections.dependents.nodes.length} more dependents
              </div>
            )}
          </div>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-border/60 pt-1.5">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-slate-300/80">Notes</div>
            <button
              className="text-2xs uppercase tracking-wide text-amber-200/75 hover:text-amber-100"
              onClick={() => actions.openNotesTimeline()}
              title="Open every map note as a scrollable timeline with revision trails and git history"
            >
              Timeline
            </button>
          </div>
          {annotations.map((a) => {
            const relation = a.scope === "edge" || (a.scope === undefined && Boolean(a.to));
            const categoryMeta = a.category ? CATEGORY_META[a.category] : undefined;
            const CategoryIcon = a.category ? NOTE_CATEGORY_ICONS[a.category] : undefined;
            const relKindLabel = relation ? relationKindLabel(a.relationKind) : undefined;
            return (
              <div key={a.id} className="text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-1">
                  {categoryMeta && CategoryIcon && (
                    <span className={`notes-category-badge notes-category-badge-${categoryMeta.className}`} title={categoryMeta.description}>
                      <CategoryIcon size={10} aria-hidden />
                      {categoryMeta.label}
                    </span>
                  )}
                  {relKindLabel && <span className="notes-relation-tag">{relKindLabel}</span>}
                  <span className="text-amber-300/90">
                    {!relation ? "note" : `${a.from === node.id ? "→ " : "← "}${a.from === node.id ? a.to : a.from}`}
                  </span>
                </div>
                {a.title && <div className="mt-0.5 font-semibold text-foreground/90">{a.title}</div>}
                <div className="mt-0.5">{a.note}</div>
                {a.history && a.history.length > 0 && (
                  <div className="mt-0.5 text-2xs text-slate-400/80">revised {a.history.length + 1}× across sessions</div>
                )}
                <button className="mt-0.5 text-2xs uppercase tracking-wide text-red-300/70 hover:text-red-300" onClick={() => actions.removeAnnotation(a.id)}>
                  remove
                </button>
                {(a.category === "todo" || a.category === "risk") && (
                  <button
                    className="mt-0.5 ml-2 text-2xs uppercase tracking-wide text-cyan-200/80 hover:text-cyan-100"
                    onClick={() => actions.makeTicketFromNote(a.id)}
                    title="File the work this note identifies. The note remains as durable code knowledge."
                  >
                    Make a ticket
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1.5 border-t border-border/60 pt-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-slate-300/80">Relationship tracing</div>
          <button
            className="map-trace-button"
            disabled={tracing}
            onClick={() => expansion ? actions.collapseSymbols(node.id) : actions.traceRelationships(node.id)}
          >
            {tracing ? "Tracing..." : expansion ? "Collapse" : "Trace relationships"}
          </button>
        </div>
        {!expansion && !tracing && (
          <div className="mt-1 text-xs text-muted-foreground">
            Fetch this file&apos;s symbols and their relationships — references, calls, and inheritance — via the language server. Related files light up on the map.
          </div>
        )}
        {tracing && (
          <div className="mt-1 text-xs text-muted-foreground">
            Querying the language server for symbols and references.
          </div>
        )}
        {expansion && (
          <>
            <div className="mt-1 text-xs text-muted-foreground">
              {expansion.symbols.length} symbols · {relationTargets.length} related files
            </div>
            {relationsPresent.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
                {relationsPresent.map((relation) => (
                  <span key={relation} className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(SYMBOL_RELATION_COLORS[relation]) }} />
                    {symbolRelationVerb(relation)}
                  </span>
                ))}
              </div>
            )}
            {expansion.error && (
              <div className="mt-1 rounded border border-amber-400/20 bg-amber-950/40 px-2 py-1 text-xs text-amber-200/85">
                {expansion.error}
              </div>
            )}
            {!expansion.error && expansion.symbols.length === 0 && (
              <div className="mt-1 text-xs text-muted-foreground">
                No top-level symbols were surfaced for this file.
              </div>
            )}
            {!expansion.error && expansion.symbols.length > 0 && relationTargets.length === 0 && (
              <div className="mt-1 text-xs text-muted-foreground">
                Symbols were found, but no related files were returned.
              </div>
            )}
            {!expansion.error && expansion.symbols.length > 0 && (
              <div className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-auto">
                {expansion.symbols.map((symbol) => {
                  const targets = targetsBySymbol.get(symbol.id) ?? [];
                  const relatedLabel = `${targets.length} related file${targets.length === 1 ? "" : "s"}`;
                  return (
                    <button
                      key={symbol.id}
                      className="rounded border border-white/6 bg-white/[0.03] px-2 py-1 text-left hover:bg-white/[0.08]"
                      onClick={() => actions.openFile(node.id, symbol.startLine)}
                      title={targets.join("\n")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs text-foreground">{symbol.name}</span>
                        <span className="shrink-0 text-2xs uppercase tracking-wide text-cyan-200/75">{symbol.kind}</span>
                      </div>
                      <div className="mt-0.5 text-2xs text-muted-foreground">
                        {relatedLabel} · line {symbol.startLine + 1}
                      </div>
                      {targets[0] && (
                        <div className="mt-0.5 truncate font-mono text-2xs text-slate-300/70">
                          {targets.slice(0, 2).join("  ·  ")}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-1.5 border-t border-border/60 pt-1.5">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-slate-300/80">Isolate</div>
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((depth) => (
              <button
                key={depth}
                className={`map-tool-button !px-1.5 ${view.filter.isolateDepth === depth ? "map-tool-button-active" : ""}`}
                onClick={() => actions.setFilter({ isolateDepth: depth })}
                title={depth === 0 ? "Show the whole map" : `Show only files within ${depth} hop${depth === 1 ? "" : "s"}`}
              >
                {depth === 0 ? "Off" : depth}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-1 text-2xs text-muted-foreground">Dim everything beyond N import hops from this file.</div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
          onClick={() => actions.openFile(node.id)}
        >
          Open file
        </button>
        <button
          className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15"
          onClick={() => actions.select(null)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Inspector for a synthetic Work-lens ticket node. The queue itself remains
 * the editing surface; this card explains why the ticket is spatially here. */
export function TicketCard({ node, view }: { node: GraphNode; view: GraphViewState }) {
  const scope = view.displayEdges.filter((edge) => edge.kind === "ticket_scope" && edge.from === node.id);
  const blockers = view.displayEdges.filter((edge) => edge.kind === "ticket_blocked" && edge.from === node.id);
  const overlaps = view.displayEdges.filter((edge) => edge.kind === "ticket_overlap" && (edge.from === node.id || edge.to === node.id));
  const status = node.ticketStatus ?? "backlog";
  return (
    <div className="map-inspector-content">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(TICKET_STATUS_COLORS[status]) }} aria-hidden />
        Work ticket · {status.replace(/_/g, " ")}
      </div>
      <div className="font-mono text-2xs text-muted-foreground">{node.ticketId}</div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{node.ticketTitle}</div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-center text-2xs text-muted-foreground">
        <div className="rounded bg-white/[0.04] px-1.5 py-1"><strong className="block text-xs text-foreground">{node.ticketPriority}</strong>priority</div>
        <div className="rounded bg-white/[0.04] px-1.5 py-1"><strong className="block text-xs text-foreground">{scope.length}</strong>files</div>
        <div className="rounded bg-white/[0.04] px-1.5 py-1"><strong className="block text-xs text-foreground">{overlaps.length}</strong>overlaps</div>
      </div>
      {blockers.length > 0 && (
        <div className="mt-2 rounded border border-orange-300/20 bg-orange-950/25 px-2 py-1 text-xs text-orange-100/85">
          Blocked by {blockers.map((edge) => edge.to.replace(/^ticket:/, "")).join(", ")}
        </div>
      )}
      {scope.length === 0 && <div className="mt-2 text-xs text-muted-foreground">No territory yet · positioned in the unlocated-work gutter.</div>}
      <div className="mt-2 flex gap-1.5">
        <button className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20" onClick={() => actions.openTickets()}>Open work</button>
        <button className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15" onClick={() => actions.select(null)}>Dismiss</button>
      </div>
    </div>
  );
}

/** Card for a collapsed cluster's super-node: what it stands for and a one-tap
    way back to the files inside. */
export function ClusterCard({ node }: { node: GraphNode }) {
  const { view } = useGraphStore();
  /* A folder collapsed by hand expands in place; one folded by the scope or
     the focus budget is entered instead, so its files get the whole budget. */
  const handCollapsed = view.collapsedClusters.includes(node.dir);
  return (
    <div className="map-inspector-content">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
        Folder cluster
      </div>
      <div className="break-all font-mono text-base text-foreground">{node.dir}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {(node.fileCount ?? 0).toLocaleString()} files {handCollapsed ? "collapsed" : "folded"} · {node.inDegree + node.outDegree} links crossing
      </div>
      {(node.churn || node.lastCommitAt) && (
        <div className="mt-0.5 text-xs text-amber-200/70">
          {node.churn ? `${node.churn} recent commits` : "tracked"}
          {commitAge(node.lastCommitAt) ? ` · last ${commitAge(node.lastCommitAt)}` : ""}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
          onClick={() => (handCollapsed ? actions.setClusterCollapsed(node.dir, false) : actions.enterGroup(node.id))}
        >
          {handCollapsed ? "Expand cluster" : "Open area"}
        </button>
        <button
          className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15"
          onClick={() => actions.select(null)}
        >
          Dismiss
        </button>
      </div>
      <div className="mt-1.5 text-2xs text-muted-foreground">Double-click the star to {handCollapsed ? "expand" : "open"} it too.</div>
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
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rotate-45 rounded-[1px]" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
        Service
      </div>
      <div className="break-all font-mono text-base text-foreground">{node.dir}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {(node.fileCount ?? 0).toLocaleString()} rendered files represented - {node.inDegree} inbound - {node.outDegree} outbound
      </div>
      <div className="mt-2 flex max-h-44 flex-col gap-1 overflow-auto border-t border-border/60 pt-1.5">
        {bundles.length === 0 && <div className="text-xs text-muted-foreground">No visible service relationships for the active layers.</div>}
        {bundles.map((bundle) => {
          const edge = bundle.representative;
          const color = relationshipColor(edge);
          const confidence = Math.round(bundle.averageConfidence * 100);
          const direction = bundle.from === node.id ? "out" : "in";
          return (
            <div
              key={bundle.id}
              className="map-service-edge"
              style={{ borderColor: `${color}59`, background: `linear-gradient(90deg, ${color}14, rgba(255,255,255,0.025))` }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-foreground">
                  {edge.label ?? relationshipKindLabel(bundle.kind)}{bundle.count > 1 ? ` · ${bundle.count} detections` : ""}
                </span>
                <span
                  className="map-service-kind"
                  style={{ borderColor: `${color}66`, backgroundColor: `${color}1f`, color }}
                >
                  {relationshipKindLabel(bundle.kind)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{direction === "out" ? "calls" : "called by"} {servicePeerLabel(edge, node)}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground/80">{confidence}%</span>
              </div>
              {edge.detail && <div className="mt-0.5 text-xs text-muted-foreground">{edge.detail}</div>}
              <div className="map-service-confidence" title={`Average confidence ${confidence}% · range ${Math.round(bundle.minConfidence * 100)}–${Math.round(bundle.maxConfidence * 100)}%`}>
                <span>Confidence</span>
                <div><i style={{ width: `${confidence}%`, background: color }} /></div>
              </div>
              {edge.evidence?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {edge.evidence.slice(0, 2).map((item) => (
                    <span key={item} className="map-service-evidence">{item}</span>
                  ))}
                </div>
              ) : null}
              {edge.ambiguousCandidateCount && edge.ambiguousCandidateCount > 1 ? (
                <div className="mt-1 text-2xs text-amber-200/75">
                  {edge.ambiguousCandidateCount} equally ranked provider candidates
                </div>
              ) : null}
              <div className="mt-1 flex gap-1">
                {edge.sourcePath && <button className="text-2xs text-cyan-200/80 hover:text-cyan-100" onClick={() => actions.openFile(edge.sourcePath!, edge.sourceLine)}>consumer</button>}
                {edge.targetPath && <button className="text-2xs text-cyan-200/80 hover:text-cyan-100" onClick={() => actions.openFile(edge.targetPath!, edge.targetLine)}>provider</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1.5">
        <button className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15" onClick={() => actions.select(null)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
