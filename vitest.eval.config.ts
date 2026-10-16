import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/* The orchestration replay suite (tests/eval). Kept out of the unit config so it runs once in CI,
   under its own step, and does not move the coverage ratchet. Same aliases as vitest.config.ts. */
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
    include: ["tests/eval/**/*.spec.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 30_000,
  },
});
