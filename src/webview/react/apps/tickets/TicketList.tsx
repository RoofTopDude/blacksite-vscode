/* The grouped, windowed ticket list.
 *
 * Two things here exist specifically because the queue is allowed to reach several hundred:
 *
 * 1. Rendering is windowed. Only the first `PAGE` rows across all groups are mounted, and the
 *    window grows when a sentinel near the bottom scrolls into view. Not virtualization —
 *    variable-height group headers make that a worse trade here — but it keeps the initial
 *    mount flat regardless of queue size, and scrolling never hits a wall.
 *
 * 2. Group headers are sticky and collapsible, and collapsed groups cost nothing. A queue where
 *    "Done" holds two hundred closed tickets should feel exactly like one where it holds two.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./icons";
import { TicketRow } from "./TicketRow";
import { groupTickets, sortTickets, type Filters, type TicketGroup } from "./query";
import type { ResolvedTerritory, Ticket, TicketStatus } from "./types";

const PAGE = 60;
/** Closed work is history: present, but never the thing you scroll past to reach the work. */
const COLLAPSED_BY_DEFAULT: string[] = ["done", "cancelled"];

export interface TicketListProps {
  tickets: readonly Ticket[];
  territory: Record<string, ResolvedTerritory>;
  filters: Filters;
  selected: string | null;
  cursor: string | null;
  onOpen: (id: string) => void;
  /** Rank map for manual sort — the document order the board's drag writes. */
  rank: Map<string, number>;
  onDropOnGroup?: (ticketId: string, status: TicketStatus) => void;
  emptyMessage?: React.ReactNode;
  /** Reports the flat, ordered id list so the parent's j/k can walk exactly what is displayed. */
  onOrderChange?: (ids: string[]) => void;
}

export function TicketList({
  tickets, territory, filters, selected, cursor, onOpen, rank, onDropOnGroup, emptyMessage, onOrderChange,
}: TicketListProps) {
  const [collapsed, setCollapsed] = useState<string[]>(COLLAPSED_BY_DEFAULT);
  const [limit, setLimit] = useState(PAGE);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const groups: TicketGroup[] = useMemo(() => {
    const grouped = groupTickets(tickets, filters.groupBy);
    return grouped
      .map((group) => ({ ...group, tickets: sortTickets(group.tickets, filters.sortBy, rank) }))
      /* Empty status/priority groups stay (a column that vanishes when it empties makes the
         list jump as you work); empty open-vocabulary groups never existed in the first place. */
      .filter((group) => group.tickets.length > 0 || group.status !== undefined);
  }, [tickets, filters.groupBy, filters.sortBy, rank]);

  const order = useMemo(() => (
    groups.filter((group) => !collapsed.includes(group.key)).flatMap((group) => group.tickets.map((t) => t.id))
  ), [groups, collapsed]);

  useEffect(() => { onOrderChange?.(order); }, [order, onOrderChange]);
  // A changed filter is a new list; keeping the old window would silently hide matches that
  // sort above what was already loaded.
  useEffect(() => { setLimit(PAGE); }, [filters.query, filters.scope, filters.groupBy, filters.sortBy]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((value) => value + PAGE);
    }, { root: scrollRef.current, rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The keyboard cursor must stay on screen even though nothing focused it.
  useEffect(() => {
    if (!cursor) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-ticket-id="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const totalShown = groups.reduce((sum, group) => sum + (collapsed.includes(group.key) ? 0 : group.tickets.length), 0);
  let budget = limit;

  if (totalShown === 0 && groups.every((group) => group.tickets.length === 0)) {
    return <div ref={scrollRef} className="ticket-list is-empty">{emptyMessage}</div>;
  }

  return (
    <div ref={scrollRef} className="ticket-list">
      {groups.map((group) => {
        const isCollapsed = collapsed.includes(group.key);
        const slice = isCollapsed ? [] : group.tickets.slice(0, Math.max(0, budget));
        if (!isCollapsed) budget -= slice.length;
        const droppable = Boolean(onDropOnGroup) && group.status !== undefined;

        return (
          <section
            key={group.key}
            className={cn("ticket-group", isCollapsed && "is-collapsed", dragOver === group.key && "is-drag-over")}
            onDragOver={droppable ? (event) => { event.preventDefault(); setDragOver(group.key); } : undefined}
            onDragLeave={droppable ? () => setDragOver((current) => (current === group.key ? null : current)) : undefined}
            onDrop={droppable ? (event) => {
              event.preventDefault();
              setDragOver(null);
              const id = event.dataTransfer.getData("text/plain");
              if (id && group.status) onDropOnGroup?.(id, group.status);
            } : undefined}
          >
            <button
              type="button"
              className="ticket-group-head"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((current) => (
                current.includes(group.key) ? current.filter((key) => key !== group.key) : [...current, group.key]
              ))}
            >
              <ChevronRight className={cn("disclosure size-3", !isCollapsed && "rotate-90")} />
              {group.status && <StatusIcon status={group.status} size={13} />}
              <span className="ticket-group-title">{group.label}</span>
              <span className="ticket-group-count">{group.tickets.length}</span>
            </button>

            {!isCollapsed && (
              <div className="ticket-group-body">
                {slice.map((ticket) => (
                  <div key={ticket.id} data-ticket-id={ticket.id}>
                    <TicketRow
                      ticket={ticket}
                      resolved={territory[ticket.id]}
                      selected={selected === ticket.id}
                      cursor={cursor === ticket.id}
                      hideStatus={filters.groupBy === "status"}
                      onOpen={() => onOpen(ticket.id)}
                      onDragStart={onDropOnGroup ? (event) => {
                        event.dataTransfer.setData("text/plain", ticket.id);
                        event.dataTransfer.effectAllowed = "move";
                      } : undefined}
                    />
                  </div>
                ))}
                {group.tickets.length === 0 && (
                  <div className="ticket-group-empty">Nothing in {group.label.toLowerCase()}</div>
                )}
                {slice.length < group.tickets.length && (
                  <button type="button" className="ticket-group-more" onClick={() => setLimit((value) => value + PAGE)}>
                    Show {Math.min(PAGE, group.tickets.length - slice.length)} more
                    <span className="opacity-50"> · {group.tickets.length - slice.length} remaining</span>
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
    </div>
  );
}
