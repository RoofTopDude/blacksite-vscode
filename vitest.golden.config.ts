import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/* Codebase Map goldens that need more than a unit test may assume: this repository's full git
   history and a few minutes (tests/golden). The fast goldens run in the unit suite
   (tests/unit/map-golden.spec.ts). Same aliases as vitest.config.ts. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/webview/react", import.meta.url)),
      vscode: fileURLToPath(new URL("./tests/unit/helpers/vscode-mock.ts", import.meta.url)),
      "@blacksite/file-content": fileURLToPath(new URL("./packages/file-content/src/index.ts", import.meta.url)),
      "@blacksite/local-runtime": fileURLToPath(new URL("./packages/local-runtime/src/index.ts", import.meta.url)),
      "@blacksite-agent/llm/node": fileURLToPath(new URL("./packages/llm/src/node/index.ts", import.meta.url)),
      "@blacksite-agent/llm/testing": fileURLToPath(new URL("./packages/llm/src/testing/index.ts", import.meta.url)),
      "@blacksite-agent/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/golden/**/*.golden.spec.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
