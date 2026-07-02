import { describe, expect, it } from "vitest";
import {
  createChatState,
  createUserTurn,
  createAssistantTurn,
  ensureToolCall,
  applyToolResult,
  applyApprovalPending,
  applyApprovalResult,
  addQuestionCard,
  answerQuestionCard,
  appendText,
  appendThinking,
  finalizeThinking,
  finalizeTurn,
  restoreConversation,
  conversationStats,
  toolGroupsOf,
  turnChrome,
  turnIsLive,
  toolCallLiveElapsedMs,
  placeholderText,
  toolStateClass,
  latestAssistantTurn,
  lastUserPrompt,
  resetConversation,
  ensureLaneTurn,
  pendingItemsOf,
} from "../../src/webview/react/lib/chat-model.js";

/* ── helpers ──────────────────────────────────────────────────────────────── */

function freshState() {
  return createChatState();
}

/* ── createUserTurn ───────────────────────────────────────────────────────── */

describe("createUserTurn", () => {
  it("appends a user turn with the correct text", () => {
    const state = freshState();
    const turn = createUserTurn(state, "hello", null);
    expect(state.turns).toHaveLength(1);
    expect(turn.role).toBe("user");
    expect(turn.text).toBe("hello");
    expect(turn.status).toBe("complete");
  });

  it("sets hasMessages to true", () => {
    const state = freshState();
    expect(state.hasMessages).toBe(false);
    createUserTurn(state, "hi", null);
    expect(state.hasMessages).toBe(true);
  });

  it("stores ctxLabel", () => {
    const state = freshState();
    const turn = createUserTurn(state, "hi", "some-label");
    expect(turn.ctxLabel).toBe("some-label");
  });

  it("registers turn in byId map", () => {
    const state = freshState();
    const turn = createUserTurn(state, "hi", null);
    expect(state.byId.get(turn.id)).toBe(turn);
  });
});

/* ── lastUserPrompt ───────────────────────────────────────────────────────── */

describe("lastUserPrompt", () => {
  it("returns null when there are no user turns", () => {
    const state = freshState();
    expect(lastUserPrompt(state)).toBeNull();
    createAssistantTurn(state, "a1");
    expect(lastUserPrompt(state)).toBeNull();
  });

  it("returns the most recent user turn's text", () => {
    const state = freshState();
    createUserTurn(state, "first", null);
    createAssistantTurn(state, "a1");
    createUserTurn(state, "second", null);
    expect(lastUserPrompt(state)).toBe("second");
  });

  it("skips blank user turns and trims", () => {
    const state = freshState();
    createUserTurn(state, "real prompt", null);
    createUserTurn(state, "   ", null);
    expect(lastUserPrompt(state)).toBe("real prompt");
  });
});

/* ── createAssistantTurn ──────────────────────────────────────────────────── */

describe("createAssistantTurn", () => {
  it("appends an assistant turn in streaming state", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "turn-1");
    expect(turn.role).toBe("assistant");
    expect(turn.status).toBe("streaming");
    expect(state.byId.get("turn-1")).toBe(turn);
  });

  it("increments assistantTurnCount", () => {
    const state = freshState();
    createAssistantTurn(state, "t1");
    createAssistantTurn(state, "t2");
    expect(state.assistantTurnCount).toBe(2);
  });
});

/* ── appendText / appendThinking ──────────────────────────────────────────── */

describe("appendText", () => {
  it("accumulates text on the turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    appendText(turn, "foo");
    appendText(turn, " bar");
    expect(turn.raw).toBe("foo bar");
  });
});

describe("appendThinking / finalizeThinking", () => {
  it("accumulates thinking text and marks active", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    appendThinking(turn, "step1");
    appendThinking(turn, " step2");
    expect(turn.thinkingRaw).toBe("step1 step2");
    expect(turn.thinkingActive).toBe(true);
  });

  it("finalizeThinking clears active flag and closes bubble", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    appendThinking(turn, "thought");
    finalizeThinking(turn);
    expect(turn.thinkingActive).toBe(false);
    expect(turn.thinkingOpen).toBe(false);
  });
});

