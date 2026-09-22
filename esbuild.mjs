import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { cpSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packages = resolve(__dirname, "packages");
const watchMode = process.argv.includes("--watch");

const buildOptions = {
  absWorkingDir: __dirname,
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  bundle: true,
  outfile: resolve(__dirname, "out/extension.js"),
  tsconfig: resolve(__dirname, "tsconfig.json"),
  // playwright-core drives system Chrome/Edge and can't be bundled; the VSIX keeps
  // node_modules/playwright-core so browser and retained sequence tools work after install.
  // jq-wasm's tsup-built ESM shim (import.meta.url-based __dirname resolution) breaks when
  // esbuild re-bundles it into this CJS output — load from node_modules at runtime instead
  // (see .vscodeignore's node_modules/jq-wasm/** carve-out; jq-wasm has zero dependencies).
  // esbuild ships a platform-specific native binary and resolves it relative to its own package
  // directory, so it cannot be inlined into this bundle. Preview builds prefer a workspace-native
  // copy, then use the portable esbuild-wasm runtime packaged in the VSIX.
  // heic-decode's dependency libheif-js loads a 1.4MB libheif.wasm from a path relative to its
  // own package directory (same class of problem as jq-wasm/esbuild-wasm above) — bundling it
  // would sever that relative path, so both ship as real node_modules directories instead.
  // pdfjs-dist is external for a different reason: cost, not correctness. Bundled, esbuild
  // inlines its ~1MB ESM body at the top level of this CJS output, so it was evaluated on every
  // activation — in every window, whether or not the session ever opened a PDF — because the
  // static import chain runs extension.ts -> chat-provider -> @blacksite/file-content. A dynamic
  // import() alone does NOT fix that: with one output file and no code splitting, esbuild still
  // hoists the module body. Marking it external is what actually defers it, and file-content's
  // pdf-lib.ts then loads it on first use. Only legacy/build/pdf.mjs ships (see .vscodeignore);
  // the worker is already staged to out/pdf.worker.mjs by copyPdfWorker() below.
  external: ["vscode", "playwright-core", "jq-wasm", "esbuild", "esbuild-wasm", "heic-decode", "libheif-js", "pdfjs-dist"],
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
    "@blacksite/local-runtime":          resolve(packages, "local-runtime/src"),
    "@blacksite/browser-bridge-protocol": resolve(packages, "browser-bridge-protocol/src"),
    "@blacksite/file-content":           resolve(packages, "file-content/src"),
  },
  logLevel: "info",
};

function copyWebviewAssets() {
  // The React webview bundle (out/webview/webview.js) is produced separately by
  // vite.webview.config.mjs. Here we only stage the HTML shell that the
  // extension host loads and injects the nonce'd script URI + CSP source into,
  // plus the locally-bundled webfonts the shell's @font-face rules point at
  // (fonts must live under out/ — the webviews' only localResourceRoot).
  const outDir = resolve(__dirname, "out/webview");
  mkdirSync(outDir, { recursive: true });
  cpSync(resolve(__dirname, "src/webview/shell.html"), resolve(outDir, "shell.html"));
  cpSync(resolve(__dirname, "src/webview/fonts"), resolve(outDir, "fonts"), { recursive: true });
}

/**
 * Stage the first-party skills into out/skills so SkillStore can find them in an installed
 * VSIX. They are copied rather than bundled because a skill is read as a file at runtime —
 * SKILL.md plus whatever reference/ files it carries — and because the user can shadow any
 * of them with a workspace copy, which only works if both live on disk in the same shape.
 */
function copyBundledSkills() {
  cpSync(resolve(__dirname, "skills"), resolve(__dirname, "out/skills"), { recursive: true });
}

function copyPdfWorker() {
  cpSync(
    resolve(__dirname, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    resolve(__dirname, "out/pdf.worker.mjs"),
  );
}

// The WebP decoder's glue is bundled, but emscripten would locate its .wasm through
// import.meta.url, which means nothing in this CJS output. src/webp-image.ts compiles the binary
// from out/ itself and hands it to the decoder, so stage it next to extension.js.
function copyWebpDecoder() {
  cpSync(
    resolve(__dirname, "node_modules/@jsquash/webp/codec/dec/webp_dec.wasm"),
    resolve(__dirname, "out/webp_dec.wasm"),
  );
}

if (watchMode) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyWebviewAssets();
  copyBundledSkills();
  copyPdfWorker();
  copyWebpDecoder();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  copyWebviewAssets();
  copyBundledSkills();
  copyPdfWorker();
  copyWebpDecoder();
}
