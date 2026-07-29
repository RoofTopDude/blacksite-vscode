/* The board: the whole queue at editor-tab width.
 *
 * Two layouts over one filter set, because they answer different questions. Columns answer
 * "where is everything" and are where you drag work forward; the list answers "which one" and
 * is the layout that survives three hundred tickets — you cannot scan a column that is two
 * hundred cards tall. Switching between them keeps the search, the filters, and the selection,
 * so it costs nothing to look at the same set the other way.
 *
 * The detail pane sits beside both rather than replacing them: at this width, losing your place
 * in the queue every time you read a ticket is the thing that makes a tracker tiring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns3, List, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/PanelHeader";
import { post, readUiState, writeUiState } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { FilterBar } from "../tickets/FilterBar";
import { StatusIcon } from "../tickets/icons";
import { TicketDetail } from "../tickets/TicketDetail";
import { TicketDialog } from "../tickets/TicketDialog";
import { TicketCard } from "../tickets/TicketCard";
import { TicketList } from "../tickets/TicketList";
import { sortTickets } from "../tickets/query";
import { useTicketKeys, useTicketSurface } from "../tickets/useTicketSurface";
import type { TicketDraft } from "../tickets/TicketForm";
import { PRIORITY_ORDER, STATUS_LABEL, STATUS_ORDER, type TicketStatus } from "../tickets/types";

type View = "board" | "list";

/** Closed work is history: on the board it is collapsed and windowed, because a Done column
 *  that grows forever stops being a column and starts being a scroll. */
const COLLAPSED_BY_DEFAULT: TicketStatus[] = ["done", "cancelled"];
const DONE_WINDOW = 15;

