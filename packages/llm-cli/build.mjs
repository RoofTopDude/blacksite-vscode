/* Bundles the CLI into one ESM file. @blacksite-agent/llm stays external and is loaded from
   node_modules at run time through its published "import" entry (its dist), exactly as any other
   project would install it — so building the CLI also proves the package's built output works.
   Nothing marks `vscode` external or aliases it: an import that reaches it fails this build. */
import * as esbuild from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await esbuild.build({
  entryPoints: [resolve(here, "src/cli.ts")],
  outfile: resolve(here, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@blacksite-agent/llm", "@blacksite-agent/llm/*"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