/* ── ensureToolCall ───────────────────────────────────────────────────────── */

describe("ensureToolCall", () => {
  it("creates a new tool call with correct shape", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "file_read", input: { path: "." } });
    expect(call.toolName).toBe("file_read");
    expect(call.state).toBe("running");
    expect(turn.toolCalls.get("tc1")).toBe(call);
    expect(turn.toolCallList).toHaveLength(1);
  });

  it("is idempotent — returns the same call on re-invocation", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const a = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "file_read", input: {} });
    const b = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "file_read", input: {} });
    expect(a).toBe(b);
    expect(turn.toolCallList).toHaveLength(1);
  });

  it("stamps startedAt so a running call can show a live-ticking duration", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const before = Date.now();
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "shell_run", input: {} });
    expect(call.startedAt).not.toBeNull();
    expect(call.startedAt!).toBeGreaterThanOrEqual(before);
  });
});

/* ── toolCallLiveElapsedMs ─────────────────────────────────────────────────── */

describe("toolCallLiveElapsedMs", () => {
  it("prefers the recorded elapsedMs once the call has completed", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "shell_run", input: {} });
    applyToolResult(turn, call, { ok: true }, 250);
    expect(toolCallLiveElapsedMs(call, Date.now() + 100_000)).toBe(250);
  });

  it("ticks live from startedAt while the call is still running", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "shell_run", input: {} });
    const later = call.startedAt! + 4000;
    expect(toolCallLiveElapsedMs(call, later)).toBe(4000);
  });
});

/* ── applyToolResult ──────────────────────────────────────────────────────── */

describe("applyToolResult", () => {
  it("transitions call state from running to ok on success", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "file_read", input: {} });
    applyToolResult(turn, call, { path: "src/foo.ts", sizeBytes: 100 }, 123);
    expect(call.state).toBe("ok");
    expect(call.elapsedMs).toBe(123);
  });

  it("marks call as fail when result has error", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "file_read", input: {} });
    applyToolResult(turn, call, { error: "File not found" }, 50);
    expect(call.state).toBe("fail");
  });

  it("updates failureCount on the turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const call = ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "shell_run", input: {} });
    applyToolResult(turn, call, { error: "Command failed" }, 10);
    expect(turn.failureCount).toBe(1);
  });
});

/* ── applyApprovalPending / applyApprovalResult ──────────────────────────── */

describe("approval state machine", () => {
  it("pending sets approvalState and increments approvalCount", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "Wants to delete a file", "destructive");
    const call = turn.toolCalls.get("tc1")!;
    expect(call.approvalState).toBe("pending");
    expect(call.approvalDescription).toBe("Wants to delete a file");
    expect(call.approvalTier).toBe("destructive");
    expect(turn.approvalCount).toBe(1);
  });

  it("does not double-increment approvalCount on second pending call", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    expect(turn.approvalCount).toBe(1);
  });

  it("allow decision transitions call to granted", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    applyApprovalResult(turn, "tc1", true, "allow");
    const call = turn.toolCalls.get("tc1")!;
    expect(call.approvalState).toBe("granted");
    expect(call.approvalDecision).toBe("allow");
  });

  it("deny decision marks call as fail", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    applyApprovalResult(turn, "tc1", false, "deny");
    const call = turn.toolCalls.get("tc1")!;
    expect(call.approvalState).toBe("denied");
    expect(call.state).toBe("fail");
    expect(turn.failureCount).toBe(1);
  });

  it("toolStateClass returns pending when approval is pending", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    const call = turn.toolCalls.get("tc1")!;
    expect(toolStateClass(call)).toBe("pending");
  });
});

