import type * as vscode from "vscode";
import type { PersistedSessionState, SessionMessage } from "./session-state.js";

export type StoredMessage = SessionMessage;

export interface StoredSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  workspaceRoot: string;
  messages: StoredMessage[];
  state?: PersistedSessionState;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  firstMessage: string;
  messageCount: number;
}

const ACTIVE_KEY       = "blacksite.session.active";
const HISTORY_KEY      = "blacksite.session.history";
const FULL_HISTORY_KEY = "blacksite.session.full_history";
const MAX_STORED_MSGS  = 100;
const MAX_SESSIONS     = 25;
const HISTORY_MSG_TRIM = 100; // messages kept per archived session
const MAX_FULL_SESSIONS = 10; // full uncompressed histories to keep

export class SessionStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  // ── Active session ─────────────────────────────────────────────────────────

  loadActive(): StoredSession | undefined {
    return this.ctx.workspaceState.get<StoredSession>(ACTIVE_KEY);
  }

  saveActive(session: StoredSession): void {
    const trimmed: StoredSession = { ...session, messages: session.messages.slice(-MAX_STORED_MSGS) };
    void this.ctx.workspaceState.update(ACTIVE_KEY, trimmed);
  }

  clearActive(): void {
    void this.ctx.workspaceState.update(ACTIVE_KEY, undefined);
  }

  newSessionId(): string {
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // ── History ────────────────────────────────────────────────────────────────

  /** Archive the current active session into history before starting a new one. */
  archiveActive(): void {
    const active = this.loadActive();
    if (!active || active.messages.length === 0) return;

    const history = this._loadHistory();

    // Remove existing entry for this session if present
    const filtered = history.filter((s) => s.sessionId !== active.sessionId);

    // Add updated entry at the front (most-recent first)
    const archived: StoredSession = {
      ...active,
      messages: active.messages.slice(-HISTORY_MSG_TRIM),
    };
    filtered.unshift(archived);

    // Keep most recent MAX_SESSIONS
    this._saveHistory(filtered.slice(0, MAX_SESSIONS));
  }

  loadHistory(): SessionSummary[] {
    return this._loadHistory().map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      model: s.model,
      firstMessage: this._extractFirstMessage(s),
      messageCount: s.messages.length,
    }));
  }

  loadSessionFromHistory(sessionId: string): StoredSession | undefined {
    return this._loadHistory().find((s) => s.sessionId === sessionId);
  }

  deleteSessionFromHistory(sessionId: string): void {
    const history = this._loadHistory().filter((s) => s.sessionId !== sessionId);
    this._saveHistory(history);
  }

  // ── Full history (untruncated, for transcript_read tool) ───────────────────

  saveFullHistory(sessionId: string, messages: StoredMessage[]): void {
    const all = this._loadFullHistories();
    const filtered = all.filter((e) => e.sessionId !== sessionId);
    filtered.unshift({ sessionId, messages });
    void this.ctx.workspaceState.update(FULL_HISTORY_KEY, filtered.slice(0, MAX_FULL_SESSIONS));
  }

  loadFullHistory(sessionId: string): StoredMessage[] | undefined {
    return this._loadFullHistories().find((e) => e.sessionId === sessionId)?.messages;
  }

  private _loadFullHistories(): Array<{ sessionId: string; messages: StoredMessage[] }> {
    return this.ctx.workspaceState.get<Array<{ sessionId: string; messages: StoredMessage[] }>>(FULL_HISTORY_KEY, []);
  }

  private _loadHistory(): StoredSession[] {
    return this.ctx.workspaceState.get<StoredSession[]>(HISTORY_KEY, []);
  }

  private _saveHistory(sessions: StoredSession[]): void {
    void this.ctx.workspaceState.update(HISTORY_KEY, sessions);
  }

  private _extractFirstMessage(session: StoredSession): string {
    const first = session.messages.find((m) => m.role === "user");
    if (!first) return "(empty session)";
    const text = typeof first.content === "string"
      ? first.content
      : (Array.isArray(first.content)
          ? (first.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
          : "");
    return text.slice(0, 80) + (text.length > 80 ? "…" : "");
  }
}
