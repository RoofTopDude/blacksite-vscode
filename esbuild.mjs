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
  // playwright-core uses native binaries that can't be bundled — load from node_modules at runtime.
  // jq-wasm's tsup-built ESM shim (import.meta.url-based __dirname resolution) breaks when
  // esbuild re-bundles it into this CJS output — load from node_modules at runtime instead
  // (see .vscodeignore's node_modules/jq-wasm/** carve-out; jq-wasm has zero dependencies).
  external: ["vscode", "playwright-core", "jq-wasm"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  // pdfjs-dist uses `new DOMMatrix()` at module-level for canvas rendering. That API
  // doesn't exist in Node.js (the VS Code extension host). We only use pdfjs for text
  // extraction (getTextContent), which never touches the canvas path — so a minimal
  // stub that satisfies the initializer without throwing is sufficient.
  banner: {
    js: [
      `if (typeof globalThis.DOMMatrix === 'undefined') {`,
      `  globalThis.DOMMatrix = function DOMMatrix(init) {`,
      `    var m = Array.isArray(init) ? init : [];`,
      `    this.a  = m[0] !== undefined ? m[0] : 1; this.b  = m[1] !== undefined ? m[1] : 0;`,
      `    this.c  = m[2] !== undefined ? m[2] : 0; this.d  = m[3] !== undefined ? m[3] : 1;`,
      `    this.e  = m[4] !== undefined ? m[4] : 0; this.f  = m[5] !== undefined ? m[5] : 0;`,
      `    this.m11=this.a; this.m12=this.b; this.m21=this.c; this.m22=this.d; this.m41=this.e; this.m42=this.f;`,
      `    this.is2D = true; this.isIdentity = false;`,
      `  };`,
      `  globalThis.DOMMatrix.fromFloat64Array = function(a) { return new globalThis.DOMMatrix(Array.from(a)); };`,
      `  globalThis.DOMMatrix.fromMatrix = function(m) { return new globalThis.DOMMatrix([m.a,m.b,m.c,m.d,m.e,m.f]); };`,
      `  var _p = globalThis.DOMMatrix.prototype;`,
      `  _p.translate = function(x,y) { return new globalThis.DOMMatrix([this.a,this.b,this.c,this.d,this.e+(x||0),this.f+(y||0)]); };`,
      `  _p.scale = function(sx,sy) { return new globalThis.DOMMatrix([this.a*(sx||1),this.b*(sy||1),this.c*(sx||1),this.d*(sy||1),this.e,this.f]); };`,
      `  _p.multiply = _p.multiplySelf = _p.preMultiplySelf = function() { return this; };`,
      `  _p.invertSelf = _p.inverse = function() { return new globalThis.DOMMatrix(); };`,
      `  _p.transformPoint = function(p) { return p || { x:0, y:0, z:0, w:1 }; };`,
      `  _p.toFloat32Array = _p.toFloat64Array = function() { return new Float64Array([this.a,this.b,this.c,this.d,this.e,this.f]); };`,
      `}`,
    ].join("\n"),
  },
  alias: {
    "@blacksite/core-agent":             resolve(packages, "core-agent/src"),
    "@blacksite/local-runtime":          resolve(packages, "local-runtime/src"),
    "@blacksite/browser-bridge-protocol": resolve(packages, "browser-bridge-protocol/src"),
    "@blacksite/file-content":           resolve(packages, "file-content/src"),
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