/* ── addQuestionCard / answerQuestionCard ─────────────────────────────────── */

describe("question cards", () => {
  const opts = [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }];

  it("adds a question card", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    addQuestionCard(state, turn, "qc1", "Continue?", opts, null);
    expect(turn.questionCards).toHaveLength(1);
    expect(turn.questionCards[0]!.question).toBe("Continue?");
    expect(turn.questionCards[0]!.answeredKey).toBeNull();
  });

  it("is idempotent — does not duplicate on second add", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    addQuestionCard(state, turn, "qc1", "Continue?", opts, null);
    addQuestionCard(state, turn, "qc1", "Continue?", opts, null);
    expect(turn.questionCards).toHaveLength(1);
  });

  it("answerQuestionCard sets answeredKey", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    addQuestionCard(state, turn, "qc1", "Continue?", opts, null);
    answerQuestionCard(turn, "qc1", "yes");
    expect(turn.questionCards[0]!.answeredKey).toBe("yes");
  });

  it("stamps a monotonic pendingSeq on each new card", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    addQuestionCard(state, turn, "qc1", "First?", opts, null);
    addQuestionCard(state, turn, "qc2", "Second?", opts, null);
    expect(turn.questionCards[1]!.pendingSeq).toBeGreaterThan(turn.questionCards[0]!.pendingSeq);
  });
});

/* ── finalizeTurn ─────────────────────────────────────────────────────────── */

describe("finalizeTurn", () => {
  it("transitions status and records stop reason", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    finalizeTurn(turn, { status: "complete", stopReason: "end_turn", iterations: 3 });
    expect(turn.status).toBe("complete");
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.iterations).toBe(3);
    expect(turn.endedAt).not.toBeNull();
  });

  it("keeps the higher iteration count", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    turn.iterations = 5;
    finalizeTurn(turn, { iterations: 3 });
    expect(turn.iterations).toBe(5);
  });
});

/* ── resetConversation ────────────────────────────────────────────────────── */

describe("resetConversation", () => {
  it("clears all turns and maps", () => {
    const state = freshState();
    createUserTurn(state, "hi", null);
    createAssistantTurn(state, "t1");
    resetConversation(state);
    expect(state.turns).toHaveLength(0);
    expect(state.byId.size).toBe(0);
    expect(state.assistantTurnCount).toBe(0);
    expect(state.hasMessages).toBe(false);
  });
});

/* ── latestAssistantTurn ──────────────────────────────────────────────────── */

describe("latestAssistantTurn", () => {
  it("returns null for empty conversation", () => {
    expect(latestAssistantTurn(freshState())).toBeNull();
  });

  it("finds the last assistant turn", () => {
    const state = freshState();
    createUserTurn(state, "hi", null);
    const a = createAssistantTurn(state, "t1");
    createUserTurn(state, "follow-up", null);
    const b = createAssistantTurn(state, "t2");
    expect(latestAssistantTurn(state)).toBe(b);
    void a; // suppress unused warning
  });
});

/* ── conversationStats ────────────────────────────────────────────────────── */

describe("conversationStats", () => {
  it("counts tools and approvals across turns", () => {
    const state = freshState();
    const a = createAssistantTurn(state, "t1");
    ensureToolCall(state, a, { toolCallId: "tc1", toolName: "file_read", input: {} });
    applyApprovalPending(state, a, "tc2", "desc", "");
    const stats = conversationStats(state);
    expect(stats.assistantTurns).toBe(1);
    expect(stats.toolCalls).toBe(2);
    expect(stats.approvals).toBe(1);
  });
});

/* ── toolGroupsOf ─────────────────────────────────────────────────────────── */