export function BoardApp() {
  const surface = useTicketSurface("board.filters");
  const { state, filters, setFilters, visible, counts, rank, byId, selected, select, cursor } = surface;
  const [view, setView] = useState<View>(() => readUiState<{ view: View }>("board.view", { view: "board" }).view);
  const [collapsed, setCollapsed] = useState<TicketStatus[]>(COLLAPSED_BY_DEFAULT);
  const [dragOver, setDragOver] = useState<TicketStatus | null>(null);
  const [dialog, setDialog] = useState<null | { mode: "create" | "edit"; seed?: Partial<TicketDraft> }>(null);
  const dragged = useRef<string | null>(null);

  const ticket = selected ? byId.get(selected) : undefined;
  const openCreate = useCallback((seed?: Partial<TicketDraft>) => setDialog({ mode: "create", seed }), []);

  const move = useCallback((ticketId: string, status: TicketStatus) => {
    post({ type: "update_ticket", ticketId, status });
  }, []);

  useTicketKeys(surface, {
    enabled: dialog === null,
    onCreate: () => openCreate(),
    onEdit: () => { if (selected) setDialog({ mode: "edit" }); },
    onMove: (ticketId, direction) => {
      const current = byId.get(ticketId);
      if (!current) return;
      const next = STATUS_ORDER[STATUS_ORDER.indexOf(current.status) + direction];
      if (next) move(ticketId, next);
    },
    onPriority: (ticketId, index) => {
      const priority = PRIORITY_ORDER[index];
      if (priority) post({ type: "update_ticket", ticketId, priority });
    },
  });

  const columns = useMemo(() => STATUS_ORDER.map((status) => ({
    status,
    tickets: sortTickets(visible.filter((entry) => entry.status === status), filters.sortBy, rank),
  })), [visible, filters.sortBy, rank]);

  /* In list view the list reports its own order; in board view nothing else knows it, and
     without it j/k has nothing to walk. Collapsed columns are skipped for the same reason a
     collapsed group is: the cursor must never land somewhere invisible. */
  const boardOrder = useMemo(() => (
    view === "board"
      ? columns.filter((column) => !collapsed.includes(column.status)).flatMap((column) => column.tickets.map((entry) => entry.id))
      : null
  ), [view, columns, collapsed]);

  const setOrder = surface.setOrder;
  useEffect(() => { if (boardOrder) setOrder(boardOrder); }, [boardOrder, setOrder]);

  useEffect(() => {
    if (view !== "board" || !cursor) return;
    document.querySelector<HTMLElement>(`[data-ticket-id="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view, cursor]);

  function setViewPersisted(next: View): void {
    setView(next);
    writeUiState("board.view", { view: next });
  }

  return (
    <div className="board-root flex h-full flex-col overflow-hidden">
      <header className="board-header living-panel-header shrink-0 border-b border-border px-4 pb-2 pt-3">
        <PanelHeader
          eyebrow="Work queue"
          title="Board"
          sub={<>Drag between columns, or use <kbd>j</kbd><kbd>k</kbd> to move, <kbd>↵</kbd> to open, <kbd>[</kbd><kbd>]</kbd> to advance, <kbd>1</kbd>–<kbd>4</kbd> for priority, <kbd>c</kbd> to file, <kbd>/</kbd> to search.</>}
          status={{ label: `${counts.open} open`, tone: counts.open ? "ok" : "idle", pulse: counts.triage > 0 }}
          actions={
            <>
              <div className="view-toggle" role="group" aria-label="Layout">
                <button
                  type="button"
                  className={cn("view-toggle-item", view === "board" && "is-active")}
                  aria-pressed={view === "board"}
                  title="Columns"
                  onClick={() => setViewPersisted("board")}
                >
                  <Columns3 className="size-3" />
                </button>
                <button
                  type="button"
                  className={cn("view-toggle-item", view === "list" && "is-active")}
                  aria-pressed={view === "list"}
                  title="List"
                  onClick={() => setViewPersisted("list")}
                >
                  <List className="size-3" />
                </button>
              </div>
              <Button size="icon-xs" variant="ghost" title="Refresh" onClick={() => post({ type: "refresh" })}>
                <RefreshCw className="size-3" />
              </Button>
              <Button size="xs" onClick={() => openCreate()}>
                <Plus className="size-3" /> New
              </Button>
            </>
          }
        />
      </header>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        counts={counts}
        labels={state.labels}
        shown={visible.length}
        total={state.tickets.length}
        searchRef={surface.searchRef}
      />

      {surface.notice && (
        <div className="ticket-notice" role="status">
          <span className="min-w-0 flex-1">{surface.notice}</span>
          <button type="button" aria-label="Dismiss" onClick={surface.dismissNotice}><X className="size-3" /></button>
        </div>
      )}

      <div className="board-split flex min-h-0 flex-1">
        {view === "board" ? (
          <main className="board-columns flex-1">
            {columns.map(({ status, tickets }) => {
              const isCollapsed = collapsed.includes(status);
              const windowed = status === "done" || status === "cancelled";
              const shown = windowed ? tickets.slice(0, DONE_WINDOW) : tickets;
              return (
                <section
                  key={status}
                  className={cn("board-column", dragOver === status && "is-drag-over", isCollapsed && "is-collapsed")}
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
                  <div className="board-column-head">
                    <button
                      type="button"
                      className="board-column-toggle"
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsed((current) => (
                        current.includes(status) ? current.filter((entry) => entry !== status) : [...current, status]
                      ))}
                    >
                      <StatusIcon status={status} size={13} />
                      <span className="board-column-title">{STATUS_LABEL[status]}</span>
                      <span className="board-column-count">{tickets.length}</span>
                    </button>
                    <span className="flex-1" />
                    <button
                      type="button"
                      className="board-column-add"
                      title={`File into ${STATUS_LABEL[status].toLowerCase()}`}
                      onClick={() => openCreate({ status })}
                    >
                      <Plus className="size-3" />
                    </button>
                  </div>

                  {!isCollapsed && (
                    <div className="board-column-body">
                      {shown.length === 0 ? (
                        <div className="board-column-empty">Nothing in {STATUS_LABEL[status].toLowerCase()}</div>
                      ) : shown.map((entry) => (
                        <div key={entry.id} data-ticket-id={entry.id}>
                          <TicketCard
                            ticket={entry}
                            resolved={state.territory[entry.id]}
                            selected={selected === entry.id}
                            cursor={cursor === entry.id}
                            onOpen={() => { select(entry.id); surface.setCursor(entry.id); }}
                            onDragStart={(event) => {
                              dragged.current = entry.id;
                              event.dataTransfer.setData("text/plain", entry.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                          />
                        </div>
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
        ) : (
          <main className="board-list flex-1 overflow-y-auto">
            <TicketList
              tickets={visible}
              territory={state.territory}
              filters={filters}
              selected={selected}
              cursor={cursor}
              rank={rank}
              onOpen={(id) => { select(id); surface.setCursor(id); }}
              onOrderChange={surface.setOrder}
              onDropOnGroup={(ticketId, status) => move(ticketId, status)}
              emptyMessage={<div className="ticket-empty">Nothing matches this view.</div>}
            />
          </main>
        )}

        {ticket && (
          <aside className="board-detail">
            <TicketDetail
              ticket={ticket}
              resolved={state.territory[ticket.id]}
              all={state.tickets}
              plans={state.plans}
              onClose={() => select(null)}
              onOpenTicket={(id) => select(id)}
              onEdit={() => setDialog({ mode: "edit" })}
            />
          </aside>
        )}
      </div>

      {dialog && (
        <TicketDialog
          mode={dialog.mode}
          ticket={dialog.mode === "edit" ? ticket : undefined}
          plans={state.plans}
          defaults={dialog.seed}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
