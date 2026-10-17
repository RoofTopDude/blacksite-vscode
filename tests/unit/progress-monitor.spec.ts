import { describe, expect, it } from "vitest";
import type { ToolResultBlock, ToolUseBlock } from "@blacksite-agent/llm";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import {
  DEFAULT_PROGRESS_THRESHOLDS, ProgressMonitor, progressPrompt, resolveProgressThresholds,
} from "../../src/orchestration/progress-monitor.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

let seq = 0;
function round(name: string, input: Record<string, unknown>, result: unknown): [ToolUseBlock[], ToolResultBlock[]] {
  const id = `call-${++seq}`;
  return [[{ type: "tool_use", id, name, input }], [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result) }]];
}
const failing = (names: string[], extra: Record<string, unknown> = {}) => ({
  ok: false, passed: 2, failed: names.length, skipped: 0,
  failures: names.map((test) => ({ test, message: "expected 2, received 1" })),
  rawOutput: `FAIL\n Start at 20:${String(seq % 60).padStart(2, "0")}:00\n Duration ${seq}.0s`,
  durationMs: seq * 13,
  ...extra,
});
const passing = { ok: true, passed: 5, failed: 0, skipped: 0, failures: [], rawOutput: "ok", durationMs: 9 };
const edit = (path: string, from: string, to: string) => round("file_edit", { path, old_string: from, new_string: to }, { ok: true });
const test = (result: unknown) => round("test_run", {}, result);
const read = (path: string, content: string) => round("file_read", { path }, { ok: true, content });

function run(monitor: ProgressMonitor, rounds: Array<[ToolUseBlock[], ToolResultBlock[]]>) {
  return rounds.flatMap(([calls, results]) => monitor.observe(calls, results));
}

describe("repeated failures", () => {
  it("flags the same failure three runs running despite edits, once, with its evidence", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [
      test(failing(["parses tables"])), edit("src/a.ts", "x", "y"),
      test(failing(["parses tables"])), edit("src/a.ts", "y", "z"),
      test(failing(["parses tables"])), edit("src/a.ts", "z", "w"),
      test(failing(["parses tables"])),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "repeated_failure" });
    expect(signals[0]!.detail).toMatch(/3 test runs in a row failed the same way \(1 failing: parses tables: expected 2, received 1\) despite 2 edit\(s\)/);
    expect(monitor.facts()).toMatchObject({ checks: 4, edits: 3, signals: [{ kind: "repeated_failure" }] });
  });

  it("leaves identical reruns with no edit between them to the duplicate-round detector", () => {
    const monitor = new ProgressMonitor();
    expect(run(monitor, [test(failing(["a"])), test(failing(["a"])), test(failing(["a"])), test(failing(["a"]))])).toEqual([]);
  });

  it("does not flag genuine progress: fewer and different failures each run", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [
      test(failing(["a", "b", "c"])), edit("src/a.ts", "1", "2"),
      test(failing(["b", "c"])), edit("src/a.ts", "2", "3"),
      test(failing(["c"])), edit("src/a.ts", "3", "4"),
      test(passing),
    ]);
    expect(signals).toEqual([]);
  });

  it("starts over after a passing run", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [
      test(failing(["a"])), edit("f", "1", "2"), test(failing(["a"])), edit("f", "2", "3"),
      test(passing),
      test(failing(["a"])), edit("f", "3", "4"), test(failing(["a"])),
    ]);
    expect(signals).toEqual([]);
  });
});

describe("verification stagnation", () => {
  it("flags failure counts that never drop across five runs with edits, even as the failures change", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [
      test(failing(["a"])), edit("f", "1", "2"),
      test(failing(["b"])), edit("f", "2", "3"),
      test(failing(["c", "d"])), edit("f", "3", "4"),
      test(failing(["e", "f"])), edit("f", "4", "5"),
      test(failing(["g", "h"])),
    ]);
    expect(signals.map((signal) => signal.kind)).toEqual(["verification_stagnation"]);
    expect(signals[0]!.detail).toMatch(/5 test runs in a row have not reduced the number of failures \(1 → 2\)/);
  });
});

describe("repeated edits", () => {
  it("flags the same change applied three times", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [edit("src/a.ts", "a", "b"), edit("src/a.ts", "a", "b"), edit("src/a.ts", "a", "b")]);
    expect(signals).toEqual([expect.objectContaining({ kind: "repeated_edit", detail: expect.stringMatching(/same change to src\/a\.ts has been applied 3 times/) })]);
  });

  it("counts an edit and its undo as the same change", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [edit("src/a.ts", "a", "b"), edit("src/a.ts", "b", "a"), edit("src/a.ts", "a", "b")]);
    expect(signals.map((signal) => signal.kind)).toEqual(["repeated_edit"]);
  });

  it("ignores edits that failed, and different files", () => {
    const monitor = new ProgressMonitor();
    const failed = () => round("file_edit", { path: "src/a.ts", old_string: "a", new_string: "b" }, { ok: false, error: "no match" });
    expect(run(monitor, [failed(), failed(), failed(), edit("src/a.ts", "a", "b"), edit("src/b.ts", "a", "b")])).toEqual([]);
  });
});

