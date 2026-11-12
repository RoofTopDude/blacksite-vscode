/* One measurement run for scripts/map-baseline.mjs, bundled with esbuild and run in its own Node
   process so the numbers carry no test-runner overhead.

     index <dir>...              rebuild over the given roots; report time, peak RSS and counts
       --edit <id>               then change one file and time how long until the index has it
     resolution <dir>            rebuild, then report import-specifier resolution per language

   Prints one JSON object on stdout. */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildPipeline, touch } from "./map-harness.js";
import { langOf, type GraphEdge } from "../../../src/graph/graph-model.js";
import { resolveTargetsFromFacts } from "../../../src/graph/scan-pipeline.js";
import type { FileFacts } from "../../../src/graph/file-facts.js";
import type { ResolveContext } from "../../../src/graph/resolve-imports.js";

const [mode, ...rest] = process.argv.slice(2);
const editFlag = rest.indexOf("--edit");
const editId = editFlag >= 0 ? rest[editFlag + 1] : undefined;
const dirs = rest.filter((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--edit");

function peakRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

async function main(): Promise<void> {
  const pipeline = buildPipeline(dirs.map((dir) => ({ name: path.basename(dir), path: dir })));
  const started = performance.now();
  await pipeline.indexer.rebuild();
  const indexMs = performance.now() - started;
  const relStarted = performance.now();
  const serviceEdges = await pipeline.relationships.fullAsync();
  const relationshipsMs = performance.now() - relStarted;
  const snapshot = pipeline.indexer.snapshot();
  const out: Record<string, unknown> = {
    mode,
    indexMs: Math.round(indexMs),
    relationshipsMs: Math.round(relationshipsMs),
    peakRssMb: peakRssMb(),
    indexedFiles: snapshot?.indexedFileCount ?? 0,
    renderedNodes: snapshot?.renderedNodeCount ?? 0,
    importEdges: pipeline.indexer.importEdges().length,
    serviceEdges: serviceEdges.length,
  };

  if (mode === "index" && editId) {
    const absolute = path.join(dirs[0]!, ...editId.split("/").slice(dirs.length > 1 ? 1 : 0));
    fs.appendFileSync(absolute, "\nexport const touchedByBaseline = 1;\n", "utf8");
    const editStarted = performance.now();
    touch(pipeline, editId);
    await pipeline.gateway.syncIndex();
    out.editMs = Math.round(performance.now() - editStarted);
    out.editSeq = pipeline.indexer.snapshot()?.seq ?? null;
  }

  if (mode === "resolution") {
    const internals = pipeline.indexer as unknown as { _facts: Map<string, FileFacts>; _resolveCtx: ResolveContext };
    const fileSet = new Set(pipeline.indexer.indexedFiles());
    const perLang = new Map<string, { files: number; specifiers: number; resolved: number; relativeUnresolved: number }>();
    for (const [rel, facts] of internals._facts) {
      if (!fileSet.has(rel)) continue;
      const lang = langOf(rel) || "(none)";
      const specs = lang === "md" ? facts.docLinks ?? [] : facts.specs ?? [];
      if (specs.length === 0) continue;
      const row = perLang.get(lang) ?? { files: 0, specifiers: 0, resolved: 0, relativeUnresolved: 0 };
      row.files += 1;
      for (const spec of specs) {
        row.specifiers += 1;
        const single: FileFacts = lang === "md" ? { ...facts, docLinks: [spec] } : { ...facts, specs: [spec] };
        if (resolveTargetsFromFacts(rel, single, fileSet, internals._resolveCtx).size > 0) row.resolved += 1;
        else if (spec.startsWith(".") || spec.startsWith("/")) row.relativeUnresolved += 1;
      }
      perLang.set(lang, row);
    }
    out.resolution = [...perLang]
      .sort((a, b) => b[1].specifiers - a[1].specifiers)
      .map(([lang, row]) => ({ lang, ...row, resolvedPct: Math.round((row.resolved / row.specifiers) * 1000) / 10 }));
    const edgesByKind = new Map<string, number>();
    for (const edge of serviceEdges as GraphEdge[]) edgesByKind.set(edge.kind, (edgesByKind.get(edge.kind) ?? 0) + 1);
    out.serviceEdgesByKind = Object.fromEntries(edgesByKind);
  }

  pipeline.dispose();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
