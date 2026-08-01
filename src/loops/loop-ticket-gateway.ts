/**
 * The loop's view of the ticket world.
 *
 * Deliberately the narrowest surface that works: read the queue, move a ticket to `review`,
 * leave a note. There is no method here that closes a ticket, and that is the point — under
 * `user_review` closure the rule "a loop never closes a ticket" is enforced by the absence of
 * the capability rather than by everyone remembering not to call it.
 */

import type { LoopTicketGateway } from "./loop-supervisor.js";
import type { Ticket, TicketContext, TicketStore } from "../ticket-store.js";

/** How much of a lane's answer is carried onto the ticket. Enough for a reviewer to judge
 *  without opening the transcript; not so much that the ticket becomes the transcript. */
const REVIEW_NOTE_LIMIT = 2000;
const ATTEMPT_NOTE_LIMIT = 1200;

export class TicketStoreLoopGateway implements LoopTicketGateway {
  constructor(
    private readonly _store: TicketStore,
    private readonly _indexedFiles: () => string[],
    /** Attributed to the loop rather than a chat session, so the ticket timeline shows who
     *  actually moved it. */
    private readonly _sessionId: () => string = () => "loop",
  ) {}

  tickets(): readonly Ticket[] {
    return this._store.read().tickets;
  }

  indexedFiles(): readonly string[] {
    return this._indexedFiles();
  }

  moveToReview(ticketId: string, note: string): void {
    this._update(ticketId, {
      status: "review",
      note: note.slice(0, REVIEW_NOTE_LIMIT),
    });
  }

  noteAttempt(ticketId: string, note: string): void {
    // No status change. A failed or interrupted attempt leaves the ticket where it was — the
    // scheduler's retention rule is what keeps it in the queue, not a status flag.
    this._update(ticketId, { note: note.slice(0, ATTEMPT_NOTE_LIMIT) });
  }

  private _update(ticketId: string, payload: { status?: string; note: string }): void {
    // Not "webview": TicketStore reads that as the user acting, and a loop is not the user.
    // Landing as an "agent" actor also means the store's own guard against agents closing
    // tickets applies to loop lanes, which is exactly the posture we want.
    const context: TicketContext = { sessionId: this._sessionId() };
    try {
      this._store.updateTicket({
        ticketId,
        ...(payload.status ? { status: payload.status } : {}),
        comment: payload.note,
      }, context);
    } catch {
      // Bookkeeping only. A ticket store that cannot be written is a problem, but it is not a
      // reason to tear down a loop that is otherwise making progress — the iteration record in
      // loops.json is the authoritative account of what ran either way.
    }
  }
}
