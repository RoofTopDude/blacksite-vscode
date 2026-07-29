/* The modal that files a ticket, and the same modal editing an existing one.
 *
 * One dialog for both because the shape of a ticket doesn't change between being created and
 * being corrected — and a "new" form that offers fewer fields than the editor teaches people to
 * file thin tickets and fix them later, which they then don't.
 *
 * Escape closes, Cmd/Ctrl+Enter commits from anywhere inside, and focus is trapped while it is
 * open. Nothing here posts until commit: a half-typed ticket is not a ticket.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/bridge";
import {
  TicketForm, draftToPayload, emptyDraft, draftFromTicket, type TicketDraft,
} from "./TicketForm";
import type { LinkablePlan, Ticket, TicketStatus } from "./types";

export function TicketDialog({ mode, ticket, plans, defaults, compact, onClose }: {
  mode: "create" | "edit";
  ticket?: Ticket;
  plans: LinkablePlan[];
  /** Seeds a new ticket from the surface it was opened on — the board's per-column "+"
   *  should not make you re-pick the column you just clicked. */
  defaults?: Partial<TicketDraft>;
  compact?: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TicketDraft>(() => (
    ticket ? draftFromTicket(ticket) : { ...emptyDraft(), ...defaults }
  ));
  const [dirty, setDirty] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canCommit = draft.title.trim().length > 0;

  const commit = useCallback(() => {
    if (!draft.title.trim()) return;
    const payload = draftToPayload(draft);
    if (mode === "edit" && ticket) post({ type: "update_ticket", ticketId: ticket.id, ...payload });
    else post({ type: "file_ticket", origin: "user", ...payload });
    onClose();
  }, [draft, mode, ticket, onClose]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        /* An open token list swallows its own Escape (it stops propagation before the event
           leaves React's root), so the first press closes the list and only the second reaches
           here. Escape never skips a level. */
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, onClose]);

  // Focus moves into the dialog on open so the first keystroke lands in the title, and the
  // page behind it stops scrolling under the overlay.
  useEffect(() => {
    const timer = setTimeout(() => {
      surfaceRef.current?.querySelector<HTMLTextAreaElement>(".ticket-form-title")?.focus();
    }, 10);
    return () => clearTimeout(timer);
  }, []);

  function update(next: TicketDraft): void {
    setDraft(next);
    setDirty(true);
  }

  return (
    <div className="ticket-modal-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={surfaceRef}
        className="ticket-modal reveal-in"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "edit" ? `Edit ${ticket?.id}` : "New ticket"}
      >
        <header className="ticket-modal-head">
          <span className="eyebrow">{mode === "edit" ? "Edit ticket" : "New ticket"}</span>
          {ticket && <span className="ticket-id">{ticket.id}</span>}
          <span className="flex-1" />
          <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-3.5" />
          </Button>
        </header>

        <div className="ticket-modal-body">
          <TicketForm draft={draft} onChange={update} plans={plans} selfId={ticket?.id} compact={compact} />
        </div>

        <footer className="ticket-modal-foot">
          <span className="ticket-modal-hint">
            {canCommit
              ? <><kbd>⌘</kbd><kbd>↵</kbd> to {mode === "edit" ? "save" : "file"}</>
              : "A title is all it takes to file one."}
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="xs" disabled={!canCommit || (mode === "edit" && !dirty)} onClick={commit}>
            {mode === "edit" ? "Save changes" : "File ticket"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/**
 * The one-line filing bar.
 *
 * Filing has to survive being a two-second act, so the fast path is a single input: type a
 * title, press Enter, it lands. "More…" hands the same text to the full dialog when the ticket
 * turns out to deserve it — the point is that you don't have to decide which kind of ticket it
 * is before you start typing.
 */
export function QuickFile({ status, onExpand }: {
  status?: TicketStatus;
  onExpand: (seed: Partial<TicketDraft>) => void;
}) {
  const [title, setTitle] = useState("");

  function submit(): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    post({ type: "file_ticket", origin: "user", title: trimmed, status: status ?? "backlog" });
    setTitle("");
  }

  return (
    <div className="quick-file">
      <span className="quick-file-plus" aria-hidden="true">+</span>
      <input
        className="quick-file-input"
        placeholder="File a ticket…"
        aria-label="File a ticket"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onExpand({ title: title.trim(), ...(status ? { status } : {}) });
            setTitle("");
            return;
          }
          if (event.key === "Enter") { event.preventDefault(); submit(); }
        }}
      />
      <button
        type="button"
        className="quick-file-more"
        title="Open the full form (⌘↵)"
        onClick={() => { onExpand({ title: title.trim(), ...(status ? { status } : {}) }); setTitle(""); }}
      >
        More…
      </button>
    </div>
  );
}
