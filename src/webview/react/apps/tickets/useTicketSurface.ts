/* Everything the sidebar and the board both need to be a working queue: the pushed state, the
 * filter set (persisted across tab-aways), the selection and keyboard cursor, and the transient
 * notices the host sends back when it rejects an edit.
 *
 * Living in a hook rather than duplicated in two components is not just tidiness — the two
 * surfaces are meant to feel like one product at two densities, and a keyboard shortcut that
 * works in the board but not the sidebar is exactly the kind of drift that stops being true.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onMessage, post, readUiState, writeUiState } from "@/lib/bridge";
import { DEFAULT_FILTERS, applyFilters, type Filters, type Scope } from "./query";
import { EMPTY_STATE, isOpen, readTicketsState, type Ticket, type TicketsState } from "./types";

export interface TicketSurface {
  state: TicketsState;
  filters: Filters;
  setFilters: (filters: Filters) => void;
  visible: Ticket[];
  counts: Record<Scope, number>;
  rank: Map<string, number>;
  byId: Map<string, Ticket>;
  selected: string | null;
  select: (id: string | null) => void;
  cursor: string | null;
  setCursor: (id: string | null) => void;
  /** The displayed order, reported up from the list so j/k walks exactly what is on screen. */
  setOrder: (ids: string[]) => void;
  order: string[];
  notice: string | null;
  dismissNotice: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** True the first time state arrives, so an empty queue and a not-yet-loaded one differ. */
  loaded: boolean;
}

export function useTicketSurface(storageKey: string): TicketSurface {
  const [state, setState] = useState<TicketsState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFiltersRaw] = useState<Filters>(() => readUiState(storageKey, DEFAULT_FILTERS));
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [order, setOrderState] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const setFilters = useCallback((next: Filters) => {
    setFiltersRaw(next);
    writeUiState(storageKey, next);
  }, [storageKey]);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === "tickets_state") {
        setState(readTicketsState(msg));
        setLoaded(true);
        return;
      }
      if (msg.type === "ticket_error") {
        setNotice(String(msg.message ?? ""));
        return;
      }
      if (msg.type === "focus_ticket" && typeof msg.ticketId === "string") {
        setSelected(msg.ticketId);
        setCursor(msg.ticketId);
      }
    });
    post({ type: "ready" });
    return off;
  }, []);

  // A rejection notice is information, not an alert; it retires itself rather than accumulating
  // a stack of dismissals the user has to clear.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const rank = useMemo(
    () => new Map(state.tickets.map((ticket, index) => [ticket.id, index])),
    [state.tickets],
  );
  const byId = useMemo(() => new Map(state.tickets.map((ticket) => [ticket.id, ticket])), [state.tickets]);
  const visible = useMemo(() => applyFilters(state.tickets, filters), [state.tickets, filters]);

  const counts = useMemo<Record<Scope, number>>(() => ({
    open: state.tickets.filter((ticket) => isOpen(ticket.status)).length,
    active: state.tickets.filter((ticket) => ticket.status === "in_progress" || ticket.status === "review").length,
    triage: state.tickets.filter((ticket) => ticket.status === "triage").length,
    mine: state.tickets.filter((ticket) => ticket.assignee === "user" && isOpen(ticket.status)).length,
    all: state.tickets.length,
  }), [state.tickets]);

  /* A selection whose ticket was deleted (or filtered away by someone else's edit) must not
     leave the detail pane rendering a ghost. */
  useEffect(() => {
    if (selected && !byId.has(selected)) setSelected(null);
    if (cursor && !byId.has(cursor)) setCursor(null);
  }, [byId, selected, cursor]);

  const setOrder = useCallback((ids: string[]) => {
    setOrderState((current) => (
      current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids
    ));
  }, []);

  return {
    state, filters, setFilters, visible, counts, rank, byId,
    selected, select: setSelected, cursor, setCursor, setOrder, order,
    notice, dismissNotice: () => setNotice(null), searchRef, loaded,
  };
}

/**
 * The keyboard layer, shared by both surfaces.
 *
 * Scoped to the panel rather than bound globally: these are single-letter keys, and a webview
 * that swallows "c" while the user is typing in the editor next to it would be hostile. Every
 * handler bails out when focus is in a text field.
 */
export function useTicketKeys(surface: TicketSurface, actions: {
  onCreate: () => void;
  onEdit?: () => void;
  onMove?: (ticketId: string, direction: 1 | -1) => void;
  onPriority?: (ticketId: string, index: number) => void;
  /** False while a modal owns the keyboard — otherwise "c" inside the editor would open a
   *  second one the moment focus left a text field. */
  enabled?: boolean;
}): void {
  const { order, cursor, setCursor, selected, select, searchRef } = surface;
  // Callers build this object inline every render; holding it in a ref keeps the listener from
  // being torn down and re-added on each one.
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (latest.current.enabled === false) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable));

      if (typing) {
        if (event.key === "Escape") target?.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        if ((event.metaKey || event.ctrlKey) && event.key === "f") {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
        return;
      }

      switch (event.key) {
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case "c":
          event.preventDefault();
          latest.current.onCreate();
          return;
        case "e":
          if (selected && latest.current.onEdit) { event.preventDefault(); latest.current.onEdit(); }
          return;
        case "Escape":
          if (selected) { event.preventDefault(); select(null); }
          return;
        case "Enter":
          if (cursor) { event.preventDefault(); select(cursor); }
          return;
        case "j":
        case "ArrowDown": {
          if (order.length === 0) return;
          event.preventDefault();
          const index = cursor ? order.indexOf(cursor) : -1;
          setCursor(order[Math.min(index + 1, order.length - 1)] ?? order[0] ?? null);
          return;
        }
        case "k":
        case "ArrowUp": {
          if (order.length === 0) return;
          event.preventDefault();
          const index = cursor ? order.indexOf(cursor) : 0;
          setCursor(order[Math.max(index - 1, 0)] ?? null);
          return;
        }
        case "[":
        case "]": {
          const id = selected ?? cursor;
          if (!id || !latest.current.onMove) return;
          event.preventDefault();
          latest.current.onMove(id, event.key === "]" ? 1 : -1);
          return;
        }
        default:
          if (/^[1-4]$/.test(event.key)) {
            const id = selected ?? cursor;
            if (!id || !latest.current.onPriority) return;
            event.preventDefault();
            latest.current.onPriority(id, Number(event.key) - 1);
          }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, cursor, setCursor, selected, select, searchRef]);
}
