import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@blacksite-agent/llm";
import { ContextLedger, type RequestShape } from "../../src/context/ledger.js";
import { estimateTokens } from "../../src/context/model.js";
import { ContextReportAccumulator, formatContextReportLine, toolResultStats } from "../../src/context/report.js";
import { layoutAttachedContext, WORKSPACE_SECTION_STABILITY } from "../../src/context/layout.js";
import { BASELINE_CONTEXT_FLAGS, CONTEXT_FLAGS, readContextFlags } from "../../src/context/flags.js";

const READ = (path: string, extra: Record<string, unknown> = {}) => ({ reads: [path], writes: [] as string[], input: { path, ...extra } });

function conversation(): AgentMessage[] {
  return [
    { role: "user", content: "Fix the bug in a.ts" },
    { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "t1", name: "file_read", input: { path: "src/a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(360) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "file_read", input: { path: "src/b.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "y".repeat(36) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "file_read", input: { path: "src/a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "z".repeat(36) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "q1", name: "question_card", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "answer" }] },
  ];
}

function shape(messages: AgentMessage[]): RequestShape {
  return {
    system: "s".repeat(72),
    systemSummary: "",
    contextStable: "",
    contextTail: "live".repeat(9),
    tools: [{ name: "file_read", chars: 36 }, { name: "file_edit", chars: 72 }],
    messages,
  };
}

function ledgerWithCalls(archived: Set<string> = new Set()): ContextLedger {
  const ledger = new ContextLedger({ unsheddableTools: ["question_card"], isArchived: (id) => archived.has(id) });
  for (const [id, call] of [["t1", READ("src/a.ts")], ["t2", READ("src/b.ts")], ["t3", READ("src/a.ts")]] as const) {
    ledger.recordToolCall(id, "file_read", call.input, call);
  }
  ledger.recordToolCall("q1", "question_card", {}, { reads: [], writes: [] });
  return ledger;
}

describe("ContextLedger", () => {
  it("classifies and sizes every part of a request", () => {
    const snapshot = ledgerWithCalls().snapshot(shape(conversation()));
    expect(snapshot.byClass.system).toMatchObject({ items: 1, chars: 72, tokens: estimateTokens(72) });
    expect(snapshot.byClass["tool-definition"].items).toBe(2);
    expect(snapshot.byClass["attached-live"].chars).toBe(36);
    expect(snapshot.byClass["attached-stable"].items).toBe(0);
    expect(snapshot.byClass["tool-result"].items).toBe(4);
    expect(snapshot.byClass["user-message"].items).toBe(1);
    expect(snapshot.estimatedTokens).toBe(snapshot.items.reduce((sum, item) => sum + item.tokens, 0));
    const result = snapshot.items.find((item) => item.id === "t1")!;
    expect(result).toMatchObject({ class: "tool-result", label: "file_read", messageIndex: 2, stability: "session" });
    expect(snapshot.items.find((item) => item.id === "attached.live")!.stability).toBe("call");
  });

  it("marks an older read superseded by a newer read of the same file", () => {
    const snapshot = ledgerWithCalls().snapshot(shape(conversation()));
    expect(snapshot.items.find((item) => item.id === "t1")!.supersededBy).toBe("t3");
    expect(snapshot.items.find((item) => item.id === "t2")!.supersededBy).toBeUndefined();
    expect(snapshot.items.find((item) => item.id === "t3")!.supersededBy).toBeUndefined();
  });

  it("does not supersede a whole-file read with a range read, but does the reverse", () => {
    const ledger = new ContextLedger();
    ledger.recordToolCall("whole", "file_read", { path: "a.ts" }, { reads: ["a.ts"], writes: [] });
    ledger.recordToolCall("range", "file_read", { path: "a.ts", startLine: 1, endLine: 5 }, { reads: ["a.ts"], writes: [] });
    expect(ledger.supersession().has("whole")).toBe(false);

    ledger.recordToolCall("whole2", "file_read", { path: "a.ts" }, { reads: ["a.ts"], writes: [] });
    const superseded = ledger.supersession();
    expect(superseded.get("whole")).toBe("whole2");
    expect(superseded.get("range")).toBe("whole2");
  });

  it("does not let a failed read supersede anything", () => {
    const ledger = new ContextLedger();
    ledger.recordToolCall("ok", "file_read", { path: "a.ts" }, { reads: ["a.ts"], writes: [] });
    ledger.recordToolCall("failed", "file_read", { path: "a.ts" }, { reads: ["a.ts"], writes: [] }, false);
    expect(ledger.supersession().size).toBe(0);
  });

  it("pins user words and unsheddable results", () => {
    const snapshot = ledgerWithCalls().snapshot(shape(conversation()));
    expect(snapshot.items.find((item) => item.id === "msg.0")!.pinned).toBe(true);
    expect(snapshot.items.find((item) => item.id === "q1")!.pinned).toBe(true);
    expect(snapshot.items.find((item) => item.id === "t1")!.pinned).toBe(false);
  });

  it("says how a result can be recovered: archive first, then a re-read of an unchanged file", () => {
    const ledger = ledgerWithCalls(new Set(["t2"]));
    expect(ledger.recallFor("t2")).toEqual({ kind: "archive", id: "t2" });
    expect(ledger.recallFor("t1")).toEqual({ kind: "re-read", path: "src/a.ts" });

    ledger.recordToolCall("w1", "file_edit", { path: "src/a.ts" }, { reads: [], writes: ["src/a.ts"] });
    expect(ledger.recallFor("t1")).toEqual({ kind: "none" });
    expect(ledger.recallFor("q1")).toEqual({ kind: "none" });
  });

  it("forgets tool calls on a rewind but keeps its calibration", () => {
    const ledger = ledgerWithCalls();
    ledger.calibrate(100, 150);
    expect(ledger.supersession().size).toBe(1);
    ledger.forgetToolCalls();
    expect(ledger.supersession().size).toBe(0);
    expect(ledger.recallFor("t1")).toEqual({ kind: "none" });
    expect(ledger.calibrationRatio).toBe(1.5);
  });

  it("calibrates estimates against reported usage", () => {
    const ledger = new ContextLedger();
    expect(ledger.calibrationRatio).toBeNull();
    ledger.calibrate(100, 120);
    ledger.calibrate(100, 80);
    expect(ledger.calibrationRatio).toBe(1);
    ledger.calibrate(0, 50);
    expect(ledger.calibrationRatio).toBe(1);
    ledger.calibrate(200, 400);
    expect(ledger.calibrationRatio).toBe(1.5);
  });
});

describe("context report", () => {
  it("aggregates turns and the session, and finds the costliest items", () => {
    const ledger = ledgerWithCalls();
    const accumulator = new ContextReportAccumulator();
    const messages = conversation();
    const first = ledger.snapshot(shape(messages.slice(0, 3)));
    const second = ledger.snapshot(shape(messages));
    accumulator.addRequest(first, { input: 100, cacheRead: 0, cacheWrite: 400, output: 10 });
    accumulator.addRequest(second, { input: 50, cacheRead: 450, cacheWrite: 30, output: 12 });

    const report = accumulator.report({ calibrationRatio: 1.1, endTurn: true });
    expect(report.turn).toMatchObject({ requests: 2, input: 150, cacheRead: 450, cacheWrite: 430, output: 22, peakContextTokens: 530 });
    expect(report.turn.uncachedShare).toBeCloseTo(150 / 1030);
    // The 360-character read, carried by both requests, outweighs the 72-character system prompt.
    expect(report.costliest[0]).toMatchObject({ id: "t1", carried: 2, carriedTokens: 2 * estimateTokens(360) });
    expect(report.byClass.system.carriedTokens).toBe(2 * estimateTokens(72));
    expect(report.latest!.historyTokens).toBeGreaterThan(0);
    expect(formatContextReportLine(report)).toContain("requests=2");

    // A new turn starts from zero; the session keeps counting.
    accumulator.addRequest(second, { input: 10, cacheRead: 500, cacheWrite: 0, output: 1 });
    const next = accumulator.report({ calibrationRatio: null });
    expect(next.turn.requests).toBe(1);
    expect(next.session.requests).toBe(3);
  });

  it("counts superseded, repeated and never-referenced reads", () => {
    const ledger = ledgerWithCalls();
    const messages = conversation();
    // The agent names a.ts later but never b.ts.
    messages.push({ role: "assistant", content: [{ type: "text", text: "Fixed a.ts." }] }, { role: "user", content: "thanks" });
    const stats = toolResultStats(ledger.snapshot(shape(messages)), messages, ledger);
    expect(stats.count).toBe(4);
    expect(stats.superseded).toEqual({ count: 1, tokens: estimateTokens(360) });
    expect(stats.unreferenced.count).toBe(1);
    expect(stats.repeatedReads).toEqual([{ path: "src/a.ts", reads: 2 }]);
  });

  it("counts recovery calls", () => {
    const accumulator = new ContextReportAccumulator();
    accumulator.noteToolCall("tool_output_page");
    accumulator.noteToolCall("file_read");
    accumulator.noteToolCall("tool_output_search");
    expect(accumulator.report({ calibrationRatio: null }).recoveryCalls).toBe(2);
  });
});

describe("layout", () => {
  const pieces = {
    requestProfile: "PROFILE",
    skills: "SKILLS",
    workspace: { combined: "COMBINED", stable: "STABLE", live: "LIVE" },
    runNotice: "NOTICE",
    checklist: "CHECKLIST",
  };

  it("with stable caching off, carries exactly the old single block at the tail", () => {
    expect(layoutAttachedContext(pieces, false)).toEqual({
      stable: "",
      live: "PROFILE\n\nSKILLS\n\nCOMBINED\n\nNOTICE\n\nCHECKLIST",
    });
  });

  it("with stable caching on, moves profile, skills and stable workspace state out of the tail", () => {
    expect(layoutAttachedContext(pieces, true)).toEqual({
      stable: "PROFILE\n\nSKILLS\n\nSTABLE",
      live: "LIVE\n\nNOTICE\n\nCHECKLIST",
    });
  });

  it("keeps what changes between tool rounds live", () => {
    for (const key of ["activeFile", "openEditors", "diagnostics", "git", "plans", "tickets", "localMap"] as const) {
      expect(WORKSPACE_SECTION_STABILITY[key]).toBe("call");
    }
    for (const key of ["instructions", "projectMemory", "skillRoster", "projectShape"] as const) {
      expect(WORKSPACE_SECTION_STABILITY[key]).toBe("session");
    }
  });
});

describe("context flags", () => {
  it("falls back to the baseline for anything missing or mistyped", () => {
    expect(readContextFlags(() => undefined)).toEqual(BASELINE_CONTEXT_FLAGS);
    expect(readContextFlags((key) => (key === "blacksite.context.report" ? "yes" : true))).toEqual({ ...BASELINE_CONTEXT_FLAGS, stableCaching: true });
    expect(readContextFlags(() => { throw new Error("boom"); })).toEqual(BASELINE_CONTEXT_FLAGS);
    const values: Record<string, unknown> = {
      "blacksite.context.historyBudgetTokens": 150_000.7,
      "blacksite.context.aging": "observe",
      "blacksite.context.inlineResultChars": 50, // below the range
      "blacksite.context.awareness": "status+tool",
    };
    expect(readContextFlags((key) => values[key])).toEqual({
      ...BASELINE_CONTEXT_FLAGS, historyBudgetTokens: 150_000, aging: "observe", awareness: "status+tool",
    });
    expect(readContextFlags((key) => (key === "blacksite.context.historyBudgetTokens" ? "150000" : undefined)).historyBudgetTokens).toBe(0);
  });

  it("declares every flag in package.json with its baseline as the default", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const properties = Object.assign({}, ...[pkg.contributes.configuration].flat().map((section: { properties?: object }) => section.properties ?? {}));
    for (const spec of CONTEXT_FLAGS) {
      expect(properties[spec.setting], spec.setting).toBeDefined();
      expect(properties[spec.setting].default, spec.setting).toBe(spec.baseline);
    }
  });
});
