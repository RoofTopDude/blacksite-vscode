/* Codebase Map goldens (docs/map-sdk-implementation-plan.md, Phase 1).

   Each fixture is indexed through the same pipeline extension.ts builds, then the index, the
   agent-facing query results, and an incremental edit are compared with recorded JSON under
   tests/golden/map/__golden__. A mismatch means the Map now behaves differently. Do not update a
   golden to make a run pass — find out what changed first; refresh one (`vitest -u`) only for a
   deliberate behavior change, and say so in the commit. */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLYGLOT_FILES, POLYGLOT_HISTORY } from "../golden/map/polyglot-fixture.js";
import {
  buildPipeline,
  captureDelta,
  captureIndex,
  createNormalizer,
  GOLDEN_CONTEXT,
  goldenJson,
  makeTempDir,
  materializeFixture,
  removeDir,
  touch,
  type MapPipeline,
} from "../golden/map/map-harness.js";

const GOLDEN = "../golden/map/__golden__";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Query = [op: string, payload: Record<string, unknown>];

async function runQueries(pipeline: MapPipeline, queries: Record<string, Query>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [label, [op, payload]] of Object.entries(queries)) {
    out[label] = await pipeline.gateway.dispatch(op, payload, GOLDEN_CONTEXT);
  }
  return out;
}

describe("Codebase Map golden: polyglot fixture", () => {
  let dir = "";
  let pipeline: MapPipeline;
  let normalize: ReturnType<typeof createNormalizer>;

  /* Eleven git commits: well past the default hook timeout on a loaded machine. */
  beforeAll(() => {
    dir = materializeFixture("polyglot", POLYGLOT_FILES, POLYGLOT_HISTORY);
    pipeline = buildPipeline([{ name: "poly", path: dir }]);
    normalize = createNormalizer(pipeline.roots);
  }, 60_000);

  afterAll(() => {
    pipeline?.dispose();
    if (dir) removeDir(dir);
  });

  it("answers the same way before the first index", async () => {
    const results = {
      ...await runQueries(pipeline, {
        overview: ["overview", { limit: 10 }],
        find: ["find", {}],
        relationships: ["relationships", { path: "apps/web/src/main.ts" }],
        impact: ["impact", { path: "apps/web/src/main.ts" }],
        routes: ["routes", { from: "apps/web/src/main.ts", to: "services/users/main.go" }],
      }),
      workspaceOverview: await pipeline.gateway.workspaceOverview(),
      localOverview: await pipeline.gateway.localOverview(["apps/web/src/main.ts"]),
      hasFile: pipeline.gateway.hasFile("apps/web/src/main.ts"),
      projectRootOf: pipeline.gateway.projectRootOf("apps/web/src/main.ts") ?? null,
    };
    await expect(goldenJson(normalize(results))).toMatchFileSnapshot(`${GOLDEN}/polyglot-not-ready.json`);
  });

  it("indexes the same way", async () => {
    await pipeline.rebuild();
    await expect(goldenJson(normalize(await captureIndex(pipeline, true)))).toMatchFileSnapshot(`${GOLDEN}/polyglot-index.json`);
  });

  it("answers agent queries the same way", async () => {
    const { gateway } = pipeline;
    const queries = await runQueries(pipeline, {
      overview: ["overview", { limit: 10 }],
      findArea: ["find", { area: "apps/web" }],
      findPython: ["find", { langs: ["py"], sortBy: "dependents" }],
      findChurn: ["find", { sortBy: "churn", limit: 5 }],
      findGlob: ["find", { glob: "services/**/*.go" }],
      findContains: ["find", { contains: "controller", sortBy: "path" }],
      relationships: ["relationships", { paths: ["apps/web/src/api/client.ts", "services/orders/src/orders/app.py", "services/billing/Models/Invoice.cs"] }],
      relationshipsUnknown: ["relationships", { path: "nope/missing.ts" }],
      relationshipsNoPath: ["relationships", {}],
      impactShared: ["impact", { path: "packages/shared/src/format.ts", depth: 3 }],
      impactOrders: ["impact", { path: "services/orders/src/orders/app.py", direction: "both", layers: ["import", "service", "history"] }],
      impactOutside: ["impact", { path: "../outside.ts" }],
      routesCrossService: ["routes", { from: "apps/web/src/main.ts", to: "services/users/main.go" }],
      routesDirected: ["routes", { from: "apps/web/src/main.ts", to: "packages/shared/src/format.ts", directedOnly: true }],
      routesSame: ["routes", { from: "apps/web/src/main.ts", to: "apps/web/src/main.ts" }],
      routesNone: ["routes", { from: "scripts/orphan.ts", to: "apps/web/src/main.ts", maxHops: 2 }],
    });

    const nodeNote = await gateway.dispatch("add", {
      from: "apps/web/src/main.ts",
      note: "Entry point; render() must run after createOrder resolves.",
      title: "Startup order",
      category: "gotcha",
    }, GOLDEN_CONTEXT);
    const edgeNote = await gateway.dispatch("add", {
      from: "apps/web/src/api/client.ts",
      to: "services/orders/src/orders/app.py",
      note: "POST /api/orders is the only write path into orders.",
      category: "architecture",
      relationKind: "api",
    }, GOLDEN_CONTEXT);
    const nodeId = (nodeNote.note as { id: string }).id;
    const edgeId = (edgeNote.note as { id: string }).id;
    const notes = {
      nodeNote,
      edgeNote,
      duplicate: await gateway.dispatch("add", { from: "apps/web/src/main.ts", note: "Entry point; render() must run after createOrder resolves." }, GOLDEN_CONTEXT),
      outsideMap: await gateway.dispatch("add", { from: "nope/missing.ts", note: "x" }, GOLDEN_CONTEXT),
      list: await gateway.dispatch("list", {}, GOLDEN_CONTEXT),
      listForFile: await gateway.dispatch("list", { path: "apps/web/src/api/client.ts" }, GOLDEN_CONTEXT),
      update: await gateway.dispatch("update", { id: nodeId, note: "Entry point. render() runs after createOrder resolves.", title: "Startup order (revised)" }, GOLDEN_CONTEXT),
      impactViaNote: await gateway.dispatch("impact", { path: "services/orders/src/orders/app.py", layers: ["note"], direction: "both" }, GOLDEN_CONTEXT),
      overviewNotes: (await gateway.dispatch("overview", { limit: 5 }, GOLDEN_CONTEXT)).recentNotes,
      workspaceOverview: await gateway.workspaceOverview(),
      localOverview: await gateway.localOverview(["apps/web/src/api/client.ts", "apps/web/src/main.ts", "services/orders/src/orders/app.py"]),
      remove: await gateway.dispatch("remove", { id: edgeId }, GOLDEN_CONTEXT),
      removeMissing: await gateway.dispatch("remove", { id: "gl_missing_0" }, GOLDEN_CONTEXT),
      unknownOp: await gateway.dispatch("frobnicate", {}, GOLDEN_CONTEXT),
      listAfterRemove: await gateway.dispatch("list", {}, GOLDEN_CONTEXT),
    };

    const helpers = {
      hasFile: gateway.hasFile("apps/web/src/main.ts"),
      hasFileMissing: gateway.hasFile("apps/web/src/nope.ts"),
      importDependents: gateway.importDependents(["packages/shared/src/format.ts"]),
      projectRootOfOrders: gateway.projectRootOf("services/orders/src/orders/app.py") ?? null,
      projectRootOfReadme: gateway.projectRootOf("README.md") ?? null,
      indexableSource: gateway.isMapIndexable("apps/web/src/main.ts"),
      indexableDotDir: gateway.isMapIndexable(".github/workflows/ci.yml"),
      indexableNodeModules: gateway.isMapIndexable("node_modules/left-pad/index.js"),
      syncIndex: await gateway.syncIndex(),
    };

    await expect(goldenJson(normalize({ queries, notes, helpers }))).toMatchFileSnapshot(`${GOLDEN}/polyglot-queries.json`);
  });

  it("applies an incremental edit the same way", async () => {
    fs.writeFileSync(path.join(dir, "scripts/orphan.ts"), "import { slugify } from \"../packages/shared/src/format\";\n\nexport const orphan = slugify(\"x\");\n", "utf8");
    fs.writeFileSync(path.join(dir, "apps/web/src/ui/button.ts"), "import { render } from \"./render\";\n\nexport const button = () => render(\"ok\");\n", "utf8");
    fs.rmSync(path.join(dir, "packages/unused/src/index.ts"));
    const seqBefore = pipeline.indexer.snapshot()?.seq ?? 0;
    touch(pipeline, "scripts/orphan.ts");
    touch(pipeline, "apps/web/src/ui/button.ts");
    touch(pipeline, "packages/unused/src/index.ts");
    const sync = await pipeline.gateway.syncIndex();
    const after = pipeline.indexer.snapshot();
    const results = {
      sync,
      seqAdvanced: (after?.seq ?? 0) - seqBefore,
      baseSeqMatches: after?.delta?.baseSeq === seqBefore,
      delta: captureDelta(pipeline),
      index: await captureIndex(pipeline, true),
      relationships: await pipeline.gateway.dispatch("relationships", { paths: ["scripts/orphan.ts", "apps/web/src/ui/button.ts"] }, GOLDEN_CONTEXT),
    };
    await expect(goldenJson(normalize(results))).toMatchFileSnapshot(`${GOLDEN}/polyglot-incremental.json`);
  });
});

