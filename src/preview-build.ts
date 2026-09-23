import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";

/**
 * Compiles a question-card preview out of the project's *real* component source.
 *
 * Bridging the stylesheet (src/preview-assets.ts) and publishing the class inventory
 * (src/preview-design-digest.ts) let a preview look like the product. They do not let it *be* the
 * product: the preview API only accepted a string of DOM-building JavaScript, so proposing a change
 * to a component still meant hand-reimplementing that component from memory and hoping the
 * reimplementation was faithful. Every such preview is a parallel artefact that can drift from the
 * thing it claims to depict, and the drift is invisible — which is precisely why previews read as
 * "a loose representation" rather than "the change".
 *
 * A mount preview instead names a real entry file and, optionally, the edits being proposed. The
 * component is bundled from the workspace with those edits applied *in memory*, so the preview is
 * the actual component rendering under the actual change, and the working tree is never touched.
 * The patch doubles as the proposal: whatever the user picks is already expressed as a concrete
 * edit rather than as a picture someone still has to translate into code.
 *
 * esbuild is loaded lazily and kept external to the host bundle. The native package is preferred
 * when the workspace has one, while the portable WebAssembly package in the VSIX is the reliable
 * fallback for every release platform. Neither cost is paid at activation by sessions that never
 * mount a preview.
 */

export interface PreviewPatch {
  /** Workspace-relative file the edit applies to. */
  file: string;
  /** Exact substring to replace. Must occur in the file, or the build fails loudly rather than
   *  rendering a preview that silently omits the change it was supposed to show. */
  find: string;
  replace: string;
  /** Replace every occurrence instead of requiring exactly one. */
  all?: boolean;
}

export interface PreviewMount {
  /** Workspace-relative entry module, e.g. "src/components/Button.tsx". */
  entry: string;
  /** Named export to render; defaults to the default export. */
  export?: string;
  /** Props passed to the component. Must be JSON-serialisable. */
  props?: unknown;
  patch?: PreviewPatch[];
  /** Render with React (default when the entry is .tsx/.jsx). A "dom" entry is called directly
   *  with the container element, for projects that are not React. */
  renderer?: "react" | "dom";
}

/** Authored preview code can import the project's installed packages and local modules. */
export interface PreviewCode {
  code: string;
  /** Workspace-relative package/directory (or a file within it) to resolve imports from. This is
   *  primarily for monorepos, where dependencies may belong to apps/web rather than the root. */
  resolveFrom?: string;
}

export interface PreviewBuildResult {
  ok: boolean;
  /** Bundled ESM ready to inline as the preview's module code. */
  code?: string;
  /** CSS esbuild extracted from component-level imports, to inject alongside the project sheet. */
  css?: string;
  error?: string;
  /** Files whose contents were overlaid, for reporting back to the agent. */
  patchedFiles?: string[];
  warnings?: string[];
}

const SOURCE_LOADERS: Record<string, string> = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js",
  ".css": "css", ".json": "json",
};

/**
 * Visual imports must remain usable inside an opaque sandboxed blob frame. Emitting files would
 * leave the bundle pointing at paths that do not exist in that frame; data URLs keep the mounted
 * project surface self-contained and let real UI, illustration, video, and 3D entries render with
 * the same assets they import in production.
 */
const VISUAL_ASSET_LOADERS: Record<string, import("esbuild").Loader> = {
  ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl",
  ".webp": "dataurl", ".avif": "dataurl", ".svg": "dataurl", ".ico": "dataurl",
  ".bmp": "dataurl",
  ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".otf": "dataurl",
  ".eot": "dataurl",
  ".mp3": "dataurl", ".wav": "dataurl", ".ogg": "dataurl", ".mp4": "dataurl",
  ".webm": "dataurl",
  ".glb": "dataurl", ".gltf": "dataurl", ".obj": "dataurl", ".fbx": "dataurl",
  ".stl": "dataurl", ".hdr": "dataurl", ".exr": "dataurl", ".ktx2": "dataurl",
  ".basis": "dataurl", ".dds": "dataurl", ".wasm": "dataurl",
  ".glsl": "text", ".vert": "text", ".frag": "text", ".wgsl": "text",
};

/** A preview is copied through the extension host, webview bridge, comparison panel, and iframe.
 *  Bounding the self-contained payload prevents one unoptimised model/texture or dependency graph
 *  from multiplying into hundreds of MB and taking down VS Code's renderer process. */
