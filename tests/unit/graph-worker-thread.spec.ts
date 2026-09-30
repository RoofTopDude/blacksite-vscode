import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphWorkerClient } from "../../src/graph/graph-worker-client.js";
import { buildWorkspaceRoots } from "../../src/graph/workspace-roots.js";

/* Bundles the real worker entry the way esbuild.mjs does and runs a job on an
   actual worker thread, so the bundle, the message protocol, and structured
   cloning of the result (Maps inside the resolve context) are all exercised. */
describe("graph worker thread", () => {
  let base = "";
  let workerScript = "";

  beforeAll(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "bs-graph-worker-"))).replace(/\\/g, "/");
    workerScript = `${base}/graph-worker.js`;
    await build({
      entryPoints: [resolve(__dirname, "../../src/graph/worker/graph-worker.ts")],
      bundle: true,
      outfile: workerScript,
      format: "cjs",
      platform: "node",
      target: "node20",
      external: ["vscode"],
      logLevel: "silent",
    });
    mkdirSync(`${base}/ws/src`, { recursive: true });
    writeFileSync(`${base}/ws/src/a.ts`, "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(`${base}/ws/src/b.ts`, "export const b = 1;\n");
  }, 60_000);

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("runs the index job off-thread and reports progress", async () => {
    const client = new GraphWorkerClient(workerScript);
    expect(client.usesWorker).toBe(true);
    const phases = new Set<string>();
    const files = ["src/a.ts", "src/b.ts"];
    const job = client.run("index", {
      corpusFiles: files,
      indexedFiles: files,
      renderedFiles: files,
      rootNames: [],
      seed: 1,
      prevPositions: [],
      neighborhoods: "auto",
      git: {},
    }, {
      roots: buildWorkspaceRoots([{ name: "ws", path: `${base}/ws` }]),
      cachePath: `${base}/facts.json`,
      onProgress: (phase) => phases.add(phase),
    });
    const result = await job.promise;
    expect(new Map(result.imports).get("src/a.ts")).toEqual(["src/b.ts"]);
    expect(result.resolveContext.byBasename instanceof Map).toBe(true);
    expect(phases.has("layout")).toBe(true);
  }, 30_000);

  it("cancels by terminating the worker", async () => {
    const client = new GraphWorkerClient(workerScript);
    const job = client.run("relationships", { files: ["src/a.ts"], topology: null }, {
      roots: buildWorkspaceRoots([{ name: "ws", path: `${base}/ws` }]),
      cachePath: null,
    });
    job.cancel();
    await expect(job.promise).rejects.toThrow(/cancelled/);
  }, 30_000);
});
