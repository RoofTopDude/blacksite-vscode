import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFacts, runIndexJob, type IndexJobInput } from "../../src/graph/index-job.js";
import { runRelationshipJob } from "../../src/graph/relationship-job.js";
import { createFsJobIO } from "../../src/graph/worker/job-io.js";
import { GraphWorkerClient } from "../../src/graph/graph-worker-client.js";
import { diffSnapshots } from "../../src/graph/graph-indexer.js";
import { buildWorkspaceRoots } from "../../src/graph/workspace-roots.js";
import type { GraphEdge, GraphNode } from "../../src/graph/graph-model.js";

/* A two-root workspace: `web` imports a package that lives in `shared`, which
   is exactly the cross-root edge the map could not draw before 1.30. */
function writeWorkspace(base: string): void {
  const files: Record<string, string> = {
    "web/package.json": JSON.stringify({ name: "web", dependencies: { "@acme/shared": "workspace:*" } }),
    "web/src/app.ts": "import { fmt } from '@acme/shared';\nimport { Button } from './ui/button';\nexport const app = fmt(Button);\n",
    "web/src/ui/button.ts": "export const Button = 1;\n",
    "shared/package.json": JSON.stringify({ name: "@acme/shared", main: "dist/index.js" }),
    "shared/src/index.ts": "export { fmt } from './fmt';\n",
    "shared/src/fmt.ts": "export const fmt = (x: unknown) => String(x);\n",
    "shared/README.md": "See `src/fmt.ts` for the formatter.\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(base, rel, ".."), { recursive: true });
    writeFileSync(join(base, rel), content);
  }
}

