#!/usr/bin/env node
// Live orchestration evaluation: opt-in, costs real money, never run in CI.
//
//   BLACKSITE_EVAL_API_KEY=… BLACKSITE_EVAL_MAX_USD=5 \
//     npm run eval:live -- --scenario delegation-fanout --arms baseline,enforce --repeats 3
//
// Each arm × repeat gets a fresh synthetic workspace (scripts/gen-eval-fixture.mjs), a fresh VS Code
// profile, and the real extension in an Extension Development Host. The extension's own loop or
// plan run does the work; then the scenario's verifier — which the agent never saw — judges the
// workspace it left. Results land in eval-results/live-<timestamp>/ (gitignored).
//
// Environment:
//   BLACKSITE_EVAL_API_KEY     required — the model provider's key
//   BLACKSITE_EVAL_MAX_USD     required — the spend ceiling for each arm's run
//   BLACKSITE_EVAL_PROVIDER    default "anthropic"
//   BLACKSITE_EVAL_MODEL       optional — written to blacksite.model
//   BLACKSITE_EVAL_SETTINGS    optional — JSON merged into the profile's user settings
//   VSCODE_TEST_VERSION        default "stable"

import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { generateFixture, listScenarios, readScenario } from "../../../scripts/gen-eval-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const ARM_CONTRACTS = { baseline: "off", observe: "observe", enforce: "enforce" };

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const scenarioName = option("scenario");
const arms = String(option("arms", "baseline,enforce")).split(",").filter(Boolean);
const repeats = Math.max(1, Number(option("repeats", "1")));
const apiKey = process.env.BLACKSITE_EVAL_API_KEY;
const maxUsd = Number(process.env.BLACKSITE_EVAL_MAX_USD);
const provider = process.env.BLACKSITE_EVAL_PROVIDER || "anthropic";

if (!scenarioName || !listScenarios().includes(scenarioName)) {
  console.error(`--scenario is required: ${listScenarios().join(", ")}`);
  process.exit(2);
}
if (!apiKey || !Number.isFinite(maxUsd) || maxUsd <= 0) {
  console.error("Live evaluations spend real money. Set BLACKSITE_EVAL_API_KEY and BLACKSITE_EVAL_MAX_USD (the ceiling for each arm's run).");
  process.exit(2);
}
for (const arm of arms) {
  if (!(arm in ARM_CONTRACTS)) {
    console.error(`Unknown arm "${arm}". Arms: ${Object.keys(ARM_CONTRACTS).join(", ")}`);
    process.exit(2);
  }
}

delete process.env.ELECTRON_RUN_AS_NODE;
const scenario = readScenario(scenarioName);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(repo, "eval-results", `live-${stamp}`);
await mkdir(outDir, { recursive: true });

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@invalid", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@invalid" } });
}

