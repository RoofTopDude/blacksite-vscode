/* The board card: the same facts as a list row, stacked.
 *
 * A row ranges its metadata across fixed columns, which works because a list is as wide as the
 * window. A column is 270px, so the card stacks instead — id and flags on top, title in the
 * middle where the eye lands, everything else on a foot line. Same glyphs, same order of
 * importance, so moving between the two layouts costs no relearning.
 */

import { memo } from "react";
import { cn } from "@/lib/utils";
import { absoluteTime, shortRelative } from "./format";
import { AssigneeIcon, OriginMark, PriorityIcon } from "./icons";
import type { ResolvedTerritory, Ticket } from "./types";

export const TicketCard = memo(function TicketCard({
  ticket, resolved, selected, cursor, onOpen, onDragStart,
}: {
  ticket: Ticket;
  resolved?: ResolvedTerritory;
  selected: boolean;
  cursor: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent) => void;
}) {
  const comments = ticket.events?.filter((event) => event.kind === "comment").length ?? 0;
  const territory = ticket.territory.files.length + ticket.territory.areas.length;
  const stale = resolved?.staleFiles.length ?? 0;

  return (
    <article
      className={cn(
        "board-card",
        `is-${ticket.priority}`,
        selected && "is-selected",
        cursor && "is-cursor",
      )}
      draggable
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); }
      }}
    >
      <div className="board-card-head">
        <PriorityIcon priority={ticket.priority} size={12} />
        <span className="ticket-id">{ticket.id}</span>
        <span className="flex-1" />
        {ticket.duplicateOf && <span className="ticket-row-flag is-duplicate" title={`Duplicate of ${ticket.duplicateOf}`}>dup</span>}
        {ticket.planId && <span className="board-card-meta" title={`Plan ${ticket.planId}`}>⧉</span>}
        {comments > 0 && <span className="board-card-meta" title={`${comments} comments`}>✎{comments}</span>}
        <OriginMark origin={ticket.origin} />
      </div>

      <div className="board-card-title">{ticket.title}</div>

      {ticket.acceptanceCriteria.length > 0 && (
        <div className="board-card-criteria" title={ticket.acceptanceCriteria.join("\n")}>
          ☰ {ticket.acceptanceCriteria.length} acceptance criteri{ticket.acceptanceCriteria.length === 1 ? "on" : "a"}
        </div>
      )}

      <div className="board-card-foot">
        {ticket.labels.slice(0, 2).map((label) => <span key={label} className="ticket-label">{label}</span>)}
        {ticket.labels.length > 2 && <span className="ticket-label is-more">+{ticket.labels.length - 2}</span>}
        <span className="flex-1" />
        {territory > 0 && (
          <span className={cn("board-card-meta", stale > 0 && "is-warn")} title={`${territory} territory entries${stale > 0 ? `, ${stale} stale` : ""}`}>
            ◎{territory}
          </span>
        )}
        {ticket.complexity && <span className="board-card-meta">{ticket.complexity}</span>}
        <AssigneeIcon assignee={ticket.assignee} size={12} />
        <span className="board-card-meta" title={`Updated ${absoluteTime(ticket.updatedAt)}`}>
          {shortRelative(ticket.updatedAt)}
        </span>
      </div>

      {ticket.blockedBy.length > 0 && (
        <div className="board-card-blocked" title={`Blocked by ${ticket.blockedBy.join(", ")}`}>
          ⛔ {ticket.blockedBy.join(", ")}
        </div>
      )}
    </article>
  );
});
