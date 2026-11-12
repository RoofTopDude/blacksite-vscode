#!/usr/bin/env node
/* Codebase Map performance and resolution baselines (docs/map-sdk-implementation-plan.md,
   Phase 1). Later phases compare against these numbers.

     node scripts/map-baseline.mjs [--files 20000] [--keep]

   1. Bundles tests/golden/map/baseline-entry.ts (vscode aliased to the unit-test mock).
   2. Generates the two-root scale fixture (scripts/gen-map-fixture.mjs) in a temp directory.
   3. Cold index (no caches), then warm index (caches from the cold run) plus one file edit,
      each in a fresh Node process so peak RSS is that run's alone.
   4. Import resolution per language over this repository at the pinned golden commit.

   Indexing runs inline on the measuring thread (no worker), like the golden tests; the extension
   normally runs the heavy pass in a worker, so treat these as relative numbers, not as what a
   user waits for. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const filesFlag = args.indexOf("--files");
const fileCount = filesFlag >= 0 ? Number(args[filesFlag + 1]) : 20_000;
const keep = args.includes("--keep");
const PINNED_COMMIT = "a60475f74f6b0ca8230e832bcdd3126980064c63";

const work = realpathSync.native(mkdtempSync(join(tmpdir(), "map-baseline-")));
const bundle = join(work, "baseline.cjs");
await build({
  entryPoints: [join(repoRoot, "tests/golden/map/baseline-entry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: bundle,
  alias: { vscode: join(repoRoot, "tests/unit/helpers/vscode-mock.ts") },
  logLevel: "warning",
});

const run = (...argv) => JSON.parse(execFileSync(process.execPath, [bundle, ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const fixture = join(work, "fixture");
execFileSync(process.execPath, [join(repoRoot, "scripts/gen-map-fixture.mjs"), fixture, "--files", String(fileCount)], { stdio: "ignore" });
const roots = [join(fixture, "front"), join(fixture, "services")];

const cold = run("index", ...roots);
const warm = run("index", ...roots, "--edit", "front/apps/web/src/api/orders.ts");

const repo = join(work, "repo");
execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, repo], { stdio: "ignore" });
execFileSync("git", ["-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", PINNED_COMMIT], { cwd: repo, stdio: "ignore" });
const resolution = run("resolution", repo);

const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  fixtureFiles: fileCount,
  cold,
  warm,
  repo: { commit: PINNED_COMMIT, ...resolution },
};
console.log(JSON.stringify(report, null, 2));

if (!keep) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
else console.error(`kept ${work}`);