async function runOnce(arm, repeat) {
  const root = await mkdtemp(path.join(tmpdir(), `blacksite-eval-${scenarioName}-`));
  const workspace = path.join(root, "workspace");
  const extensionDevelopmentPath = path.join(root, "extension");
  const extensionTestsPath = path.join(root, "suite.cjs");
  try {
    generateFixture(scenarioName, workspace);
    git(workspace, "init", "-q");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "fixture");
    // The repo path contains a space, which @vscode/test-electron cannot load an extension from.
    await symlink(repo, extensionDevelopmentPath, "junction");
    await copyFile(path.join(here, "suite.cjs"), extensionTestsPath);
    const userDir = path.join(root, "user-data", "User");
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, "settings.json"), JSON.stringify({
      "blacksite.provider": provider,
      ...(process.env.BLACKSITE_EVAL_MODEL ? { "blacksite.model": process.env.BLACKSITE_EVAL_MODEL } : {}),
      "blacksite.permissions.approvalMode": "auto",
      "blacksite.updates.checkOnStartup": false,
      ...JSON.parse(process.env.BLACKSITE_EVAL_SETTINGS || "{}"),
    }, null, 2));
    const input = {
      subject: scenario.subject,
      arm,
      workContracts: ARM_CONTRACTS[arm],
      timeoutMs: (scenario.timeoutMinutes ?? 30) * 60_000,
      credentials: { [provider]: apiKey },
      ...(scenario.subject === "loop"
        ? { loop: { ...scenario.loop, maxUsd } }
        : { plan: { planId: scenario.plan.id, charter: { ...scenario.charter, maxUsd } } }),
    };
    const inputPath = path.join(root, "input.json");
    const outputPath = path.join(root, "output.json");
    await writeFile(inputPath, JSON.stringify(input));
    const startedAt = Date.now();
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      version: process.env.VSCODE_TEST_VERSION || "stable",
      extensionTestsEnv: { BLACKSITE_EVAL: "1", BLACKSITE_EVAL_INPUT: inputPath, BLACKSITE_EVAL_OUTPUT: outputPath },
      launchArgs: [
        workspace,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-release-notes",
        "--skip-welcome",
        `--user-data-dir=${path.join(root, "user-data")}`,
        `--extensions-dir=${path.join(root, "extensions")}`,
      ],
    });
    const { resultPath } = JSON.parse(await readFile(outputPath, "utf8"));
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const verify = spawnSync(process.execPath, [path.join(repo, "tests", "eval", "fixtures", scenarioName, "verify.mjs"), workspace], { encoding: "utf8", timeout: 600_000 });
    const verdicts = JSON.parse(verify.stdout.trim().split("\n").pop() || "{}");
    const tickets = scenario.subject === "loop"
      ? JSON.parse(await readFile(path.join(workspace, ".blacksite", "tickets.json"), "utf8")).tickets
      : [];
    const card = score({ arm, repeat, result, verdicts, tickets, wallMs: Date.now() - startedAt });
    await writeFile(path.join(outDir, `${scenarioName}.${arm}.${repeat}.json`), `${JSON.stringify({ card, verdicts, result }, null, 2)}\n`);
    return card;
  } finally {
    await rm(path.join(root, "extension"), { force: true, recursive: false }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The same scorecard fields the replay suite uses, from a live run's exported ledgers. */
function score({ arm, repeat, result, verdicts, tickets, wallMs }) {
  const subjects = Object.keys(verdicts);
  const done = scenario.subject === "loop"
    ? tickets.filter((ticket) => ticket.status === "review" || ticket.status === "done").map((ticket) => ticket.id)
    : (result.planRun?.steps ?? []).filter((step) => step.status === "completed").map((step) => `${step.phaseId}/${step.stepId}`);
  const verified = done.filter((subject) => verdicts[subject] === "pass").length;
  const cost = scenario.subject === "loop" ? result.loop?.totals?.usd ?? 0 : result.planRun?.spentUsd ?? 0;
  const receipts = { agree: 0, disagree: 0, unknown: 0 };
  for (const receipt of result.receipts ?? []) {
    const subject = receipt.subject?.ticketId ?? (receipt.subject?.phaseId ? `${receipt.subject.phaseId}/${receipt.subject.stepId}` : undefined);
    const verdict = subject ? verdicts[subject] : undefined;
    if (!verdict || !["verified", "failed"].includes(receipt.status)) receipts.unknown += 1;
    else if ((receipt.status === "verified") === (verdict === "pass")) receipts.agree += 1;
    else receipts.disagree += 1;
  }
  return {
    scenario: scenarioName,
    arm,
    repeat,
    subjects: subjects.length,
    verifiedSuccess: verified,
    selfReportedSuccess: done.length,
    falseCompletions: done.length - verified,
    elapsedMs: wallMs,
    costUsd: Math.round(cost * 10_000) / 10_000,
    costPerVerifiedSuccess: verified ? Math.round((cost / verified) * 10_000) / 10_000 : null,
    timedOut: result.timedOut,
    interventions: (result.planRun?.decisions ?? []).length,
    receipts,
  };
}

function summarize(cards) {
  const byArm = new Map();
  for (const card of cards) byArm.set(card.arm, [...(byArm.get(card.arm) ?? []), card]);
  const fields = ["verifiedSuccess", "falseCompletions", "selfReportedSuccess", "costUsd", "elapsedMs", "interventions"];
  const rows = [];
  for (const field of fields) {
    const cells = [...byArm].map(([, armCards]) => {
      const values = armCards.map((card) => card[field] ?? 0);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return `${Math.round(mean * 100) / 100} (${Math.min(...values)}–${Math.max(...values)})`;
    });
    rows.push(`| ${field} | ${cells.join(" | ")} |`);
  }
  return [
    `# ${scenarioName}: live evaluation`,
    "",
    `Provider ${provider}${process.env.BLACKSITE_EVAL_MODEL ? `, model ${process.env.BLACKSITE_EVAL_MODEL}` : ""}; ${repeats} repeat(s) per arm; $${maxUsd} ceiling per run. Mean (min–max).`,
    "",
    `| Metric | ${[...byArm.keys()].join(" | ")} |`,
    `| --- | ${[...byArm.keys()].map(() => "---").join(" | ")} |`,
    ...rows,
    "",
  ].join("\n");
}

const cards = [];
for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const arm of arms) {
    console.log(`▶ ${scenarioName} · ${arm} · run ${repeat}/${repeats}`);
    cards.push(await runOnce(arm, repeat));
  }
}
await writeFile(path.join(outDir, "summary.md"), summarize(cards));
await writeFile(path.join(outDir, "scorecards.json"), `${JSON.stringify(cards, null, 2)}\n`);
console.log(summarize(cards));
console.log(`Results: ${outDir}`);