describe("Codebase Map golden: generated two-root fixture", () => {
  let dir = "";
  let pipeline: MapPipeline;
  let normalize: ReturnType<typeof createNormalizer>;

  beforeAll(() => {
    dir = makeTempDir("generated");
    execFileSync(process.execPath, [path.join(repoRoot, "scripts/gen-map-fixture.mjs"), dir, "--files", "2000"], { stdio: "ignore" });
    pipeline = buildPipeline([
      { name: "front", path: path.join(dir, "front") },
      { name: "services", path: path.join(dir, "services") },
    ]);
    normalize = createNormalizer(pipeline.roots);
  }, 120_000);

  afterAll(() => {
    pipeline?.dispose();
    if (dir) removeDir(dir);
  });

  it("indexes and answers the same way", async () => {
    await pipeline.rebuild();
    const results = {
      index: await captureIndex(pipeline, false),
      queries: await runQueries(pipeline, {
        overview: ["overview", { limit: 10 }],
        findDependents: ["find", { sortBy: "dependents", limit: 10 }],
        findRust: ["find", { langs: ["rs"], sortBy: "path", limit: 5 }],
        relationships: ["relationships", { paths: ["front/packages/shared/src/format/date.ts", "services/billing/src/billing/api.py", "front/apps/web/src/api/orders.ts"], limit: 10 }],
        impact: ["impact", { path: "front/packages/shared/src/index.ts", depth: 2, limit: 100 }],
        routes: ["routes", { from: "front/apps/web/src/api/orders.ts", to: "services/billing/src/billing/api.py" }],
      }),
      workspaceOverview: await pipeline.gateway.workspaceOverview(),
      localOverview: await pipeline.gateway.localOverview(["front/apps/web/src/api/orders.ts", "services/crates/cli/src/main.rs"]),
    };
    await expect(goldenJson(normalize(results))).toMatchFileSnapshot(`${GOLDEN}/generated.json`);
  }, 120_000);
});
