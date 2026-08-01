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
 * esbuild is loaded lazily and kept external to the host bundle — it ships as a platform binary,
 * cannot be inlined into out/extension.js, and must not be paid for at activation by the many
 * sessions that never mount a preview.
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
  if (renderer === "dom") {
    return [
      `import * as mod from ${importPath};`,
      `const candidate = mod[${exportName}] ?? mod.default;`,
      `if (typeof candidate !== "function") throw new Error("Preview entry has no callable export " + ${exportName});`,
      `const host = document.createElement("div");`,
      `document.body.appendChild(host);`,
      `candidate(host, ${props});`,
    ].join("\n");
  }
  return [
    `import { createElement } from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import * as mod from ${importPath};`,
    `const Component = mod[${exportName}] ?? mod.default;`,
    `if (!Component) throw new Error("Preview entry has no export named " + ${exportName});`,
    `const host = document.createElement("div");`,
    `document.body.appendChild(host);`,
    `createRoot(host).render(createElement(Component, ${props}));`,
  ].join("\n");
}

/**
 * Resolve an esbuild that can actually run here, preferring the workspace's own.
 *
 * esbuild ships a platform-specific native binary, and the VSIX is packaged on one platform for
 * every platform — so the bundled copy only executes on machines matching the release runner. The
 * workspace's own install is correct for the machine by construction, and any project where
 * mounting a component is meaningful almost always has one (vite, tsup, tsc pipelines all pull it
 * in). The bundled copy stays as the fallback for a matching platform and for projects without it.
 */
async function loadEsbuild(workspaceRoot: string): Promise<typeof import("esbuild") | null> {
  if (workspaceRoot) {
    try {
      const requireFromWorkspace = createRequire(path.join(workspaceRoot, "package.json"));
      const candidate = requireFromWorkspace("esbuild") as typeof import("esbuild");
      if (typeof candidate?.build === "function") return candidate;
    } catch { /* no workspace esbuild; fall through to the bundled one */ }
  }
  try {
    const bundled = await import("esbuild");
    return typeof bundled?.build === "function" ? bundled : null;
  } catch { return null; }
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
  const patchedFiles: string[] = [];
  for (const patch of mount.patch ?? []) {
    const target = resolveInside(workspaceRoot, patch.file);
    if (!target) return { ok: false, error: `Patch target "${patch.file}" is outside the workspace.` };
    let contents = overlay.get(target);
    if (contents === undefined) {
      try { contents = fs.readFileSync(target, "utf8"); }
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

  const overlayPlugin: import("esbuild").Plugin = {
    name: "blacksite-preview-overlay",
    setup(build) {
      if (overlay.size === 0) return;
      // Broad filter with a null fall-through: esbuild continues to the default loader for any
      // path this overlay does not hold, which is cheaper to reason about than escaping every
      // patched path into one regex.
      build.onLoad({ filter: /.*/ }, (args) => {
        const patched = overlay.get(path.resolve(args.path));
        if (patched === undefined) return null;
        const loader = SOURCE_LOADERS[path.extname(args.path).toLowerCase()] ?? "js";
        return { contents: patched, loader: loader as import("esbuild").Loader };
      });
    },
  };

  // Relative, forward-slashed, and explicitly "./"-prefixed so esbuild resolves it as a path
  // rather than as a bare package specifier.
  const entrySpecifier = `./${path.relative(workspaceRoot, entryPath).split(path.sep).join("/")}`;

  try {
    const result = await esbuild.build({
      absWorkingDir: workspaceRoot,
      stdin: {
        contents: buildHarness(entrySpecifier, mount, renderer),
        resolveDir: workspaceRoot,
        loader: "js",
      },
      bundle: true,
      write: false,
      // Named so the in-memory outputs have real extensions to distinguish JS from extracted CSS —
      // a stdin build with no outfile labels everything "<stdout>". Nothing is written to disk.
      outfile: path.join(workspaceRoot, "__blacksite_preview__.js"),
      format: "esm",
      platform: "browser",
      target: "es2022",
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
    return {
      ok: true,
      code: js.text,
      css: css?.text,
      patchedFiles,
      warnings: result.warnings?.slice(0, 5).map((w) => w.text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Preview build failed: ${message}` };
  }
}
