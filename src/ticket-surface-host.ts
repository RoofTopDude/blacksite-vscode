/* The host half of the ticket webviews, shared by the sidebar queue and the board tab.
 *
 * Both surfaces read the same store, post the same state shape, and accept the same messages;
 * before this existed they also each carried their own copy of the path-containment guard and
 * the message switch, which is exactly the kind of duplication that lets one surface quietly
 * grow a capability — or lose a guard — the other doesn't have. The difference between the two
 * is density and layout. That belongs in the webview, not here.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { resolveTerritory, type Ticket, type TicketStore } from "./ticket-store.js";
import { suggest, type SuggestField } from "./ticket-suggest.js";
import { fromNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";

export interface TicketSurfaceDeps {
  store: TicketStore;
  workspaceRoot: string;
  roots: () => WorkspaceRoot[];
  indexedFiles: () => string[];
  /** Live plans, for the plan-link picker and its autocomplete. */
  plans: () => Array<{ id: string; title: string; status?: string }>;
}

const SUGGEST_FIELDS: SuggestField[] = ["file", "area", "label", "ticket", "plan"];

export class TicketSurfaceHost {
  private _revealOnMap?: (nodeId: string) => void;

  constructor(private readonly _deps: TicketSurfaceDeps) {}

  setMapRevealer(reveal: (nodeId: string) => void): void {
    this._revealOnMap = reveal;
  }

  /** The full push. Territory is resolved here rather than in the webview because expanding an
   *  area needs the live index, which the webview has no business re-deriving. */
  state(): Record<string, unknown> {
    const { document, dropped } = this._deps.store.readWithDiagnostics();
    const indexed = this._deps.indexedFiles();
    return {
      type: "tickets_state",
      tickets: document.tickets,
      territory: Object.fromEntries(
        document.tickets.map((ticket: Ticket) => [ticket.id, resolveTerritory(ticket.territory, indexed)]),
      ),
      dropped,
      labels: labelFrequency(document.tickets),
      plans: this._deps.plans().slice(0, 200),
      indexedCount: indexed.length,
    };
  }

  /**
   * Handle one webview message. Returns true when it was recognized, so a caller can keep
   * surface-specific messages of its own without this swallowing them.
   *
   * `reply` posts back to the originating webview; `refresh` re-pushes state. Both are supplied
   * by the caller because a WebviewView and a WebviewPanel are not the same object.
   */
  async handle(
    msg: Record<string, unknown>,
    reply: (message: Record<string, unknown>) => void,
    refresh: () => void,
  ): Promise<boolean> {
    const ctx = { sessionId: "webview" };
    switch (String(msg.type ?? "")) {
      case "ready":
      case "refresh":
        refresh();
        return true;
      case "file_ticket":
        this._deps.store.fileTicket(msg, ctx);
        return true;
      case "update_ticket": {
        const result = this._deps.store.updateTicket(msg, ctx);
        // Rejections are real (agent-may-close, a dangling duplicateOf) and the panel's
        // optimistic row would otherwise just snap back with no explanation.
        if (result.ok === false) reply({ type: "ticket_error", message: String(result.error ?? "That change was rejected.") });
        return true;
      }
      case "comment_ticket":
        this._deps.store.commentOnTicket(msg, ctx);
        return true;
      case "delete_ticket":
        await this._confirmDelete(String(msg.ticketId ?? ""), msg.confirmed === true);
        return true;
      case "reorder_ticket":
        this._deps.store.reorderTicket(String(msg.ticketId ?? ""), Number(msg.toIndex) || 0);
        return true;
      case "open_file":
        this._openWorkspaceFile(String(msg.path ?? ""));
        return true;
      case "show_on_map": {
        const nodeId = String(msg.path ?? "").trim();
        if (nodeId) this._revealOnMap?.(nodeId);
        return true;
      }
      case "open_plan":
        await vscode.commands.executeCommand("blacksite.plans.focus");
        return true;
      case "open_board":
        await vscode.commands.executeCommand("blacksite.openBoard", String(msg.ticketId ?? "") || undefined);
        return true;
      case "open_reference":
        await this._openReference(String(msg.url ?? ""));
        return true;
      case "copy_text":
        await vscode.env.clipboard.writeText(String(msg.text ?? "").slice(0, 4_000));
        return true;
      case "suggest": {
        const field = String(msg.field ?? "") as SuggestField;
        if (!SUGGEST_FIELDS.includes(field)) return true;
        reply({
          type: "suggest_result",
          requestId: String(msg.requestId ?? ""),
          field,
          items: suggest(field, String(msg.query ?? ""), {
            indexedFiles: this._deps.indexedFiles,
            tickets: () => this._deps.store.read().tickets,
            labels: () => labelFrequency(this._deps.store.read().tickets),
            plans: this._deps.plans,
          }, Array.isArray(msg.exclude) ? msg.exclude.map(String) : []),
        });
        return true;
      }
      default:
        return false;
    }
  }

