/* One ticket, one line.
 *
 * Rows rather than cards, because the unit of work here is scanning: at three hundred tickets
 * the question is almost never "tell me about this one" and almost always "which of these is
 * the one I mean". Fixed columns in a fixed order mean the eye lands in the same place on every
 * row — priority, id, status, title, then the metadata that only matters once you've found it.
 *
 * Everything to the right of the title is progressively dropped as the surface narrows (the
 * sidebar is 300px wide), in reverse order of usefulness: timestamp last to go, labels first.
 */

import { memo } from "react";
import { cn } from "@/lib/utils";
import { absoluteTime, shortRelative } from "./format";
import { AssigneeIcon, OriginMark, PriorityIcon, StatusIcon } from "./icons";
import type { ResolvedTerritory, Ticket } from "./types";

export interface TicketRowProps {
  ticket: Ticket;
  resolved?: ResolvedTerritory;
  selected: boolean;
  /** Keyboard cursor, distinct from selection: j/k moves this without opening anything. */
  cursor?: boolean;
  onOpen: () => void;
  onDragStart?: (event: React.DragEvent) => void;
  /** Hides the status glyph inside a status-grouped list, where it would say nothing. */
  hideStatus?: boolean;
}

export const TicketRow = memo(function TicketRow({
  ticket, resolved, selected, cursor, onOpen, onDragStart, hideStatus,
}: TicketRowProps) {
  const comments = ticket.events?.filter((event) => event.kind === "comment").length ?? 0;
  const stale = resolved?.staleFiles.length ?? 0;
  const blocked = ticket.blockedBy.length > 0;
  const territory = ticket.territory.files.length + ticket.territory.areas.length;

  return (
    <div
      className={cn(
        "ticket-row",
        selected && "is-selected",
        cursor && "is-cursor",
        ticket.priority === "urgent" && "is-urgent",
        !ticket.title && "is-untitled",
      )}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); }
      }}
    >
      <PriorityIcon priority={ticket.priority} className="ticket-row-priority" />
      <span className="ticket-row-id">{ticket.id}</span>
      {!hideStatus && <StatusIcon status={ticket.status} className="ticket-row-status" />}

      <span className="ticket-row-title" title={ticket.title}>{ticket.title}</span>

      {ticket.duplicateOf && (
        <span className="ticket-row-flag is-duplicate" title={`Duplicate of ${ticket.duplicateOf}`}>dup</span>
      )}
      {blocked && (
        <span className="ticket-row-flag is-blocked" title={`Blocked by ${ticket.blockedBy.join(", ")}`}>
          blocked
        </span>
      )}

      <span className="ticket-row-labels">
        {ticket.labels.slice(0, 3).map((label) => (
          <span key={label} className="ticket-label" title={label}>{label}</span>
        ))}
        {ticket.labels.length > 3 && <span className="ticket-label is-more">+{ticket.labels.length - 3}</span>}
      </span>

      <span className="ticket-row-meta">
        {ticket.acceptanceCriteria.length > 0 && (
          <span className="ticket-row-chip" title={`${ticket.acceptanceCriteria.length} acceptance criteria`}>
            ☰{ticket.acceptanceCriteria.length}
          </span>
        )}
        {territory > 0 && (
          <span
            className={cn("ticket-row-chip", stale > 0 && "is-warn")}
            title={stale > 0
              ? `${territory} territory entries, ${stale} no longer in the index`
              : `${territory} territory entries`}
          >
            ◎{territory}
          </span>
        )}
        {comments > 0 && <span className="ticket-row-chip" title={`${comments} comments`}>✎{comments}</span>}
        {ticket.planId && <span className="ticket-row-chip" title={`Linked to plan ${ticket.planId}`}>⧉</span>}
        <OriginMark origin={ticket.origin} />
      </span>

      <AssigneeIcon assignee={ticket.assignee} className="ticket-row-assignee" />
      <time className="ticket-row-time" dateTime={ticket.updatedAt} title={`Updated ${absoluteTime(ticket.updatedAt)}`}>
        {shortRelative(ticket.updatedAt)}
      </time>
    </div>
  );
});