describe("toolGroupsOf", () => {
  it("groups calls by tool name", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    ensureToolCall(state, turn, { toolCallId: "a1", toolName: "file_read", input: {} });
    ensureToolCall(state, turn, { toolCallId: "a2", toolName: "file_read", input: {} });
    ensureToolCall(state, turn, { toolCallId: "b1", toolName: "shell_run", input: {} });
    const groups = toolGroupsOf(turn);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toBe("file_read");
    expect(groups[0]!.calls).toHaveLength(2);
    expect(groups[1]!.key).toBe("shell_run");
  });
});

/* ── turnChrome ───────────────────────────────────────────────────────────── */

describe("turnChrome", () => {
  it("shows Live for streaming turn with no pending", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    const chrome = turnChrome(turn);
    expect(chrome.statusClass).toBe("streaming");
    expect(chrome.statusText).toBe("Live");
  });

  it("shows Wait when approval is pending", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    const chrome = turnChrome(turn);
    expect(chrome.statusClass).toBe("pending");
    expect(chrome.statusText).toBe("Wait");
  });

  it("shows Done for completed turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    finalizeTurn(turn, { status: "complete" });
    const chrome = turnChrome(turn);
    expect(chrome.statusClass).toBe("complete");
    expect(chrome.statusText).toBe("Done");
  });

  it("shows Error for errored turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    finalizeTurn(turn, { status: "error" });
    const chrome = turnChrome(turn);
    expect(chrome.statusClass).toBe("error");
  });

  it("ticks the meta duration upward as the caller advances `now` for a live turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    turn.startedAt = 1_000;
    const early = turnChrome(turn, 1_500).meta;
    const later = turnChrome(turn, 5_000).meta;
    expect(early).toContain("500ms");
    expect(later).toContain("4.0s");
  });

  it("freezes the meta duration once the turn has an endedAt, regardless of `now`", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    turn.startedAt = 1_000;
    finalizeTurn(turn, { status: "complete" });
    turn.endedAt = 3_000;
    expect(turnChrome(turn, 3_000).meta).toContain("2.0s");
    expect(turnChrome(turn, 999_999).meta).toContain("2.0s");
  });
});

/* ── turnIsLive ────────────────────────────────────────────────────────────── */

describe("turnIsLive", () => {
  it("is true only while the turn is streaming", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    expect(turnIsLive(turn)).toBe(true);
    finalizeTurn(turn, { status: "complete" });
    expect(turnIsLive(turn)).toBe(false);
  });
});

/* ── placeholderText ──────────────────────────────────────────────────────── */

describe("placeholderText", () => {
  it("returns error message for errored turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    turn.status = "error";
    turn.errorMessage = "Something broke";
    expect(placeholderText(turn)).toBe("Something broke");
  });

  it("returns waiting text when approval is pending", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "");
    expect(placeholderText(turn)).toBe("Waiting on approval to continue.");
  });

  it("returns drafting text for empty streaming turn with no tools", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    expect(placeholderText(turn)).toBe("Drafting response…");
  });
});

/* ── restoreConversation ──────────────────────────────────────────────────── */

describe("restoreConversation", () => {
  it("restores user and assistant turns from messages", () => {
    const state = freshState();
    restoreConversation(state, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ]);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]!.role).toBe("user");
    expect(state.turns[0]!.text).toBe("Hello");
    expect(state.turns[1]!.role).toBe("assistant");
    expect(state.turns[1]!.raw).toBe("Hi there");
    expect(state.turns[1]!.status).toBe("complete");
    expect(state.running).toBe(false);
  });

  it("links tool_use blocks to tool_result blocks in the follow-up user message", () => {
    const state = freshState();
    restoreConversation(state, [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc1", name: "file_read", input: { path: "." } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc1", content: [{ type: "text", text: "contents" }] }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    // Two assistant turns merged into two groups
    const assistantTurns = state.turns.filter((t) => t.role === "assistant");
    // First assistant turn has the tool call
    expect(assistantTurns[0]!.toolCallList).toHaveLength(1);
    expect(assistantTurns[0]!.toolCallList[0]!.toolName).toBe("file_read");
  });

  it("restores thinking blocks from history", () => {
    const state = freshState();
    restoreConversation(state, [
      { role: "user", content: "think about it" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me reason..." },
          { type: "text", text: "Answer" },
        ],
      },
    ]);
    const assistantTurns = state.turns.filter((t) => t.role === "assistant");
    expect(assistantTurns[0]!.thinkingRaw).toBe("let me reason...");
    // After finalization, thinking should be closed
    expect(assistantTurns[0]!.thinkingActive).toBe(false);
    expect(assistantTurns[0]!.thinkingOpen).toBe(false);
  });

  it("clears prior state before restoring", () => {
    const state = freshState();
    createUserTurn(state, "old", null);
    restoreConversation(state, [{ role: "user", content: "new" }]);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]!.text).toBe("new");
  });

  it("handles empty messages array gracefully", () => {
    const state = freshState();
    restoreConversation(state, []);
    expect(state.turns).toHaveLength(0);
    expect(state.running).toBe(false);
  });
});

