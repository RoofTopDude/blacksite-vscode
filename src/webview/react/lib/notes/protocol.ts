/* Message contract between NotesTimelineProvider (src/notes-timeline-provider.ts)
   and the Map Notes timeline webview. Hand-mirrored per repo convention: the
   host types incoming messages loosely and coerces; this union is the single
   source of truth for shapes. Keep in sync with src/notes-timeline-provider.ts. */

import type { GraphAnnotation } from "@/lib/graph/protocol";

/** One commit touching a noted file, for the per-note git-history drawer. */
export interface NoteFileCommit {
  hash: string;
  subject: string;
  /** Epoch seconds of the commit. */
  at: number;
  author: string;
}

export type NotesHostMessage =
  | { type: "notes_state"; notes: GraphAnnotation[]; workspaceName: string }
  /** Response to a file_history request; `error` set when git couldn't answer
      (not a repo, file never committed, git absent). */
  | { type: "file_history"; path: string; commits: NoteFileCommit[]; error?: string };

export type NotesWebviewMessage =
  | { type: "ready" }
  | { type: "open_file"; path: string; line?: number }
  /** Focus the Map (sidebar view) and fly its camera to this file's star. */
  | { type: "reveal_on_map"; path: string }
  | { type: "remove_note"; id: string }
  /** Lazily fetch recent git commits touching one noted file. */
  | { type: "file_history"; path: string }
  /** Open VS Code's diff editor for one commit of a noted file (against its
      parent commit; the initial commit diffs against empty). */
  | { type: "open_commit_diff"; path: string; hash: string; subject?: string }
  /** Promote a note into a ticket. The note is kept — it stays true knowledge about the
      code — and the new ticket back-references it via origin/originRef. One direction only. */
  | { type: "make_ticket_from_note"; id: string };

export function isNotesHostMessage(value: unknown): value is NotesHostMessage {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