const MAX_PREVIEW_BUNDLE_CHARS = 4 * 1024 * 1024;

/** stdin name for authored `code`; build errors are reported against it as "code". */
const AUTHORED_PREVIEW_FILE = "__blacksite_authored_preview__.tsx";

function previewBundleSizeError(js: string, css = ""): string | null {
  const total = js.length + css.length;
  if (total <= MAX_PREVIEW_BUNDLE_CHARS) return null;
  return `Preview bundle is ${(total / 1024 / 1024).toFixed(1)} MB, above the 4 MB sandbox budget. `
    + "Import a smaller/browser-focused entry, optimise large textures/models, or use procedural visuals; "
    + "the limit prevents the preview payload from exhausting VS Code's renderer memory.";
}

/** Rejects entries and patch targets outside the workspace. A preview build reads and compiles
 *  arbitrary files, so the workspace boundary is the only thing standing between a malformed
 *  (or hostile) tool call and the rest of the disk. */
function resolveInside(workspaceRoot: string, relative: string): string | null {
  const resolved = path.resolve(workspaceRoot, relative);
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Applies one patch, returning null when `find` does not match so the caller can fail the build
 *  rather than ship a preview that quietly does not contain the proposed change. */
function applyPatch(contents: string, patch: PreviewPatch): string | null {
  if (!patch.find) return null;
  if (!contents.includes(patch.find)) return null;
  if (patch.all) return contents.split(patch.find).join(patch.replace);
  const first = contents.indexOf(patch.find);
  if (contents.indexOf(patch.find, first + patch.find.length) !== -1) {
    // Ambiguous single-shot replacement: refuse rather than guess which occurrence was meant.
    return null;
  }
  return contents.slice(0, first) + patch.replace + contents.slice(first + patch.find.length);
}

/**
 * The module that renders the named export into the preview document.
 *
 * `entrySpecifier` must be workspace-relative with forward slashes: an absolute Windows path in an
 * import specifier reads as a URL scheme (`C:`) and fails to resolve.
 */
function buildHarness(entrySpecifier: string, mount: PreviewMount, renderer: "react" | "dom"): string {
  const importPath = JSON.stringify(entrySpecifier);
  const exportName = JSON.stringify(mount.export ?? "default");
  const props = JSON.stringify(mount.props ?? {});
  // Read only the export that was asked for. Falling back to `mod.default` made esbuild warn
  // "Import "default" will always be undefined" on every correct named-export mount, and the
  // agent was handed that warning as though something were wrong. A miss names the real exports.
  const exportsList = `" (exports: " + (Object.keys(mod).join(", ") || "none") + ")"`;
  if (renderer === "dom") {
    return [
      `import * as mod from ${importPath};`,
      `const candidate = mod[${exportName}];`,
      `if (typeof candidate !== "function") throw new Error("Preview entry has no callable export " + ${exportName} + ${exportsList});`,
      `const host = document.createElement("div");`,
      `document.body.appendChild(host);`,
      `candidate(host, ${props});`,
    ].join("\n");
  }
  return [
    `import { createElement } from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import * as mod from ${importPath};`,
    `const Component = mod[${exportName}];`,
    `if (!Component) throw new Error("Preview entry has no export named " + ${exportName} + ${exportsList});`,
    `const host = document.createElement("div");`,
    `document.body.appendChild(host);`,
    `createRoot(host).render(createElement(Component, ${props}));`,
  ].join("\n");
}

type EsbuildApi = typeof import("esbuild");

/** A module can load even when its native binary belongs to the release builder's OS. Exercise a
 * trivial transform first, otherwise the platform mismatch only surfaces halfway through a
 * screenshot/preview request and no portable fallback gets a chance to run. */
async function usableEsbuild(candidate: EsbuildApi): Promise<EsbuildApi | null> {
  try {
    await candidate.transform("", { loader: "js" });
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Resolve an esbuild that can actually run here, preferring the workspace's native installation.
 * The VSIX is built once (on Linux) and installed on macOS, Windows, and Linux, so it never ships
 * the release builder's native esbuild package. esbuild-wasm is the bundled fallback and keeps
 * mounted previews and their screenshots functional even for a workspace with no build tools.
 */
async function loadEsbuild(workspaceRoot: string): Promise<EsbuildApi | null> {
  if (workspaceRoot) {
    try {
      const requireFromWorkspace = createRequire(path.join(workspaceRoot, "package.json"));
      const candidate = requireFromWorkspace("esbuild") as EsbuildApi;
      if (typeof candidate?.build === "function") {
        const usable = await usableEsbuild(candidate);
        if (usable) return usable;
      }
    } catch { /* no workspace esbuild; fall through to the bundled one */ }
  }
  try {
    // `esbuild-wasm` has the same Node API as esbuild but ships a portable .wasm payload instead
    // of an OS-specific executable. It is deliberately external and included in the VSIX.
    const portable = await import("esbuild-wasm") as unknown as EsbuildApi;
    if (typeof portable?.build !== "function") return null;
    await startPortableEsbuild(portable);
    return await usableEsbuild(portable);
  } catch { return null; }
}

const nodeRequire: NodeJS.Require =
  typeof require === "function" ? require : createRequire(path.join(process.cwd(), "index.js"));

/**
 * esbuild-wasm's Node API runs its WASM in a child process started as `node <its bin script>` —
 * a bare `node` looked up on PATH. That is the portable fallback's own weak point: on a machine
 * with no Node.js on PATH it cannot start, and every mount preview and every workspace code
 * preview then failed with "No usable esbuild was found". That covers machines without Node at
 * all, and macOS machines where Node lives under nvm or Homebrew and VS Code was launched from
 * the Dock without that PATH.
 *
 * VS Code already carries a Node runtime: the extension host's own executable, which behaves as
 * plain Node with ELECTRON_RUN_AS_NODE=1 (the same way VS Code starts its TypeScript server). The
 * long-lived service is spawned synchronously inside the first API call, so `spawn` is redirected
 * for exactly that call and restored before anything else can run. Outside VS Code (tests, CLI),
 * `process.execPath` is already Node and the redirect is equally correct.
 */
function startPortableEsbuild(portable: EsbuildApi): Promise<unknown> {
  const childProcess = nodeRequire("child_process") as typeof import("child_process");
  const original = childProcess.spawn;
  const runtimeEnv = process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  const redirected = function (this: unknown, command: string, args?: readonly string[], options?: import("child_process").SpawnOptions) {
    if (command === "node") {
      return original.call(childProcess, process.execPath, args ?? [], {
        ...options,
        env: { ...(options?.env ?? process.env), ...runtimeEnv },
      });
    }
    return (original as (...params: unknown[]) => unknown).call(childProcess, command, args, options);
  };
  childProcess.spawn = redirected as typeof childProcess.spawn;
  try {
    return portable.transform("", { loader: "js" }).catch(() => undefined);
  } finally {
    childProcess.spawn = original;
  }
}

/**
 * The `node_modules` directory holding the React runtime Blacksite ships for previews
 * (react, react-dom/client, scheduler — development builds only; see .vscodeignore).
 */
function bundledReactNodePath(): string | undefined {
  try { return path.dirname(path.dirname(nodeRequire.resolve("react/package.json"))); } catch { return undefined; }
}

function comparablePath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/**
 * Where esbuild may fall back to for React when the workspace has none.
 *
 * Previews are compiled with the automatic JSX runtime, so any JSX at all, even a bare `<div>`,
 * imports `react/jsx-runtime`. In a project without React installed (a game, a CLI, a Canvas
 * or plain-DOM app) that failed the build, and because question_card compiles every preview
 * first, it rejected the whole card. The bundled copy is only a fallback: a workspace that
 * resolves `react` itself always uses its own, and is never given a second copy to mix with
 * it (two Reacts in one tree break every hook).
 */
function reactFallback(resolveDir: string): string | undefined {
  try {
    createRequire(path.join(resolveDir, "__blacksite_preview__.js")).resolve("react");
    return undefined;
  } catch { /* the workspace has no React of its own */ }
  return bundledReactNodePath();
}

/** Tells the agent the bundle used Blacksite's React, so it does not assume the project has it. */
function reactFallbackWarning(metafile: import("esbuild").Metafile | undefined, workspaceRoot: string, fallback: string | undefined): string[] {
  if (!fallback || !metafile) return [];
  const root = comparablePath(fallback);
  const used = Object.keys(metafile.inputs).some((input) => comparablePath(path.resolve(workspaceRoot, input)).startsWith(root));
  return used
    ? ["React is not installed in this workspace, so JSX and react/react-dom imports used the React runtime bundled with Blacksite. Any other package still has to be installed in the workspace."]
    : [];
}

/** Keeps a syntax-error excerpt readable when the model wrote its whole preview on one line. */
function excerptAround(lineText: string, column: number): string {
  const start = Math.max(0, column - 60);
  const end = Math.min(lineText.length, column + 60);
  return `${start > 0 ? "…" : ""}${lineText.slice(start, end)}${end < lineText.length ? "…" : ""}`;
}

/**
 * Turn an esbuild failure into something the agent can act on. The old message appended "the
 * package must already be installed" to every failure, so a typo in the preview's own code sent
 * the agent looking for a package problem. Now a missing module gets that advice, a syntax error
 * gets its line, column and the text around it, and the authored entry is called `code`.
 */
function describeBuildFailure(err: unknown, prefix: string, authoredFile?: string): string {
  const errors = (err as { errors?: import("esbuild").Message[] } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const described = errors.slice(0, 3).map((error) => {
    const location = error.location;
    if (!location) return error.text;
    const file = authoredFile && location.file.endsWith(authoredFile) ? "code" : location.file;
    const near = location.lineText ? `\n  near: ${excerptAround(location.lineText, location.column)}` : "";
    return `${file}:${location.line}:${location.column}: ${error.text}${near}`;
  });
  if (errors.length > 3) described.push(`(${errors.length - 3} more error${errors.length - 3 === 1 ? "" : "s"})`);
  const unresolved = errors.some((error) => error.text.startsWith("Could not resolve"));
  const hint = unresolved
    ? "Imported packages must already be installed in this workspace dependency context; in a monorepo, set `resolveFrom` to the app/package that owns them."
    : "Fix the code at that location and try again. Preview code is compiled as TypeScript with JSX, so an object key containing \"-\" must be quoted (style={{ \"--accent\": \"red\" }}).";
  return `${prefix}:\n${described.join("\n")}\n${hint}`;
}

/** Key for matching a patched file against the paths esbuild loads. esbuild reports the path it
 *  resolved on disk, which differs from the workspace-relative join in ways that do not change
 *  the file: VS Code passes Windows workspaces with a lower-case drive letter ("c:\") while the
 *  filesystem reports "C:\", and a symlinked folder (macOS /tmp → /private/tmp, a linked projects
 *  directory) resolves to its target. Both used to make a patch silently miss, so the preview
 *  rendered the component *without* the change it claimed to show. */
function overlayKey(file: string): string {
  let resolved = path.resolve(file);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* keep the lexical path */ }
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** True when raw module code needs a workspace-aware build rather than direct sandbox execution. */
function containsImports(code: string): boolean {
  return /\bimport\s*(?:\(|["'{*]|[A-Za-z_$])|\bexport\s+(?:\*|\{[^}]*\})\s+from\s*["']|\brequire\s*\(/m.test(code);
}

/** Resolve a monorepo dependency context without allowing preview code to read outside the open
 *  workspace. A file is accepted as a convenience and resolves from its containing directory. */
function codeResolveDir(workspaceRoot: string, resolveFrom?: string): { dir?: string; error?: string } {
  if (!workspaceRoot) return { error: "Package imports in preview code need an open workspace folder." };
  if (!resolveFrom?.trim()) return { dir: path.resolve(workspaceRoot) };
  const target = resolveInside(workspaceRoot, resolveFrom.trim());
  if (!target) return { error: `Import context "${resolveFrom}" is outside the workspace.` };
  if (!fs.existsSync(target)) return { error: `Import context "${resolveFrom}" does not exist.` };
  try {
    return { dir: fs.statSync(target).isDirectory() ? target : path.dirname(target) };
  } catch {
    return { error: `Import context "${resolveFrom}" could not be read.` };
  }
}

/**
 * Bundle authored preview code against the project's dependency graph. Unlike a mount, this code
 * is the entry itself; esbuild still resolves its static package/relative imports, imported CSS,
 * shaders, images, fonts, media, and model assets into a self-contained sandbox module.
 */
export async function buildCodePreview(
  workspaceRoot: string,
  preview: PreviewCode,
): Promise<PreviewBuildResult> {
  const code = preview?.code ?? "";
  if (!code.trim()) return { ok: false, error: "Code preview requires non-empty `code`." };

  // Keep simple code usable in contexts without an open folder. Import resolution is the only
  // reason authored code needs a host build; direct DOM/Canvas/WebGL code remains self-contained.
  if (!workspaceRoot && !containsImports(code)) return { ok: true, code };

  const resolved = codeResolveDir(workspaceRoot, preview.resolveFrom);
  if (!resolved.dir) return { ok: false, error: resolved.error };
  const esbuild = await loadEsbuild(workspaceRoot);
  if (!esbuild) {
    // Nothing to resolve, so plain JavaScript still runs as written. Only TS/JSX syntax needed
    // the compiler, and that is worth a warning rather than refusing the whole preview.
    if (!containsImports(code)) {
      return {
        ok: true,
        code,
        warnings: ["esbuild is unavailable, so this code runs untranspiled — plain JavaScript works; TypeScript or JSX syntax will throw."],
      };
    }
    return {
      ok: false,
      error: "No usable esbuild was found, so preview imports cannot be bundled. Install esbuild "
        + "in the workspace (`npm i -D esbuild`) or use self-contained preview code.",
    };
  }

  const fallback = reactFallback(resolved.dir);
  try {
    const result = await esbuild.build({
      absWorkingDir: workspaceRoot,
      stdin: {
        contents: code,
        resolveDir: resolved.dir,
        // TSX is a permissive authored-preview surface: it accepts JS, TypeScript, JSX, and TSX.
        loader: "tsx",
        sourcefile: AUTHORED_PREVIEW_FILE,
      },
      nodePaths: fallback ? [fallback] : [],
      metafile: !!fallback,
      bundle: true,
      write: false,
      outfile: path.join(workspaceRoot, "__blacksite_code_preview__.js"),
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      jsx: "automatic",
      jsxImportSource: "react",
      loader: VISUAL_ASSET_LOADERS,
      define: { "process.env.NODE_ENV": '"development"', global: "globalThis" },
      logLevel: "silent",
    });
    const js = result.outputFiles?.find((file) => file.path.endsWith(".js"));
    const css = result.outputFiles?.find((file) => file.path.endsWith(".css"));
    if (!js) return { ok: false, error: "Preview code build produced no JavaScript output." };
    const sizeError = previewBundleSizeError(js.text, css?.text);
    if (sizeError) return { ok: false, error: sizeError };
    const warnings = [
      ...reactFallbackWarning(result.metafile, workspaceRoot, fallback),
      ...(result.warnings ?? []).slice(0, 5).map((warning) => warning.text),
    ];
    return {
      ok: true,
      code: js.text,
      css: css?.text,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    return { ok: false, error: describeBuildFailure(err, "Preview code build failed", AUTHORED_PREVIEW_FILE) };
  }
}

/**
 * Bundle a mount preview. Returns `ok: false` with a readable message for every failure mode the
 * agent can correct — a missing entry, an unmatched patch, an absent React — because those
 * messages are the only feedback it gets before the user sees the result.
 */
export async function buildMountPreview(
  workspaceRoot: string,
  mount: PreviewMount,
): Promise<PreviewBuildResult> {
  if (!workspaceRoot) return { ok: false, error: "Mount previews need an open workspace folder." };
  if (!mount?.entry) return { ok: false, error: "Mount preview requires an `entry` file path." };

  const entryPath = resolveInside(workspaceRoot, mount.entry);
  if (!entryPath) return { ok: false, error: `Entry "${mount.entry}" is outside the workspace.` };
  if (!fs.existsSync(entryPath)) return { ok: false, error: `Entry "${mount.entry}" does not exist.` };

  const overlay = new Map<string, string>();
  /** Overlay key → the patch's file as the agent wrote it, for naming a patch that never applied. */
  const overlayFiles = new Map<string, string>();
  const patchedFiles: string[] = [];
  for (const patch of mount.patch ?? []) {
    const resolvedTarget = resolveInside(workspaceRoot, patch.file);
    if (!resolvedTarget) return { ok: false, error: `Patch target "${patch.file}" is outside the workspace.` };
    const target = overlayKey(resolvedTarget);
    let contents = overlay.get(target);
    if (contents === undefined) {
      try { contents = fs.readFileSync(resolvedTarget, "utf8"); }
      catch { return { ok: false, error: `Patch target "${patch.file}" could not be read.` }; }
    }
    const patched = applyPatch(contents, patch);
    if (patched === null) {
      return {
        ok: false,
        error: `Patch for "${patch.file}" did not apply: \`find\` must match the file exactly and, `
          + "unless `all` is set, match exactly once. Read the file and copy the snippet verbatim.",
      };
    }
    overlay.set(target, patched);
    overlayFiles.set(target, patch.file);
    if (!patchedFiles.includes(patch.file)) patchedFiles.push(patch.file);
  }

  const ext = path.extname(entryPath).toLowerCase();
  const renderer: "react" | "dom" = mount.renderer ?? (ext === ".tsx" || ext === ".jsx" ? "react" : "dom");

  const esbuild = await loadEsbuild(workspaceRoot);
  if (!esbuild) {
    return {
      ok: false,
      error: "No usable esbuild was found, so mount previews cannot be built here. Install esbuild "
        + "in the workspace (`npm i -D esbuild`) or author the preview with `code` instead.",
    };
  }

  const applied = new Set<string>();
  const overlayPlugin: import("esbuild").Plugin = {
    name: "blacksite-preview-overlay",
    setup(build) {
      if (overlay.size === 0) return;
      // Broad filter with a null fall-through: esbuild continues to the default loader for any
      // path this overlay does not hold, which is cheaper to reason about than escaping every
      // patched path into one regex.
      build.onLoad({ filter: /.*/ }, (args) => {
        const key = overlayKey(args.path);
        const patched = overlay.get(key);
        if (patched === undefined) return null;
        applied.add(key);
        const loader = SOURCE_LOADERS[path.extname(args.path).toLowerCase()] ?? "js";
        return { contents: patched, loader: loader as import("esbuild").Loader };
      });
    },
  };

  // Relative, forward-slashed, and explicitly "./"-prefixed so esbuild resolves it as a path
  // rather than as a bare package specifier.
  const entrySpecifier = `./${path.relative(workspaceRoot, entryPath).split(path.sep).join("/")}`;

  const fallback = reactFallback(workspaceRoot);
  try {
    const result = await esbuild.build({
      absWorkingDir: workspaceRoot,
      stdin: {
        contents: buildHarness(entrySpecifier, mount, renderer),
        resolveDir: workspaceRoot,
        loader: "js",
      },
      nodePaths: fallback ? [fallback] : [],
      metafile: !!fallback,
      bundle: true,
      write: false,
      // Named so the in-memory outputs have real extensions to distinguish JS from extracted CSS —
      // a stdin build with no outfile labels everything "<stdout>". Nothing is written to disk.
      outfile: path.join(workspaceRoot, "__blacksite_preview__.js"),
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      jsx: "automatic",
      jsxImportSource: "react",
      loader: VISUAL_ASSET_LOADERS,
      // Previews are read-only depictions; a component reaching for process.env should see a
      // development build rather than crash on an undefined global inside the sandbox.
      define: { "process.env.NODE_ENV": '"development"', global: "globalThis" },
      logLevel: "silent",
      plugins: [overlayPlugin],
    });

    const js = result.outputFiles?.find((file) => file.path.endsWith(".js"));
    const css = result.outputFiles?.find((file) => file.path.endsWith(".css"));
    if (!js) return { ok: false, error: "Preview build produced no JavaScript output." };
    // A patch whose file the bundle never loaded is a preview that does not show its own change.
    // Say so instead of rendering the unmodified component as if it were the proposal.
    const unapplied = [...overlay.keys()].filter((key) => !applied.has(key)).map((key) => overlayFiles.get(key) ?? key);
    if (unapplied.length) {
      return {
        ok: false,
        error: `Patch for ${unapplied.map((file) => `"${file}"`).join(", ")} was not applied: `
          + `${unapplied.length > 1 ? "those files are" : "that file is"} not imported by "${mount.entry}", `
          + "so the preview would render without the change. Patch a file the entry actually imports, or mount a different entry.",
      };
    }
    const sizeError = previewBundleSizeError(js.text, css?.text);
    if (sizeError) return { ok: false, error: sizeError };
    const warnings = [
      ...reactFallbackWarning(result.metafile, workspaceRoot, fallback),
      ...(result.warnings ?? []).slice(0, 5).map((w) => w.text),
    ];
    return {
      ok: true,
      code: js.text,
      css: css?.text,
      patchedFiles,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    return { ok: false, error: describeBuildFailure(err, "Preview build failed") };
  }
}
