/*
  Context scorecard (docs/context-economy-implementation-plan.md, Phase 0.3).

  Replays synthetic sessions from fixtures/context-economy through a real AgentSession over a
  scripted transport, with the context report on, and records what every request carried: tokens
  per request, peak context, what rode at the uncached tail, and how much history was superseded.
  Each scenario runs under every context arm; a phase that saves tokens but costs extra rounds
  shows up as such, because rounds are reported next to tokens.

  Figures are ledger estimates (characters ÷ 3.6), not provider counts: the transport is scripted.
  They compare arms; they are not a bill.

  Writes eval-results/context-scorecard.json and .md.
*/
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelTransport, ProviderTurnStreamEvent } from "@blacksite-agent/llm";
import { AgentSession, type AgentEvent } from "../../../src/agent-session.js";
import type { ContextFlags } from "../../../src/context/flags.js";
import type { ContextReport } from "../../../src/context/report.js";
import { canonicalJson } from "../harness/canonical.js";

interface Round { path: string; chars: number }
interface Scenario { name: string; rounds: Round[] }
interface Fixture {
  attached: { instructionsChars: number; projectMemoryChars: number; skillRosterChars: number; liveChars: number };
  scenarios: Scenario[];
}

const EVAL_ROOT = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, "fixtures", "context-economy", "scenario.json"), "utf8")) as Fixture;

/** The history budget the aging arms run under: below what the larger scenarios reach. */
const AGING_BUDGET = 30_000;

const ARMS: Record<string, Partial<ContextFlags>> = {
  baseline: {},
  "stable-caching": { stableCaching: true },
  // Phase 3. `observe` must equal baseline in everything the model sees.
  "aging-observe": { historyBudgetTokens: AGING_BUDGET, aging: "observe" },
  "aging-on": { historyBudgetTokens: AGING_BUDGET, aging: "on" },
  // Phase 4. A scripted model cannot react to what it is shown, so these arms only price what
  // sight and control add; whether they change behaviour needs the live suite.
  sight: { awareness: "status" },
  "sight+control": { awareness: "status+tool" },
};

interface ScenarioScore {
  scenario: string;
  arm: string;
  rounds: number;
  requests: number;
  avgTokensPerRequest: number;
  peakContextTokens: number;
  /** Attached context at the uncached tail, per request. */
  tailTokensPerRequest: number;
  /** Attached context behind the system cache boundary, per request. */
  cachedAttachedTokensPerRequest: number;
  /** Tokens carried by all requests together: what a session pays for before cache discounts. */
  carriedTokens: number;
  toolResultTokens: number;
  supersededTokens: number;
  repeatedReads: number;
  setAside: number;
  wouldSetAside: number;
  /** Rounds spent reading set-aside output back. Scripted sessions never do; live ones will. */
  recoveryRounds: number;
}

function filler(label: string, chars: number): string {
  const line = `${label} `.repeat(8).slice(0, 79);
  return Array.from({ length: Math.ceil(chars / 80) }, () => line).join("\n").slice(0, chars);
}