/* ── pendingItemsOf — docked PendingBar source ────────────────────────────── */

describe("pendingItemsOf", () => {
  const opts = [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }];

  it("returns nothing when there is no live conversation", () => {
    expect(pendingItemsOf(freshState())).toEqual([]);
  });

  it("includes a pending approval, keyed to the owning turn", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "Wants to run npm install", "network");
    const items = pendingItemsOf(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "approval", turnId: turn.id, toolCallId: "tc1", laneId: null, tier: "network" });
  });

  it("includes an unanswered question but excludes an answered one", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    addQuestionCard(state, turn, "qc1", "Continue?", opts, null);
    const pending = pendingItemsOf(state);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "question", toolCallId: "qc1", options: opts });

    answerQuestionCard(turn, "qc1", "yes");
    expect(pendingItemsOf(state)).toHaveLength(0);
  });

  it("excludes a granted or denied approval", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "desc", "write");
    applyApprovalResult(turn, "tc1", true, "allow");
    expect(pendingItemsOf(state)).toHaveLength(0);
  });

  it("orders items by creation order (pendingSeq) across separate turns", () => {
    const state = freshState();
    const turnA = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turnA, "tc1", "first", "write");
    const turnB = createAssistantTurn(state, "t2");
    applyApprovalPending(state, turnB, "tc2", "second", "write");
    const items = pendingItemsOf(state);
    expect(items.map((i) => i.toolCallId)).toEqual(["tc1", "tc2"]);
  });

  it("carries the unrecognizedCommand flag through as `unrecognized`", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    applyApprovalPending(state, turn, "tc1", "Run an unknown binary", "write", true);
    expect(pendingItemsOf(state)[0]!.unrecognized).toBe(true);
  });

  it("extracts the shell binary for a shell_run approval", () => {
    const state = freshState();
    const turn = createAssistantTurn(state, "t1");
    ensureToolCall(state, turn, { toolCallId: "tc1", toolName: "shell_run", input: { command: "npm", args: ["install"] } });
    applyApprovalPending(state, turn, "tc1", "Installs dependencies", "network");
    expect(pendingItemsOf(state)[0]!.binary).toBe("npm");
  });

  it("scopes a lane-owned pending approval to the lane's own turn id, not the parent's", () => {
    const state = freshState();
    const lane = ensureLaneTurn(state, { laneId: "lane1", label: "Refactor tests", id: "parent1" })!;
    const parentTurnId = state.currentLiveTurnId!;
    applyApprovalPending(state, lane, "tc1", "Wants to delete a file", "destructive");

    const items = pendingItemsOf(state);
    expect(items).toHaveLength(1);
    expect(items[0]!.turnId).toBe("lane1");
    expect(items[0]!.turnId).not.toBe(parentTurnId);
    expect(items[0]).toMatchObject({ laneId: "lane1", laneLabel: "Refactor tests" });
  });
});
