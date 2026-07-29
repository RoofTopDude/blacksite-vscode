/* The sidebar queue.
 *
 * Same data and the same interaction language as the board, at sidebar density: rows instead of
 * columns, and the detail pane replaces the list rather than sitting beside it, because at
 * 300px wide there is no beside. What survives the narrowing is what matters — search, scope,
 * grouping, the keyboard, and every field of a ticket being reachable without leaving.
 */

import { useCallback, useState } from "react";
import { LayoutGrid, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/PanelHeader";
import { post } from "@/lib/bridge";
import { FilterBar } from "./FilterBar";
import { TicketDetail } from "./TicketDetail";
import { TicketDialog, QuickFile } from "./TicketDialog";
import { TicketList } from "./TicketList";
import { useTicketKeys, useTicketSurface } from "./useTicketSurface";
import type { TicketDraft } from "./TicketForm";
import { PRIORITY_ORDER, STATUS_ORDER } from "./types";

export function TicketsApp() {
  const surface = useTicketSurface("tickets.filters");
  const { state, filters, setFilters, visible, counts, rank, byId, selected, select, cursor } = surface;
  const [dialog, setDialog] = useState<null | { mode: "create" | "edit"; seed?: Partial<TicketDraft> }>(null);

  const openCreate = useCallback((seed?: Partial<TicketDraft>) => setDialog({ mode: "create", seed }), []);
  const ticket = selected ? byId.get(selected) : undefined;

  useTicketKeys(surface, {
    enabled: dialog === null,
    onCreate: () => openCreate(),
    onEdit: () => { if (selected) setDialog({ mode: "edit" }); },
    onMove: (ticketId, direction) => {
      const current = byId.get(ticketId);
      if (!current) return;
      const next = STATUS_ORDER[STATUS_ORDER.indexOf(current.status) + direction];
      if (next) post({ type: "update_ticket", ticketId, status: next });
    },
    onPriority: (ticketId, index) => {
      const priority = PRIORITY_ORDER[index];
      if (priority) post({ type: "update_ticket", ticketId, priority });
    },
  });

  const urgent = state.tickets.filter((entry) => (
    (entry.priority === "urgent" || entry.priority === "high") && entry.status !== "done" && entry.status !== "cancelled"
  )).length;

  return (
    <div className="tickets-root flex flex-1 flex-col overflow-hidden">
      {ticket ? (
        <TicketDetail
          ticket={ticket}
          resolved={state.territory[ticket.id]}
          all={state.tickets}
          plans={state.plans}
          onClose={() => select(null)}
          onOpenTicket={(id) => select(id)}
          onEdit={() => setDialog({ mode: "edit" })}
          onOpenInBoard={() => post({ type: "open_board", ticketId: ticket.id })}
        />
      ) : (
        <>
          <header className="tickets-header living-panel-header shrink-0 border-b border-border px-3 pb-2 pt-2.5">
            <PanelHeader
              eyebrow="Work queue"
              title="Tickets"
              status={{
                label: counts.open ? `${counts.open} open` : "Clear",
                tone: urgent > 0 ? "warn" : counts.open ? "ok" : "idle",
                pulse: counts.triage > 0,
              }}
              actions={
                <>
                  <Button size="icon-xs" variant="ghost" title="Open the board" onClick={() => post({ type: "open_board" })}>
                    <LayoutGrid className="size-3" />
                  </Button>
                  <Button size="icon-xs" variant="ghost" title="New ticket (c)" onClick={() => openCreate()}>
                    <Plus className="size-3.5" />
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
            compact
            searchRef={surface.searchRef}
          />

          {surface.notice && (
            <div className="ticket-notice" role="status">
              <span className="min-w-0 flex-1">{surface.notice}</span>
              <button type="button" aria-label="Dismiss" onClick={surface.dismissNotice}><X className="size-3" /></button>
            </div>
          )}

          {state.dropped > 0 && (
            <div className="ticket-hint is-warn mx-3 my-1.5">
              {state.dropped} malformed {state.dropped === 1 ? "entry" : "entries"} in tickets.json could not be read.
            </div>
          )}

          <main className="tickets-content flex-1 overflow-y-auto">
            <TicketList
              tickets={visible}
              territory={state.territory}
              filters={filters}
              selected={selected}
              cursor={cursor}
              rank={rank}
              onOpen={(id) => { select(id); surface.setCursor(id); }}
              onOrderChange={surface.setOrder}
              emptyMessage={
                filters.query || visible.length !== state.tickets.length ? (
                  <div className="ticket-empty">
                    Nothing matches. <button type="button" className="link-quiet" onClick={() => setFilters({ ...filters, query: "", scope: "all" })}>Search everything</button>
                  </div>
                ) : (
                  <div className="ticket-empty">
                    Nothing here. Work the agent notices but isn&apos;t asked to do lands in Triage,
                    so it stops getting lost in the transcript.
                  </div>
                )
              }
            />
          </main>

          <footer className="tickets-footer shrink-0 border-t border-border px-3 py-2">
            <QuickFile onExpand={(seed) => openCreate(seed)} />
          </footer>
        </>
      )}

      {dialog && (
        <TicketDialog
          mode={dialog.mode}
          ticket={dialog.mode === "edit" ? ticket : undefined}
          plans={state.plans}
          defaults={dialog.seed}
          compact
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
