#!/usr/bin/env node
// Capture the orchestration replay baseline: rewrite every golden file from the current code,
// then keep a dated summary of the scorecards under tests/eval/baselines/ alongside the commit it
// came from. Review the golden diff like code before committing it — a golden file that changed
// is a behaviour that changed.
//
//   npm run eval:baseline

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(process.execPath, [path.join(repo, "scripts", "run-vitest.mjs"), "vitest.eval.config.ts"], {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, UPDATE_EVAL_GOLDEN: "1" },
});
if (run.status !== 0) process.exit(run.status ?? 1);

const scorecard = path.join(repo, "eval-results", "replay-scorecard.json");
if (!existsSync(scorecard)) {
  console.error("The replay suite did not write eval-results/replay-scorecard.json.");
  process.exit(1);
}
let sha = "uncommitted";
try {
  sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
} catch { /* not a git checkout */ }
const date = new Date().toISOString().slice(0, 10);
const target = path.join(repo, "tests", "eval", "baselines", `${date}-${sha}.summary.json`);
mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(scorecard, target);
console.log(`Baseline summary: ${path.relative(repo, target)}`);
