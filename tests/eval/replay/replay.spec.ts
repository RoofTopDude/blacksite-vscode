/* Deterministic replays of synthetic orchestration traces through the real loop and plan-run
   services, under each work-contracts arm. Each replay runs three times and must be byte-identical,
   then match its golden file. Refresh golden files with UPDATE_EVAL_GOLDEN=1 after an intended
   change, and review the diff like code. */

import * as fs from "fs";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../harness/canonical.js";
import { ARMS, armsFor, EVAL_ROOT, goldenPath, loadTraces, replay, withoutContractRecords } from "../harness/run-scenarios.js";
import { compareScorecards, formatComparison, type Scorecard } from "../harness/scorecard.js";

const UPDATE = process.env.UPDATE_EVAL_GOLDEN === "1";
const scorecards: Scorecard[] = [];

describe.each(loadTraces())("$file", ({ trace }) => {
  const results = new Map<string, unknown>();

  it.each(armsFor(trace))("replays deterministically under $arm and matches its golden file", async (arm) => {
    const runs = [] as string[];
    for (let i = 0; i < 3; i += 1) runs.push(canonicalJson(await replay(trace, arm)));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
    const outcome = JSON.parse(runs[0]!) as { scorecard: Scorecard };
    scorecards.push(outcome.scorecard);
    results.set(arm.arm, JSON.parse(runs[0]!));

    const golden = goldenPath(trace.header.scenario, arm.arm);
    if (UPDATE) {
      fs.mkdirSync(path.dirname(golden), { recursive: true });
      fs.writeFileSync(golden, runs[0]!);
      return;
    }
    expect(fs.existsSync(golden), `missing golden file ${path.basename(golden)} — run npm run eval:baseline`).toBe(true);
    expect(runs[0]).toBe(fs.readFileSync(golden, "utf8").replace(/\r\n/g, "\n"));
  });

  it("is unchanged in observe mode apart from the records contracts add (shadow parity)", async () => {
    const baseline = await replay(trace, ARMS[0]!);
    const observe = await replay(trace, ARMS[1]!);
    expect(withoutContractRecords(observe)).toEqual(withoutContractRecords(baseline));
  });
});

afterAll(() => {
  if (scorecards.length === 0) return;
  const outDir = path.resolve(EVAL_ROOT, "..", "..", "eval-results");
  fs.mkdirSync(outDir, { recursive: true });
  const byScenario = new Map<string, Map<string, Scorecard>>();
  for (const card of scorecards) {
    const arms = byScenario.get(card.scenario) ?? new Map<string, Scorecard>();
    arms.set(card.arm, card);
    byScenario.set(card.scenario, arms);
  }
  const comparisons = [...byScenario].flatMap(([scenario, arms]) => {
    const baseline = arms.get("baseline");
    const enforce = arms.get("enforce");
    if (!baseline || !enforce) return [];
    const { deltas, regressed } = compareScorecards(baseline, enforce);
    return [{ scenario, regressed, deltas, markdown: formatComparison(scenario, deltas) }];
  });
  fs.writeFileSync(path.join(outDir, "replay-scorecard.json"), canonicalJson({ scorecards, comparisons: comparisons.map(({ markdown: _markdown, ...rest }) => rest) }));
  fs.writeFileSync(path.join(outDir, "replay-scorecard.md"), ["# Orchestration replay: baseline vs enforce", "", ...comparisons.map((entry) => entry.markdown)].join("\n"));
});