describe("repeated reads", () => {
  it("flags the same read returning the same content four times with no edit between", () => {
    const monitor = new ProgressMonitor();
    const signals = run(monitor, [read("src/a.ts", "v1"), read("src/a.ts", "v1"), read("src/a.ts", "v1"), read("src/a.ts", "v1")]);
    expect(signals.map((signal) => signal.kind)).toEqual(["repeated_read"]);
  });

  it("starts over when the file is edited, or when it reads differently", () => {
    const monitor = new ProgressMonitor();
    expect(run(monitor, [
      read("src/a.ts", "v1"), read("src/a.ts", "v1"), read("src/a.ts", "v1"),
      edit("src/a.ts", "v1", "v2"),
      read("src/a.ts", "v2"), read("src/a.ts", "v3"), read("src/a.ts", "v3"),
    ])).toEqual([]);
  });
});

describe("thresholds and bounds", () => {
  it("defaults conservatively, and clamps configured values into range", () => {
    expect(resolveProgressThresholds(undefined)).toEqual(DEFAULT_PROGRESS_THRESHOLDS);
    expect(resolveProgressThresholds({ repeatedFailure: 1, repeatedRead: 999, repeatedEdit: "x", stagnation: 4 }))
      .toEqual({ ...DEFAULT_PROGRESS_THRESHOLDS, repeatedFailure: 2, repeatedRead: 30, stagnation: 4 });
  });

  it("applies a configured threshold", () => {
    const monitor = new ProgressMonitor({ repeatedEdit: 2 });
    expect(run(monitor, [edit("f", "a", "b"), edit("f", "a", "b")]).map((signal) => signal.kind)).toEqual(["repeated_edit"]);
  });

  it("raises at most twelve signals over a session", () => {
    const monitor = new ProgressMonitor({ repeatedEdit: 2 });
    const rounds = Array.from({ length: 40 }, (_, index) => [edit(`f${index}`, "a", "b"), edit(`f${index}`, "a", "b")]).flat();
    expect(run(monitor, rounds)).toHaveLength(12);
  });

  it("tells the agent when the repetition is fine, so a false positive can be waved through", () => {
    const prompt = progressPrompt({ kind: "repeated_read", key: "k", detail: "src/a.ts was read 4 times.", falsePositive: "Expected when the context was compacted." });
    expect(prompt).toMatch(/^\[Progress check\] src\/a\.ts was read 4 times\./);
    expect(prompt).toMatch(/If the repetition is intentional \(for example, when the context was compacted\), say so in one sentence and continue\./);
  });
});

describe("through a real AgentSession", () => {
  /** Reads the same file every turn: two other files in between keep the rounds from being identical. */
  async function session(mode: "observe" | "nudge" | undefined) {
    const files = ["src/a.ts", "src/b.ts", "src/a.ts", "src/c.ts", "src/a.ts", "src/b.ts", "src/a.ts", "src/c.ts", "src/a.ts"];
    const scripted = new ScriptedProviderSession(({ turnIndex }) => (turnIndex >= files.length
      ? { text: "Done.", stopReason: "end_turn" }
      : { toolCalls: [{ type: "tool_use", id: `r-${turnIndex}`, name: "file_read", input: { path: files[turnIndex] } }], stopReason: "tool_use" }));
    const agent = new AgentSession({
      apiKey: "synthetic", model: "claude-sonnet-5-5", provider: "anthropic", workspaceRoot: "C:/workspace",
      systemPrompt: "Synthetic", checkpointingEnabled: false, ...(mode ? { progressSignals: { mode } } : {}),
      providerTurnSessionFactory: () => scripted,
      context: { workspaceState: { get: () => undefined, update: async () => {} } } as never,
      runtime: { handleMessage: async () => ({ result: { ok: true, content: "export const a = 1;\n" } }) } as never,
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.send("Find the bug.")) events.push(event);
    const diagnostics = events.flatMap((event) => (event.type === "execution_diagnostic" && event.message.startsWith("Progress check") ? [event.message] : []));
    return { agent, diagnostics, nudges: scripted.userTexts.filter((text) => text.startsWith("[Progress check]")) };
  }

  it("observe reports false progress with its evidence and does not nudge", async () => {
    const { agent, diagnostics, nudges } = await session("observe");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^Progress check \(repeated read\): src\/a\.ts was read 4 times/);
    expect(nudges).toEqual([]);
    expect(agent.takeProgressSignals()).toEqual([{ kind: "repeated_read", detail: expect.stringMatching(/src\/a\.ts/) }]);
    expect(agent.takeProgressSignals()).toEqual([]);
  });

  it("nudge also asks the agent to change approach", async () => {
    const { nudges } = await session("nudge");
    expect(nudges).toHaveLength(1);
  });

  it("watches nothing while off", async () => {
    const { agent, diagnostics } = await session(undefined);
    expect(diagnostics).toEqual([]);
    expect(agent.progressFacts()).toBeUndefined();
  });
});
