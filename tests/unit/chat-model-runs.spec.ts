import { describe, expect, it } from "vitest";
import {
  createAssistantTurn,
  createChatState,
  ensureLaneTurn,
  ensureToolCall,
  finalizeTurn,
  harnessSeamFor,
  restoreConversation,
  toolGroupsOf,
  toolRunsOf,
  turnChrome,
} from "../../src/webview/react/lib/chat-model.js";
import { stopReasonLabel } from "../../src/webview/react/lib/format.js";
import { formatCountdown, formatRunDuration, runClockMs, runIsOver, runIsTicking } from "../../src/webview/react/lib/run-format.js";
import type { PlanRunView } from "../../src/webview/react/lib/protocol.js";

describe("toolRunsOf", () => {
  it("lists calls in the order they happened, merging only neighbours that share a tool", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t1");
    for (const [id, tool] of [["a", "file_read"], ["b", "file_read"], ["c", "file_edit"], ["d", "file_read"], ["e", "shell_run"], ["f", "shell_run"]] as const) {
      ensureToolCall(state, turn, { toolCallId: id, toolName: tool, input: {} });
    }
    const runs = toolRunsOf(turn);
    expect(runs.map((run) => `${run.key.split("#")[0]}×${run.calls.length}`)).toEqual(["file_read×2", "file_edit×1", "file_read×1", "shell_run×2"]);
    // The grouped view still folds the same calls by tool, for people who want that.
    expect(toolGroupsOf(turn).map((group) => `${group.key}×${group.calls.length}`)).toEqual(["file_read×3", "file_edit×1", "shell_run×2"]);
  });

  it("gives every run its own key, even for the same tool twice", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t1");
    for (const [id, tool] of [["a", "file_read"], ["b", "file_edit"], ["c", "file_read"]] as const) {
      ensureToolCall(state, turn, { toolCallId: id, toolName: tool, input: {} });
    }
    const keys = toolRunsOf(turn).map((run) => run.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves a lane's spawn call to its own tile", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t1");
    ensureToolCall(state, turn, { toolCallId: "a", toolName: "subagent_spawn", input: {} });
    expect(toolRunsOf(turn)).toEqual([]);
  });
});

describe("restored transcripts and the harness", () => {
  it("shows why the agent went on, instead of a user bubble the user never typed", () => {
    const state = createChatState();
    restoreConversation(state, [
      { role: "user", content: "Run the migration plan" },
      { role: "assistant", content: [{ type: "text", text: "Step one done." }] },
      { role: "user", content: "[Automatic plan continuation]\nContinue with the schema step." },
      { role: "assistant", content: [{ type: "text", text: "Schema done." }] },
      { role: "user", content: "[Plan run resumed]\nPlan \"X\": phase 1 of 2." },
      { role: "assistant", content: [{ type: "text", text: "Picking it up." }] },
    ] as never);
    const users = state.turns.filter((turn) => turn.role === "user");
    expect(users.map((turn) => turn.text)).toEqual(["Run the migration plan"]);
    const assistants = state.turns.filter((turn) => turn.role === "assistant");
    expect(assistants.map((turn) => turn.seam)).toEqual([undefined, "Continued the plan", "Plan run resumed"]);
  });

  it("recognises each message the harness writes on the user's behalf", () => {
    expect(harnessSeamFor("[Automatic plan continuation]\nx")).toBe("Continued the plan");
    expect(harnessSeamFor("[Plan run] Execute the plan")).toBe("Plan run started");
    expect(harnessSeamFor("[Resumed from checkpoint]")).toBe("Resumed from a checkpoint");
    expect(harnessSeamFor("Please run the plan")).toBeNull();
  });
});

describe("lanes and stops", () => {
  it("keeps what a lane was allowed when it started", () => {
    const state = createChatState();
    createAssistantTurn(state, "live");
    state.currentLiveTurnId = "live";
    const lane = ensureLaneTurn(state, { id: "live", laneId: "lane-1", label: "Auditor", task: "audit", budget: { maxToolRounds: 10, maxRuntimeSeconds: 1200 } });
    expect(lane?.laneBudget).toEqual({ maxToolRounds: 10, maxRuntimeSeconds: 1200 });
    expect(ensureLaneTurn(state, { id: "live", laneId: "lane-2", label: "No budget", task: "x" })?.laneBudget).toBeUndefined();
    expect(ensureLaneTurn(state, { id: "live", laneId: "lane-3", label: "Junk", task: "x", budget: { maxToolRounds: -1, maxRuntimeSeconds: "x" } })?.laneBudget).toBeUndefined();
  });

  it("names a pause as a pause, not a limit or an error", () => {
    const state = createChatState();
    const turn = createAssistantTurn(state, "t1");
    finalizeTurn(turn, { status: "complete", stopReason: "paused" });
    const chrome = turnChrome(turn);
    expect(chrome.statusClass).toBe("paused");
    expect(chrome.statusText).toBe("Paused");
    expect(chrome.meta).toContain("Paused at the end of a step");
    expect(stopReasonLabel("paused")).toBe("paused");
  });
});

describe("run formatting", () => {
  it("scales a duration across a whole afternoon", () => {
    expect(formatRunDuration(42_000)).toBe("42s");
    expect(formatRunDuration(7 * 60_000 + 5_000)).toBe("7m 05s");
    expect(formatRunDuration(3 * 3600_000 + 9 * 60_000)).toBe("3h 09m");
    expect(formatCountdown(10_000, 9_500)).toBe("now");
    expect(formatCountdown(70_000, 0)).toBe("1m 10s");
  });

  function view(overrides: Partial<PlanRunView> = {}): PlanRunView {
    return {
      id: "r", planId: "p", planTitle: "P", status: "running", liveState: "working", startedAt: 0, elapsedMs: 0,
      activeMs: 60_000, waitingUserMs: 30_000, waitingProviderMs: 10_000, spentUsd: 0, spendPartial: false,
      phaseIndex: 1, phaseCount: 1, stepsDone: 0, stepsTotal: 1, stepPosition: 1, phases: [], turns: 0, retries: 0,
      compactions: 0, pauseRequested: false, hasBaseline: false, hasReport: false, ...overrides,
    };
  }

  it("keeps the clock moving only while the run has one running", () => {
    expect(runClockMs(view(), 5_000)).toBe(105_000);
    expect(runClockMs(view({ liveState: "paused", status: "paused" }), 5_000)).toBe(100_000);
    expect(runIsTicking("needs_you")).toBe(true);
    expect(runIsTicking("done")).toBe(false);
    expect(runIsOver({ status: "completed" })).toBe(true);
    expect(runIsOver({ status: "failed" })).toBe(false);
  });
});