function scriptedTransport(rounds: Round[]): ModelTransport & { requests: number } {
  const transport = {
    requests: 0,
    async *stream(_req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
      const n = ++transport.requests;
      const round = rounds[n - 1];
      if (round) {
        yield { type: "tool_use_block", block: { type: "tool_use", id: `read_${n}`, name: "file_read", input: { path: round.path } } };
        yield { type: "stop_reason", reason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "Summary written." };
        yield { type: "stop_reason", reason: "end_turn" };
      }
      // The report is fed on usage; zero tokens leaves every figure an estimate.
      yield { type: "usage_update", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return transport;
}

async function score(scenario: Scenario, arm: string, flags: Partial<ContextFlags>): Promise<ScenarioScore> {
  const transport = scriptedTransport(scenario.rounds);
  const a = fixture.attached;
  const stable = [
    "# Workspace: repository and project state",
    `Project instructions:\n${filler("instruction", a.instructionsChars)}`,
    `Project memory:\n${filler("memory", a.projectMemoryChars)}`,
    `Skills:\n${filler("skill", a.skillRosterChars)}`,
  ].join("\n\n");
  let refresh = 0;
  const session = new AgentSession({
    apiKey: "synthetic",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: filler("system", 20_000),
    workspaceRoot: "C:/workspace",
    checkpointingEnabled: false,
    maxIterations: scenario.rounds.length + 2,
    // The scenarios are a few rounds long; the default 20-message window would protect all of it.
    compressionKeepRecent: 4,
    modelTransport: transport,
    contextFlags: () => ({ report: true, stableCaching: false, ...flags }),
    workspaceContextProvider: async () => {
      refresh += 1;
      const live = `# Current workspace state: live\nGit: ${refresh} changed\n${filler("editor", a.liveChars)}`;
      return { combined: `${stable}\n\n${live}`, stable, live };
    },
    runtime: {
      handleMessage: vi.fn(async (message: { payload?: { path?: string } }) => {
        const round = scenario.rounds.find((r) => r.path === message.payload?.path);
        return { result: { ok: true, content: filler(round?.path ?? "file", round?.chars ?? 100) } };
      }),
    } as never,
    context: { workspaceState: { get: () => undefined, update: async () => {} } } as never,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" } as never,
  });

  let report: ContextReport | undefined;
  let rounds = 0;
  for await (const event of session.send(`Investigate (${scenario.name}).`) as AsyncGenerator<AgentEvent>) {
    if (event.type === "context_report") report = event.report;
    if (event.type === "tool_call_result") rounds += 1;
  }
  if (!report) throw new Error(`no context report for ${scenario.name}/${arm}`);
  const requests = report.session.requests;
  const carried = Object.values(report.byClass).reduce((sum, cls) => sum + cls.carriedTokens, 0);
  return {
    scenario: scenario.name,
    arm,
    rounds,
    requests,
    avgTokensPerRequest: Math.round(carried / requests),
    peakContextTokens: report.session.peakContextTokens,
    tailTokensPerRequest: report.byClass["attached-live"].avgTokens,
    cachedAttachedTokensPerRequest: report.byClass["attached-stable"].avgTokens,
    carriedTokens: carried,
    toolResultTokens: report.toolResults?.tokens ?? 0,
    supersededTokens: report.toolResults?.superseded.tokens ?? 0,
    repeatedReads: report.toolResults?.repeatedReads.reduce((sum, entry) => sum + entry.reads - 1, 0) ?? 0,
    setAside: report.aging.setAside.count,
    wouldSetAside: report.aging.wouldSetAside.count,
    recoveryRounds: report.aging.recoveredSetAside,
  };
}

function markdown(scores: ScenarioScore[]): string {
  const k = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const rows = scores.map((s) => `| ${s.scenario} | ${s.arm} | ${s.rounds} | ${s.requests} | ${k(s.avgTokensPerRequest)} | ${k(s.peakContextTokens)} | ${k(s.tailTokensPerRequest)} | ${k(s.cachedAttachedTokensPerRequest)} | ${k(s.supersededTokens)} | ${s.repeatedReads} | ${s.setAside}${s.wouldSetAside ? ` (would: ${s.wouldSetAside})` : ""} | ${s.recoveryRounds} |`);
  return [
    "# Context scorecard",
    "",
    "Ledger estimates (characters ÷ 3.6) from scripted sessions; they compare arms and are not provider counts.",
    "",
    "| Scenario | Arm | Rounds | Requests | Tokens/request | Peak | Tail/request (uncached) | Attached behind cache/request | Superseded | Repeat reads | Set aside | Recovery rounds |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

describe("context scorecard", () => {
  it("scores every scenario under every arm, deterministically", async () => {
    const scores: ScenarioScore[] = [];
    for (const scenario of fixture.scenarios) {
      for (const [arm, flags] of Object.entries(ARMS)) {
        const first = await score(scenario, arm, flags);
        const again = await score(scenario, arm, flags);
        expect(again).toEqual(first);
        scores.push(first);
      }
    }

    // Written before the checks, so a failing run still leaves the numbers to look at.
    const outDir = path.resolve(EVAL_ROOT, "..", "..", "eval-results");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "context-scorecard.json"), canonicalJson({ scores }));
    fs.writeFileSync(path.join(outDir, "context-scorecard.md"), markdown(scores));

    for (const scenario of fixture.scenarios) {
      const arm = (name: string) => scores.find((s) => s.scenario === scenario.name && s.arm === name)!;
      const baseline = arm("baseline");
      for (const name of Object.keys(ARMS)) {
        // No arm changes the work: same rounds, same requests.
        expect(arm(name).rounds, name).toBe(baseline.rounds);
        expect(arm(name).requests, name).toBe(baseline.requests);
      }
      // Shadow parity: observe records, and the model sees exactly what baseline sends.
      const observe = arm("aging-observe");
      expect({ ...observe, arm: "baseline", wouldSetAside: 0 }).toEqual(baseline);
      // Aging bounds the context, and only acts where the context passed its line.
      const aging = arm("aging-on");
      expect(aging.peakContextTokens).toBeLessThanOrEqual(baseline.peakContextTokens);
      if (baseline.peakContextTokens > AGING_BUDGET * 1.2) {
        expect(aging.setAside, scenario.name).toBeGreaterThan(0);
        expect(observe.wouldSetAside, scenario.name).toBeGreaterThan(0);
        expect(aging.avgTokensPerRequest).toBeLessThan(baseline.avgTokensPerRequest);
      }
      if (baseline.peakContextTokens < AGING_BUDGET * 0.8) expect(aging.setAside).toBe(0);
      // Sight costs a few lines; control adds one tool definition.
      expect(arm("sight").avgTokensPerRequest - baseline.avgTokensPerRequest).toBeLessThan(200);
      expect(arm("sight+control").avgTokensPerRequest - baseline.avgTokensPerRequest).toBeLessThan(1_000);

      const stable = arm("stable-caching");
      // Same work, same rounds: stable caching moves bytes, it does not change the session.
      expect(stable.rounds).toBe(baseline.rounds);
      expect(stable.rounds).toBe(scenario.rounds.length);
      expect(stable.requests).toBe(baseline.requests);
      expect(stable.supersededTokens).toBe(baseline.supersededTokens);
      // Phase 2's "done when": what rides uncached at the tail drops to roughly the live part.
      expect(baseline.cachedAttachedTokensPerRequest).toBe(0);
      expect(stable.cachedAttachedTokensPerRequest).toBeGreaterThan(0);
      expect(stable.tailTokensPerRequest).toBeLessThan(baseline.tailTokensPerRequest / 4);
      // The content carried is the same either way, give or take the two envelopes' wording.
      expect(Math.abs(stable.avgTokensPerRequest - baseline.avgTokensPerRequest)).toBeLessThan(200);
    }

  });
});
