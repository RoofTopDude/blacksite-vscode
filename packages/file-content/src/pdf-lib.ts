/*
  Lazy loader for pdf.js.

  pdf-reader.ts and text-extract.ts both used a module-level `import * as pdfjsLib`, which put
  pdf.js on the static import chain extension.ts -> chat-provider -> @blacksite/file-content.
  That meant ~1MB of pdf.js module body was evaluated on every activation, in every window,
  whether or not the session ever opened a PDF.

  The import() here is only half of the fix, and on its own it would have changed nothing: with a
  single output file and no code splitting, esbuild hoists a bundled ESM module's body to the top
  level regardless of how it is imported. pdfjs-dist is therefore also marked external in
  esbuild.mjs, which is what makes this a real runtime require — measured at 8.10MB -> 7.08MB of
  extension.js, with no change to VSIX size, since only legacy/build/pdf.mjs ships rather than the
  35MB package.

  Same shape as the existing dynamic imports for jimp and jq-wasm elsewhere in the tree. If pdfjs
  is ever un-externalized, this file keeps working but the activation cost comes back.
*/
import { existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";

export type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pending: Promise<PdfJsModule> | null = null;

/**
 * Resolve pdf.js, configuring its worker exactly once.
 *
 * The promise is cached rather than the module, so concurrent first callers share one import
 * instead of racing two. A failed import clears the cache so a later call can retry — a
 * transient resolution failure should not poison the feature for the rest of the session.
 */
export function loadPdfJs(): Promise<PdfJsModule> {
  pending ??= import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((pdfjsLib) => {
      configureWorker(pdfjsLib);
      return pdfjsLib;
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}

function configureWorker(pdfjsLib: PdfJsModule): void {
  try {
    // The packaged VSIX stages pdf.worker.mjs next to the bundle; a dev host resolves it out
    // of node_modules instead.
    const adjacent = typeof __dirname === "string" ? join(__dirname, "pdf.worker.mjs") : "";
    const workerPath = adjacent && existsSync(adjacent)
      ? adjacent
      : createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();
  } catch {
    // pdf.js falls back to its Node fake-worker path when this URL cannot be resolved.
  }
}
