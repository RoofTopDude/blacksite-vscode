import type { PersistedSessionState, SessionMessage, SessionRestoreState } from "./session-state.js";

/** Minimal shape of a persisted active session needed to rebuild restore state. */
export interface RestorableStoredSession {
  sessionId: string;
  messages: SessionMessage[];
  state?: PersistedSessionState;
}

/**
 * Decide which state a freshly-created {@link AgentSession} should be restored from.
 *
 * Settings changes (temperature, model, provider, …) intentionally drop the live
 * `AgentSession` so the next turn is rebuilt with the new configuration. Before this
 * helper existed, the rebuilt session started empty whenever no explicit restore state
 * was queued — silently discarding the whole conversation from the model's view even
 * though the transcript still showed it. Falling back to the persisted active session
 * keeps the agent's context intact across mid-conversation setting tweaks.
 *
 * Returns `null` for a genuinely fresh chat (active session cleared / no messages).
 */
export function pickRestoreState(
  queued: SessionRestoreState | null,
  activeStored: RestorableStoredSession | null | undefined,
): SessionRestoreState | null {
  if (queued) return queued;
  if (activeStored && activeStored.messages.length > 0) {
    return {
      sessionId: activeStored.sessionId,
      messages: activeStored.messages,
      ...(activeStored.state ?? {}),
    };
  }
  return null;
}
