/**
 * Rewind: put the workspace, the conversation, or both back to how they were before a message.
 *
 * Every turn records a rewind point when it starts: the edit journal's sequence number (files) and
 * a snapshot of the session (conversation). Restoring files replays the journal backwards to that
 * sequence number; restoring the conversation drops every later turn and puts the message back in
 * the input box.
 *
 * What rewind cannot undo is as important as what it can, so it is tracked explicitly and shown
 * before anything happens: the side effects of commands, git operations, MCP calls, sequences and
 * external-service changes are outside the journal, and a file whose earlier content was never
 * kept (binary, too large, a directory) is named rather than silently skipped.
 */

import { isReadOnlyCommand } from "@blacksite/local-runtime";
import type { SessionRewindSnapshot } from "./agent-session.js";
import type { RestorePlan } from "./edit-diff-journal.js";
import { isMutatingServiceTool } from "./tools/definitions.js";

export interface RewindPoint {
  /** The assistant turn this point precedes (the host's turn id). */
  turnId: string;
  sessionId: string;
  /** EditDiffJournal.sequence when the turn began. */
  journalSeq: number;
  snapshot: SessionRewindSnapshot;
  /** The message as the user typed it, put back in the input box by a conversation rewind. */
  userText: string;
  createdAt: number;
  /** Effects in this turn that the edit journal cannot undo, described for the user. */
  untracked: string[];
}

/** Enough to rewind any recent turn; older points age out oldest-first. */
const MAX_POINTS = 100;
const MAX_UNTRACKED_PER_TURN = 40;

export class RewindRegistry {
  private _points: RewindPoint[] = [];

  add(point: RewindPoint): void {
    this._points.push(point);
    if (this._points.length > MAX_POINTS) this._points.splice(0, this._points.length - MAX_POINTS);
  }

  clear(): void {
    this._points = [];
  }

  get(turnId: string): RewindPoint | undefined {
    return this._points.find((point) => point.turnId === turnId);
  }

  /** The point for `turnId` and every later one, oldest first. */
  from(turnId: string): RewindPoint[] {
    const index = this._points.findIndex((point) => point.turnId === turnId);
    return index < 0 ? [] : this._points.slice(index);
  }

  /** Drop the point for `turnId` and every later one — the turns a conversation rewind removed. */
  truncateFrom(turnId: string): void {
    const index = this._points.findIndex((point) => point.turnId === turnId);
    if (index >= 0) this._points.splice(index);
  }

  recordUntracked(turnId: string, description: string | null): void {
    if (!description) return;
    const point = this.get(turnId);
    if (!point || point.untracked.length >= MAX_UNTRACKED_PER_TURN || point.untracked.includes(description)) return;
    point.untracked.push(description);
  }

  turnIds(sessionId: string): string[] {
    return this._points.filter((point) => point.sessionId === sessionId).map((point) => point.turnId);
  }
}

const READ_ONLY_GIT_OPS = new Set(["context", "status", "diff", "log"]);

/**
 * A description of what this call may have changed outside the edit journal, or null when it
 * changes nothing rewind would miss. Read-only commands and journalled file tools return null.
 */
export function untrackedEffect(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const args = input ?? {};
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  switch (toolName) {
    case "shell_run":
    case "process_start": {
      const command = text(args["command"]);
      const list = Array.isArray(args["args"]) ? (args["args"] as unknown[]).map(String) : [];
      if (!command || isReadOnlyCommand(command, list)) return null;
      return `ran \`${[command, ...list].join(" ").slice(0, 120)}\``;
    }
    case "process_send_input":
      return "sent input to a background process";
    case "git_op": {
      const op = text(args["op"]);
      return READ_ONLY_GIT_OPS.has(op) ? null : `git ${op || "operation"}`;
    }
    case "worktree_op":
      return `worktree ${text(args["op"]) || "operation"}`;
    case "sequence_execute":
    case "sequence_resume":
      return "ran an Execution Run sequence";
    case "mcp_call_tool":
      return `called MCP tool ${text(args["toolName"]) || "(unknown)"}`;
    default:
      return isMutatingServiceTool(toolName) ? toolName.replace(/_/g, " ") : null;
  }
}

export type RewindScope = "both" | "conversation" | "code";

const MAX_LISTED = 12;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown;
}

/** The confirmation text: what will be restored, what will be lost, and what cannot be undone. */
export function describeRewind(plan: RestorePlan, untracked: readonly string[]): string {
  const lines: string[] = [];
  const restores = plan.files.filter((file) => file.action === "restore").map((file) => file.path);
  const deletes = plan.files.filter((file) => file.action === "delete").map((file) => file.path);
  if (restores.length) lines.push(`Files put back as they were (${restores.length}): ${listed(restores)}.`);
  if (deletes.length) lines.push(`Files created since, removed to the trash (${deletes.length}): ${listed(deletes)}.`);
  if (!restores.length && !deletes.length) lines.push("No recorded file changes since this message.");
  const modified = plan.files.filter((file) => file.modifiedSince).map((file) => file.path);
  if (modified.length) {
    lines.push(`Changed since the agent's last edit, so restoring discards those changes too: ${listed(modified)}.`);
  }
  if (plan.unrestorable.length) {
    lines.push(`Cannot be restored: ${listed(plan.unrestorable.map((item) => `${item.path} (${item.reason})`))}.`);
  }
  const effects = [...new Set(untracked)];
  if (effects.length) lines.push(`Not undone — effects outside the edit history: ${listed(effects)}.`);
  lines.push("Restoring the conversation removes every later message and puts this one back in the input box.");
  return lines.join("\n\n");
}

/** A note for the model's next turn after a partial rewind, so its picture of the files is right. */
export function rewindNote(scope: Exclude<RewindScope, "both">, paths: readonly string[]): string {
  if (!paths.length) return "";
  return scope === "code"
    ? `[Rewind note] The user restored these files to their state before an earlier message; the conversation still describes later changes that are no longer on disk. Re-read a file before editing it: ${listed(paths)}.`
    : `[Rewind note] The user rewound the conversation to before an earlier message but kept the files, so they still contain changes from the removed turns. Re-read a file before editing it: ${listed(paths)}.`;
}
