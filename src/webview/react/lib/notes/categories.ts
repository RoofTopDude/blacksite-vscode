/* Display metadata for note categories and relation kinds — pure data, no DOM,
   shared by the Notes timeline (NotesApp) and the Map's NodeCard so a note's
   badges read identically on both surfaces. Icon components are chosen at the
   call site (lucide-react); this module only owns label/color/description. */

import type { NoteCategory, RelationKind } from "@/lib/graph/protocol";
import { NOTE_CATEGORIES, RELATION_KINDS } from "@/lib/graph/protocol";

export { NOTE_CATEGORIES, RELATION_KINDS };
export type { NoteCategory, RelationKind };

export interface CategoryMeta {
  label: string;
  /** CSS class suffix — see .notes-category-badge-{suffix} in theme.css. */
  className: string;
  description: string;
}

export const CATEGORY_META: Record<NoteCategory, CategoryMeta> = {
  architecture: { label: "Architecture", className: "architecture", description: "A file's role or a design decision's rationale" },
  gotcha: { label: "Gotcha", className: "gotcha", description: "A non-obvious constraint or pitfall" },
  todo: { label: "Todo", className: "todo", description: "Known debt or follow-up work" },
  risk: { label: "Risk", className: "risk", description: "Fragility, security, or correctness concern" },
  question: { label: "Question", className: "question", description: "An open question worth flagging" },
};

export const RELATION_KIND_LABELS: Record<RelationKind, string> = {
  import: "Import",
  api: "API call",
  event: "Event flow",
  data: "Shared data",
  config: "Config link",
  call: "Call",
  reference: "Reference",
  inheritance: "Inheritance",
  other: "Relation",
};

export function categoryMeta(category: NoteCategory | undefined): CategoryMeta | undefined {
  return category ? CATEGORY_META[category] : undefined;
}

export function relationKindLabel(kind: RelationKind | undefined): string | undefined {
  return kind ? RELATION_KIND_LABELS[kind] : undefined;
}
