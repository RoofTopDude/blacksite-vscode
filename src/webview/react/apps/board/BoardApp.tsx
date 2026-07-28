import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/PanelHeader";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatRelativeTime } from "@/lib/format";
import { post, onMessage } from "@/lib/bridge";
import {
  byPriority, PRIORITY_ORDER, STATUS_ORDER,
  type ResolvedTerritory, type Ticket, type TicketPriority, type TicketStatus,
} from "../tickets/types";

interface State {
  tickets: Ticket[];
  territory: Record<string, ResolvedTerritory>;
  dropped: number;
}

const EMPTY: State = { tickets: [], territory: {}, dropped: 0 };

/** "done" is collapsed by default and windowed — a board that grows forever stops being one. */
const COLLAPSED_BY_DEFAULT: TicketStatus[] = ["done", "cancelled"];
const DONE_WINDOW = 12;

const COLUMN_LABEL: Record<TicketStatus, string> = {
  triage: "Triage",
  backlog: "Backlog",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

function PriorityMark({ priority }: { priority: TicketPriority }) {
  if (priority === "normal") return null;
  const label = `${priority} priority`;
  if (priority === "low") return <span className="ticket-priority is-low" title={label}>○</span>;
  return <span className={`ticket-priority is-${priority}`} title={label}>●</span>;
}

function BoardCard(
  { ticket, resolved, selected, onSelect, onDragStart }: {
    ticket: Ticket;
    resolved?: ResolvedTerritory;
    selected: boolean;
    onSelect: () => void;
    onDragStart: (event: React.DragEvent) => void;
  },
) {
  const territoryCount = ticket.territory.files.length + ticket.territory.areas.length;
  const comments = ticket.events?.filter((event) => event.kind === "comment").length ?? 0;
  const stale = resolved?.staleFiles.length ?? 0;
  const first = ticket.territory.files[0] ?? ticket.territory.areas[0];

  return (
    <article
      className={`board-card is-${ticket.priority} ${selected ? "is-selected" : ""}`}
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}
    >
      <div className="board-card-head">
        <PriorityMark priority={ticket.priority} />
        <span className="ticket-id">{ticket.id}</span>
        <span className="flex-1" />
        {ticket.planId && <span className="ticket-plan" title={`Plan ${ticket.planId}`}>⧉</span>}
        {comments > 0 && <span className="board-card-meta" title={`${comments} comments`}>💬{comments}</span>}
      </div>
      <div className="board-card-title">{ticket.title}</div>
      {first && (
        <button
          type="button"
          className="board-card-territory"
          title={`Show ${first} on the Codebase Map`}
          onClick={(event) => { event.stopPropagation(); post({ type: "show_on_map", path: first }); }}
        >
          ◎ {first.split("/").pop()}
          {territoryCount > 1 && <span className="opacity-60"> +{territoryCount - 1}</span>}
          {stale > 0 && <span className="ticket-area-warn" title={`${stale} stale`}> ⚠</span>}
        </button>
      )}
      <div className="board-card-foot">
        {ticket.labels.slice(0, 3).map((label) => <span key={label} className="ticket-label">{label}</span>)}
        <span className="flex-1" />
        {ticket.complexity && <span className="board-card-meta">{ticket.complexity}</span>}
        <span className="board-card-meta">{formatRelativeTime(Date.parse(ticket.updatedAt))}</span>
      </div>
      {ticket.blockedBy.length > 0 && (
        <div className="board-card-blocked" title={`Blocked by ${ticket.blockedBy.join(", ")}`}>
          ⛔ {ticket.blockedBy.join(", ")}
        </div>
      )}
    </article>
  );
}

