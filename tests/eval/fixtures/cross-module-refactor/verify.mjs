// Independent verifier for cross-module-refactor. Every package's own tests, plus hidden checks on
// the shared helper, plus "the old name is gone". One verdict per plan step, all from the same
// evidence for each phase. Prints {"ph-1/st-1":"pass"|"fail",...} on stdout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2] ?? ".");

function packageTestsPass(relative) {
  return spawnSync(process.execPath, ["--test"], { cwd: path.join(workspace, relative), encoding: "utf8", timeout: 120_000 }).status === 0;
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : name.endsWith(".js") ? [full] : [];
  });
}

const temp = mkdtempSync(path.join(tmpdir(), "verify-refactor-"));
let helperOk = false;
try {
  const file = path.join(temp, "money.test.mjs");
  const href = pathToFileURL(path.join(workspace, "packages/money/src/money.js")).href;
  writeFileSync(file, `import assert from "node:assert/strict";
import { test } from "node:test";
import * as money from ${JSON.stringify(href)};
test("money", () => {
  assert.equal(typeof money.toMinorUnits, "function");
  assert.equal(money.toCents, undefined);
  assert.equal(money.toMinorUnits(1.005), 101);
  assert.equal(money.toMinorUnits(-1.005), -101);
  assert.equal(money.toMinorUnits(12), 1200);
});
`);
  helperOk = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", timeout: 60_000 }).status === 0;
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const moneyOk = helperOk && packageTestsPass("packages/money");
const oldNameGone = sourceFiles(workspace).every((file) => !readFileSync(file, "utf8").includes("toCents"));
const billingOk = moneyOk && oldNameGone && packageTestsPass("services/billing");
const checkoutOk = moneyOk && oldNameGone && packageTestsPass("services/checkout");
const verdict = (ok) => (ok ? "pass" : "fail");
process.stdout.write(`${JSON.stringify({
  "ph-1/st-1": verdict(helperOk),
  "ph-1/st-2": verdict(moneyOk),
  "ph-2/st-1": verdict(billingOk),
  "ph-2/st-2": verdict(checkoutOk),
})}\n`);
