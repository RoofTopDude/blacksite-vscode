import * as esbuild from "../../node_modules/esbuild/lib/main.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { cpSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packages = resolve(__dirname, "../../packages");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
  absWorkingDir: __dirname,
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  bundle: true,
  outfile: resolve(__dirname, "out/extension.js"),
  tsconfig: resolve(__dirname, "tsconfig.json"),
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
  // The React webview bundle (out/webview/webview.js) is produced separately by
  // vite.webview.config.mjs. Here we only stage the HTML shell that the
  // extension host loads and injects the nonce'd script URI + CSP source into.
  const outDir = resolve(__dirname, "out/webview");
  mkdirSync(outDir, { recursive: true });
  cpSync(resolve(__dirname, "src/webview/shell.html"), resolve(outDir, "shell.html"));
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