  /** Deletion is the one destructive act in the queue and it has no undo, so it asks — and it
   *  names the ticket, because "are you sure?" over an id the user can no longer see is not a
   *  question anyone can answer. */
  private async _confirmDelete(ticketId: string, preconfirmed: boolean): Promise<void> {
    if (!ticketId) return;
    if (!preconfirmed) {
      const ticket = this._deps.store.read().tickets.find((candidate) => candidate.id === ticketId);
      if (!ticket) return;
      const choice = await vscode.window.showWarningMessage(
        `Delete ${ticket.id} — “${ticket.title}”?`,
        { modal: true, detail: "This removes the ticket and its comments for good. Cancel it instead to keep the record." },
        "Delete",
      );
      if (choice !== "Delete") return;
    }
    this._deps.store.deleteTicket(ticketId);
  }

  /** http(s) opens in the browser; anything else is treated as a workspace path and goes
   *  through the same containment guard as territory. The store already filters the schemes
   *  that must never reach here, and this is the second of the two checks. */
  private async _openReference(url: string): Promise<void> {
    const raw = url.trim();
    if (!raw) return;
    if (/^https?:\/\//i.test(raw)) {
      await vscode.env.openExternal(vscode.Uri.parse(raw));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
    this._openWorkspaceFile(raw);
  }

  /**
   * Opens a workspace file named by a ticket. The stored ids are workspace-relative by
   * construction but were authored by a model, so the resolved path is re-checked against the
   * workspace roots before opening — a "../../" id must not turn the queue into an arbitrary
   * file reader.
   */
  private _openWorkspaceFile(relativePath: string): void {
    const raw = relativePath.trim().replace(/\\/g, "/");
    if (!raw) return;
    const roots = this._deps.roots();
    const [pathPart, lineHint] = splitLineSuffix(raw);
    const candidates: string[] = [];
    const viaMapId = fromNodeId(roots, pathPart);
    if (viaMapId) candidates.push(path.resolve(viaMapId));
    candidates.push(path.resolve(this._deps.workspaceRoot, pathPart));

    const bases = [this._deps.workspaceRoot, ...roots.map((root) => root.path)].map((base) => path.resolve(base));
    for (const candidate of candidates) {
      const contained = bases.some((base) => candidate === base || candidate.startsWith(base + path.sep));
      if (!contained) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const selection = lineHint
          ? new vscode.Range(lineHint - 1, 0, lineHint - 1, 0)
          : undefined;
        void vscode.window.showTextDocument(vscode.Uri.file(candidate), { preview: false, selection });
        return;
      }
    }
    void vscode.window.showWarningMessage(`Blacksite: ${raw} isn't a file in this workspace.`);
  }
}

/** `src/foo.ts:42` → `["src/foo.ts", 42]`. A sweep-filed ticket names the line it came from,
 *  and landing on it beats landing at the top of a 900-line file. */
function splitLineSuffix(value: string): [string, number | undefined] {
  const match = /^(.*?):(\d+)$/.exec(value);
  if (!match) return [value, undefined];
  const line = Number(match[2]);
  return [match[1] ?? value, Number.isFinite(line) && line > 0 ? line : undefined];
}

/** Workspace label vocabulary, derived from usage rather than configured — this is what stops
 *  `auth` / `authentication` / `Auth` from coexisting, with no registry to maintain. */
export function labelFrequency(tickets: readonly Ticket[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    for (const label of ticket.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}
