import { useState } from "react";

export interface TerritoryChipsProps {
  /** Workspace-relative Codebase Map node ids. */
  files: string[];
  /** Leading label; omit for none. */
  label?: string;
  /** How many chips to show before collapsing behind a "+N more" control. */
  collapseAfter?: number;
  onOpenFile: (path: string) => void;
  onRevealOnMap: (path: string) => void;
}

/**
 * A set of workspace files rendered as two-part chips: the name opens the file in an
 * editor, the ◎ flies the Codebase Map's camera to its star.
 *
 * Shared between a plan phase's declared map territory and (next) a ticket's, so the two
 * cannot drift apart — the interaction is the thing that makes declared territory read as
 * a place in the codebase rather than a list of intentions, and it should feel identical
 * wherever it appears.
 */
export function TerritoryChips({
  files,
  label,
  collapseAfter = 6,
  onOpenFile,
  onRevealOnMap,
}: TerritoryChipsProps) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const shown = expanded ? files : files.slice(0, collapseAfter);
  const hidden = files.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {label && <span className="opacity-70">{label}</span>}
      {shown.map((file) => (
        <span key={file} className="inline-flex items-center overflow-hidden rounded-full bg-white/10 font-mono text-xs">
          <button
            type="button"
            className="px-1.5 py-px hover:bg-white/10"
            title={`Open ${file}`}
            onClick={() => onOpenFile(file)}
          >
            {file.split("/").pop()}
          </button>
          <button
            type="button"
            className="border-l border-white/15 px-1.5 py-px hover:bg-white/10"
            title={`Show ${file} on the Codebase Map`}
            onClick={() => onRevealOnMap(file)}
          >
            ◎
          </button>
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" className="px-1 text-xs underline opacity-70 hover:opacity-100" onClick={() => setExpanded(true)}>
          +{hidden} more
        </button>
      )}
    </div>
  );
}
