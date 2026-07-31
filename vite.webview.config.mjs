import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Builds the VS Code webview React entry bundles under out/webview with CSS
// injected by JS. Shared chunks are emitted beside the entry files and remain
// loadable under the webview CSP via {{cspSource}}. The extension-host bundle is
// built separately by esbuild.mjs; this config never touches it.
export default defineConfig(({ mode }) => ({
  root: rootDir,
  resolve: {
    alias: {
      "@": resolve(rootDir, "src/webview/react"),
    },
  },
  // Transform .tsx with the automatic JSX runtime regardless of tsconfig lookup.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  build: {
    outDir: resolve(rootDir, "out/webview"),
    // esbuild.mjs runs after this to copy shell.html into the freshly-cleaned dir.
    emptyOutDir: true,
    sourcemap: mode === "development",
    minify: "esbuild",
    target: "es2022",
    rollupOptions: {
      // One React entry per webview surface. Each provider loads its own bundle
      // via renderWebviewHtml (src/webview-html.ts).
      input: {
        webview: resolve(rootDir, "src/webview/react/main.tsx"),
        planning: resolve(rootDir, "src/webview/react/apps/planning/main.tsx"),
        "base-context": resolve(rootDir, "src/webview/react/apps/base-context/main.tsx"),
        data: resolve(rootDir, "src/webview/react/apps/data/main.tsx"),
        graph: resolve(rootDir, "src/webview/react/apps/graph/main.tsx"),
        notes: resolve(rootDir, "src/webview/react/apps/notes/main.tsx"),
        tickets: resolve(rootDir, "src/webview/react/apps/tickets/main.tsx"),
        board: resolve(rootDir, "src/webview/react/apps/board/main.tsx"),
        runs: resolve(rootDir, "src/webview/react/apps/runs/main.tsx"),
        "run-theater": resolve(rootDir, "src/webview/react/apps/run-theater/main.tsx"),
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  plugins: [
    tailwindcss(),
    cssInjectedByJsPlugin({
      jsAssetsFilterFunction(outputChunk) {
        return ["webview.js", "planning.js", "base-context.js", "data.js", "graph.js", "notes.js", "tickets.js", "board.js", "runs.js", "run-theater.js"].includes(outputChunk.fileName);
      },
    }),
  ],
}));
