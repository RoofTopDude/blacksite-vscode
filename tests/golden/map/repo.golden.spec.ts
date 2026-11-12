/* Codebase Map golden over a real workspace: this repository at a pinned commit, with its real git
   history (docs/map-sdk-implementation-plan.md, Phase 1).

   Run with `npm run test:map-golden`. It is kept out of the unit suite because it needs the full
   history of this repository (CI checkouts are shallow) and takes longer than a unit test should.
   The checkout is a `--shared` clone in a temp directory, so the working copy is never touched,
   and it is checked out with core.autocrlf off so file sizes match on every platform.

   Same rule as tests/unit/map-golden.spec.ts: never refresh this golden to make a run pass. */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPipeline,
  captureIndex,
  createNormalizer,
  GOLDEN_CONTEXT,
  goldenJson,
  makeTempDir,
  removeDir,
  type MapPipeline,
} from "./map-harness.js";

/** The commit the Phase 1 baselines were recorded at (main, 2026-11-12). */
export const PINNED_COMMIT = "a60475f74f6b0ca8230e832bcdd3126980064c63";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function checkoutPinned(label: string): string {
  const dir = makeTempDir(label);
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, dir], { stdio: "ignore" });
  execFileSync("git", ["-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", PINNED_COMMIT], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("Codebase Map golden: this repository at the pinned commit", () => {
  let dir = "";
  let pipeline: MapPipeline;

  beforeAll(() => {
    dir = checkoutPinned("repo");
    pipeline = buildPipeline([{ name: "blacksite-vscode", path: dir }]);
  }, 120_000);

  afterAll(() => {
    pipeline?.dispose();
    if (dir) removeDir(dir);
  });

  it("indexes and answers the same way", async () => {
    await pipeline.rebuild();
    const normalize = createNormalizer(pipeline.roots);
    const { gateway } = pipeline;
    const query = (op: string, payload: Record<string, unknown>) => gateway.dispatch(op, payload, GOLDEN_CONTEXT);
    const results = {
      index: await captureIndex(pipeline, false),
      queries: {
        overview: await query("overview", { limit: 10 }),
        findGraph: await query("find", { area: "src/graph", sortBy: "dependents", limit: 15 }),
        findChurn: await query("find", { sortBy: "churn", limit: 10 }),
        relationships: await query("relationships", { paths: ["src/graph/graph-indexer.ts", "src/graph-agent-gateway.ts"], limit: 20 }),
        impact: await query("impact", { path: "src/graph/graph-model.ts", depth: 2, limit: 150 }),
        impactHistory: await query("impact", { path: "src/graph/layout.ts", layers: ["history"], direction: "both", depth: 1 }),
        routes: await query("routes", { from: "src/extension.ts", to: "src/graph/directory-pack.ts" }),
      },
      workspaceOverview: await gateway.workspaceOverview(),
      localOverview: await gateway.localOverview(["src/graph/graph-indexer.ts", "src/webview/react/lib/graph/view-model.ts"]),
    };
    await expect(goldenJson(normalize(results))).toMatchFileSnapshot("./__golden__/repo-a60475f.json");
  }, 300_000);
});