describe("runIndexJob (inline, real filesystem)", () => {
  let base = "";
  let roots: ReturnType<typeof buildWorkspaceRoots> = [];
  let cachePath = "";

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "bs-index-job-"))).replace(/\\/g, "/");
    writeWorkspace(base);
    roots = buildWorkspaceRoots([{ name: "web", path: `${base}/web` }, { name: "shared", path: `${base}/shared` }]);
    cachePath = `${base}/facts.json`;
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const allFiles = [
    "web/package.json", "web/src/app.ts", "web/src/ui/button.ts",
    "shared/package.json", "shared/src/index.ts", "shared/src/fmt.ts", "shared/README.md",
  ];

  function input(overrides: Partial<IndexJobInput> = {}): IndexJobInput {
    return {
      corpusFiles: allFiles,
      indexedFiles: allFiles,
      renderedFiles: allFiles,
      rootNames: ["web", "shared"],
      seed: 1,
      prevPositions: [],
      neighborhoods: "auto",
      git: { "web/src/app.ts": [5, 1_700_000_000] },
      ...overrides,
    };
  }

  it("resolves cross-root workspace packages, docs, and relative imports in one pass", async () => {
    const io = createFsJobIO({ roots, cachePath, cooperative: true });
    const result = await runIndexJob(input(), io);
    const imports = new Map(result.imports);
    expect(imports.get("web/src/app.ts")?.sort()).toEqual(["shared/src/index.ts", "web/src/ui/button.ts"]);
    expect(imports.get("shared/src/index.ts")).toEqual(["shared/src/fmt.ts"]);
    expect(imports.get("shared/README.md")).toEqual(["shared/src/fmt.ts"]);

    const app = result.indexNodes.find((node) => node.id === "web/src/app.ts")!;
    expect(app.outDegree).toBe(2);
    expect(app.churn).toBe(5);
    expect(app.codebase).toBeTruthy();
    expect(result.topology.projects.map((p) => p.root).sort()).toEqual(["shared", "web"]);
    /* Every indexed file is laid out, not just the rendered sample. */
    expect(result.indexNodes).toHaveLength(allFiles.length);
    expect(result.indexNodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("reuses cached facts for unchanged files and re-reads only what changed", async () => {
    const first = await runIndexJob(input(), createFsJobIO({ roots, cachePath, cooperative: true }));
    expect(first.stats.factsRead).toBe(allFiles.length);

    const second = await runIndexJob(input(), createFsJobIO({ roots, cachePath, cooperative: true }));
    expect(second.stats.factsRead).toBe(0);
    expect(second.stats.factsReused).toBe(allFiles.length);

    writeFileSync(join(base, "web/src/ui/button.ts"), "import { fmt } from '@acme/shared';\nexport const Button = fmt(1);\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(base, "web/src/ui/button.ts"), later, later);
    const third = await runIndexJob(input(), createFsJobIO({ roots, cachePath, cooperative: true }));
    expect(third.stats.factsRead).toBe(1);
    expect(new Map(third.imports).get("web/src/ui/button.ts")).toEqual(["shared/src/index.ts"]);
  });

  it("re-reads cached C# files when a newly declared type could be missing from their refs", async () => {
    const csRoots = buildWorkspaceRoots([{ name: "cs", path: `${base}/cs` }]);
    mkdirSync(join(base, "cs"), { recursive: true });
    const big = Array.from({ length: 12 }, (_, i) => `namespace App.Models { public class M${i} {} }`).join("\n");
    writeFileSync(join(base, "cs/Models.cs"), big);
    writeFileSync(join(base, "cs/Use.cs"), "using App.Models;\nclass Use { M1 a; Widget w; }\n");
    const files = ["Models.cs", "Use.cs"];
    const csInput = input({ corpusFiles: files, indexedFiles: files, renderedFiles: files, rootNames: [], git: {} });
    const csCache = `${base}/cs-facts.json`;
    await runIndexJob(csInput, createFsJobIO({ roots: csRoots, cachePath: csCache, cooperative: true }));

    writeFileSync(join(base, "cs/Widget.cs"), "namespace App.Models { public class Widget {} }\n");
    const withWidget = [...files, "Widget.cs"];
    const result = await runIndexJob(
      input({ corpusFiles: withWidget, indexedFiles: withWidget, renderedFiles: withWidget, rootNames: [], git: {} }),
      createFsJobIO({ roots: csRoots, cachePath: csCache, cooperative: true }),
    );
    /* Use.cs was unchanged, but its cached refs predate `Widget`; it must be re-read. */
    expect(new Map(result.imports).get("Use.cs")?.sort()).toEqual(["Models.cs", "Widget.cs"]);
  });

  it("collects facts for files it cannot stat as absent rather than failing", async () => {
    const io = createFsJobIO({ roots, cachePath: null, cooperative: true });
    const { facts } = await collectFacts(["web/src/app.ts", "web/src/gone.ts"], io);
    expect(facts.has("web/src/app.ts")).toBe(true);
    expect(facts.has("web/src/gone.ts")).toBe(false);
  });

  it("runs through the worker client inline when no worker script exists", async () => {
    const client = new GraphWorkerClient(null);
    expect(client.usesWorker).toBe(false);
    const job = client.run("index", input(), { roots, cachePath });
    const result = await job.promise;
    expect(result.indexNodes).toHaveLength(allFiles.length);
  });

  it("caches the relationship pass against a corpus fingerprint", async () => {
    writeFileSync(join(base, "shared/src/server.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders', () => 1);\n");
    writeFileSync(join(base, "web/src/client.ts"), "export const load = () => fetch('/api/orders');\n");
    const files = [...allFiles, "shared/src/server.ts", "web/src/client.ts"];
    const relCache = `${base}/rel.json`;
    const io = () => createFsJobIO({ roots, cachePath: relCache, cooperative: true });
    const first = await runRelationshipJob({ files, topology: null }, io());
    expect(first.fromCache).toBe(false);
    const second = await runRelationshipJob({ files, topology: null }, io());
    expect(second.fromCache).toBe(true);
    expect(second.edges).toEqual(first.edges);
  });
});

/* The relationship pass moved into a job that reads files itself (and skips
   docs/tests content). It must find exactly what the in-process pass over the
   same files finds. */
describe("runRelationshipJob parity", () => {
  it("finds the same edges as buildServiceRelationships over the same files", async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "bs-rel-parity-"))).replace(/\\/g, "/");
    try {
      const files: Record<string, string> = {
        "services/users/openapi.yaml": "openapi: 3.0.0\npaths:\n  /users/{id}:\n    get:\n      operationId: getUser\n",
        "services/users/package.json": "{}",
        "services/web/package.json": "{}",
        "services/web/src/client.ts": "export async function load(id: string) { return fetch(\"http://users:3000/users/\" + id); }\n",
        "services/web/README.md": "Calls GET /users/{id} on the users service.\n",
        "services/web/src/client.test.ts": "fetch(\"http://users:3000/users/1\");\n",
      };
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(base, rel, ".."), { recursive: true });
        writeFileSync(join(base, rel), content);
      }
      const roots = buildWorkspaceRoots([{ name: "ws", path: base }]);
      const { buildServiceRelationships } = await import("../../src/graph/relationship-indexer.js");
      const expected = buildServiceRelationships(Object.entries(files).map(([path, content]) => ({ path, content })), Infinity, null).edges;
      expect(expected.some((edge) => edge.kind === "api")).toBe(true);
      const job = await runRelationshipJob({ files: Object.keys(files), topology: null }, createFsJobIO({ roots, cachePath: null, cooperative: true }));
      expect(job.edges.map((edge) => edge.id).sort()).toEqual(expected.map((edge) => edge.id).sort());
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("diffSnapshots", () => {
  const node = (id: string, inDegree = 0): GraphNode => ({ id, dir: ".", lang: "ts", sizeBytes: 1, inDegree, outDegree: 0, x: 0, y: 0, z: 0.2 });
  const edge = (from: string, to: string): GraphEdge => ({ id: `imp:${from}->${to}`, from, to, kind: "import" });

  it("reports only changed nodes and edge-set differences", () => {
    const base = { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b")] };
    const next = { nodes: [node("a"), node("b", 1), node("d")], edges: [edge("a", "b"), edge("d", "b")] };
    const delta = diffSnapshots(base, next, 7);
    expect(delta.baseSeq).toBe(7);
    expect(delta.upsertNodes.map((n) => n.id).sort()).toEqual(["b", "d"]);
    expect(delta.removeNodeIds).toEqual(["c"]);
    expect(delta.addEdges.map((e) => e.id)).toEqual(["imp:d->b"]);
    expect(delta.removeEdgeIds).toEqual([]);
  });
});
