import { describe, expect, it } from "vitest";
import { pickRestoreState, type RestorableStoredSession } from "../../src/session-restore.js";
import type { SessionRestoreState } from "../../src/session-state.js";

function stored(overrides: Partial<RestorableStoredSession> = {}): RestorableStoredSession {
  return {
    sessionId: "s_active",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("pickRestoreState", () => {
  it("prefers an explicitly queued restore state over the active session", () => {
    const queued: SessionRestoreState = { sessionId: "s_queued", messages: [{ role: "user", content: "queued" }] };
    const result = pickRestoreState(queued, stored());
    expect(result).toBe(queued);
  });

  it("falls back to the persisted active session when nothing is queued", () => {
    const active = stored({ sessionId: "s_active", state: { compressionCount: 2, contextLength: 1000 } });
    const result = pickRestoreState(null, active);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("s_active");
    expect(result!.messages).toEqual(active.messages);
    // Persisted state fields are spread through so runtime metrics survive the rebuild.
    expect(result!.compressionCount).toBe(2);
    expect(result!.contextLength).toBe(1000);
  });

  it("returns null for a genuinely fresh chat (no queued state, no active messages)", () => {
    expect(pickRestoreState(null, undefined)).toBeNull();
    expect(pickRestoreState(null, null)).toBeNull();
    expect(pickRestoreState(null, stored({ messages: [] }))).toBeNull();
  });

  it("does not mutate the active session's state object", () => {
    const active = stored({ state: { lastInputTokens: 42 } });
    const before = JSON.stringify(active.state);
    pickRestoreState(null, active);
    expect(JSON.stringify(active.state)).toBe(before);
  });
});