export function BoardApp() {
  const [state, setState] = useState<State>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TicketStatus | null>(null);
  const [collapsed, setCollapsed] = useState<TicketStatus[]>(COLLAPSED_BY_DEFAULT);
  const [query, setQuery] = useState("");
  const dragged = useRef<string | null>(null);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type !== "tickets_state") return;
      setState({
        tickets: Array.isArray(msg.tickets) ? msg.tickets : [],
        territory: msg.territory ?? {},
        dropped: Number(msg.dropped) || 0,
      });
    });
    post({ type: "ready" });
    return off;
  }, []);

  const columns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = state.tickets.filter((ticket) => (
      !needle
      || ticket.title.toLowerCase().includes(needle)
      || ticket.id.toLowerCase().includes(needle)
      || ticket.labels.some((label) => label.includes(needle))
    ));
    return STATUS_ORDER.map((status) => ({
      status,
      tickets: matching.filter((ticket) => ticket.status === status).sort(byPriority),
    }));
  }, [state.tickets, query]);

  const move = useCallback((ticketId: string, status: TicketStatus) => {
    post({ type: "update_ticket", ticketId, status });
  }, []);

  /* Board-scoped keyboard control. Deliberately not global bindings: this is a focused
     surface, and stealing workspace-level keys from the editor would be hostile. */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!selected) return;
      const ticket = state.tickets.find((candidate) => candidate.id === selected);
      if (!ticket) return;

      const columnIndex = STATUS_ORDER.indexOf(ticket.status);
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        const next = STATUS_ORDER[columnIndex + (event.key === "]" ? 1 : -1)];
        if (next) move(ticket.id, next);
        return;
      }
      if (/^[1-4]$/.test(event.key)) {
        event.preventDefault();
        const priority = PRIORITY_ORDER[Number(event.key) - 1];
        if (priority) post({ type: "update_ticket", ticketId: ticket.id, priority });
        return;
      }
      if (event.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, state.tickets, move]);

  const open = state.tickets.filter((ticket) => !COLLAPSED_BY_DEFAULT.includes(ticket.status));

  return (
    <div className="board-root flex h-full flex-col overflow-hidden">
      <header className="board-header living-panel-header shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PanelHeader
            eyebrow="Work queue"
            title="Board"
            sub="Durable outcomes across the project. Drag between columns, or select a card and use [ and ] to move it, 1–4 for priority."
            status={{ label: `${open.length} open`, tone: open.length ? "ok" : "idle" }}
          />
          <div className="flex items-center gap-2">
            <Input
              className="w-56"
              placeholder="Filter by title, id, or label…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button size="xs" variant="outline" onClick={() => post({ type: "refresh" })}>Refresh</Button>
          </div>
        </div>
      </header>

      <main className="board-columns flex-1 overflow-x-auto overflow-y-hidden">
        {columns.map(({ status, tickets }) => {
          const isCollapsed = collapsed.includes(status);
          const shown = status === "done" || status === "cancelled" ? tickets.slice(0, DONE_WINDOW) : tickets;
          return (
            <section
              key={status}
              className={`board-column ${dragOver === status ? "is-drag-over" : ""} ${isCollapsed ? "is-collapsed" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragOver(status); }}
              onDragLeave={() => setDragOver((current) => (current === status ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(null);
                const id = dragged.current ?? event.dataTransfer.getData("text/plain");
                if (id) move(id, status);
                dragged.current = null;
              }}
            >
              <button
                type="button"
                className="board-column-head"
                onClick={() => setCollapsed((current) => (
                  current.includes(status) ? current.filter((entry) => entry !== status) : [...current, status]
                ))}
              >
                <StatusBadge status={status} />
                <span className="board-column-count">{tickets.length}</span>
                <span className="flex-1" />
                <span className={`plan-phase-chevron ${isCollapsed ? "" : "is-open"}`} aria-hidden="true">⌄</span>
              </button>
              {!isCollapsed && (
                <div className="board-column-body">
                  {shown.length === 0 ? (
                    <div className="board-column-empty">Nothing in {COLUMN_LABEL[status].toLowerCase()}</div>
                  ) : shown.map((ticket) => (
                    <BoardCard
                      key={ticket.id}
                      ticket={ticket}
                      resolved={state.territory[ticket.id]}
                      selected={selected === ticket.id}
                      onSelect={() => setSelected((current) => (current === ticket.id ? null : ticket.id))}
                      onDragStart={(event) => {
                        dragged.current = ticket.id;
                        event.dataTransfer.setData("text/plain", ticket.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                    />
                  ))}
                  {tickets.length > shown.length && (
                    <div className="board-column-empty">+{tickets.length - shown.length} older</div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}
