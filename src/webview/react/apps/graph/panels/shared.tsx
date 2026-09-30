/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { useEffect, useState } from "react";
import { type Viewport } from "@/lib/graph/camera";
import { RELATIONSHIP_EDGE_COLORS, TRACE_COLORS, cssColor } from "@/lib/graph/colors";
import { type FileRole } from "@/lib/graph/file-role";
import type { EdgeKind, GraphEdge, GraphNode, NoteCategory, SymbolRelation } from "@/lib/graph/protocol";
import { Blocks, HelpCircle, ListTodo, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react";


export const NOTE_CATEGORY_ICONS: Record<NoteCategory, LucideIcon> = {
  architecture: Blocks,
  gotcha: TriangleAlert,
  todo: ListTodo,
  risk: ShieldAlert,
  question: HelpCircle,
};

export const LEGEND: Array<{ label: string; kind: keyof typeof TRACE_COLORS }> = [
  { label: "Read", kind: "read" },
  { label: "Write", kind: "write" },
  { label: "Edit", kind: "edit" },
  { label: "Execute", kind: "execute" },
  { label: "Diagnostic", kind: "diagnostic" },
  { label: "Render", kind: "render" },
  { label: "Shell", kind: "shell" },
  { label: "Navigate", kind: "nav" },
];

export const RELATIONSHIP_LEGEND: Array<{ label: string; kind: EdgeKind }> = [
  { label: "API call", kind: "api" },
  { label: "Event", kind: "event" },
  { label: "Data", kind: "data" },
  { label: "Config ref", kind: "config" },
];

export const RELATIONSHIP_KIND_LABELS: Partial<Record<EdgeKind, string>> = Object.fromEntries(
  RELATIONSHIP_LEGEND.map(({ label, kind }) => [kind, label]),
);

export const SYMBOL_RELATION_LEGEND: Array<{ label: string; relation: SymbolRelation }> = [
  { label: "Reference", relation: "reference" },
  { label: "Call", relation: "call" },
  { label: "Implements", relation: "implements" },
  { label: "Extends", relation: "extends" },
];

/** Unicode stand-ins for the renderer's role-mark silhouettes (file-role.ts),
    close enough in shape that the legend teaches the on-canvas mark. */
export const ROLE_MARK_LEGEND: Array<{ role: FileRole; glyph: string }> = [
  { role: "test", glyph: "△" },
  { role: "config", glyph: "▢" },
  { role: "docs", glyph: "≡" },
  { role: "styles", glyph: "◆" },
  { role: "types", glyph: "‹" },
  { role: "entry", glyph: "✦" },
  { role: "data", glyph: "▤" },
  { role: "assets", glyph: "○" },
];

export const ROLE_MARK_GLYPHS: Partial<Record<FileRole, string>> = Object.fromEntries(
  ROLE_MARK_LEGEND.map(({ role, glyph }) => [role, glyph]),
);





// The map is frequently used with workspaces that have dozens of meaningful
// folders/codebases. Keep the complete graph available, and raise each visual
// projection cap enough that the rail and overview do not silently hide most of
// the architecture. Label collision handling still decides what fits on screen.
export const MAX_NEIGHBORHOOD_LABELS = 40;
export const MAX_TERRITORY_RAIL_ITEMS = 32;
export const MAX_MINIMAP_TERRITORIES = 24;

export function relationshipKindLabel(kind: EdgeKind): string {
  return RELATIONSHIP_KIND_LABELS[kind] ?? kind;
}

export function relationshipColor(edge: GraphEdge): string {
  return cssColor(RELATIONSHIP_EDGE_COLORS[edge.kind] ?? 0x8fa9d6);
}

export function servicePeerLabel(edge: GraphEdge, node: GraphNode): string {
  const peer = edge.from === node.id ? edge.serviceTo ?? edge.to : edge.serviceFrom ?? edge.from;
  return peer.replace(/^svc:/, "");
}

export function useViewport(ref: React.RefObject<HTMLDivElement | null>): Viewport {
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return viewport;
}

/** Compact relative age for a commit epoch (seconds); null when unknown. */
export function commitAge(sec?: number): string | null {
  if (!sec) return null;
  const days = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function compactDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** Read once at load, like the renderer: the Map key's motion previews honour
    the OS reduced-motion preference. */
export const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
