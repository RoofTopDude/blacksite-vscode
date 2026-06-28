import * as esbuild from "../../node_modules/esbuild/lib/main.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { cpSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packages = resolve(__dirname, "../../packages");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  bundle: true,
  outfile: resolve(__dirname, "out/extension.js"),
  // playwright-core uses native binaries that can't be bundled — load from node_modules at runtime
  external: ["vscode", "playwright-core"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  alias: {
    "@blacksite/core-agent":             resolve(packages, "core-agent/src"),
    "@blacksite/local-runtime":          resolve(packages, "local-runtime/src"),
    "@blacksite/browser-bridge-protocol": resolve(packages, "browser-bridge-protocol/src"),
  },
  logLevel: "info",
};

function copyWebviewAssets() {
  const outDir = resolve(__dirname, "out/webview");
  mkdirSync(outDir, { recursive: true });
  cpSync(resolve(__dirname, "src/webview/index.html"), resolve(outDir, "index.html"));
}

if (watchMode) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyWebviewAssets();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  copyWebviewAssets();
}
