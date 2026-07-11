import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/webview/react", import.meta.url)),
      vscode: fileURLToPath(new URL("./tests/unit/helpers/vscode-mock.ts", import.meta.url)),
      "@blacksite/file-content": fileURLToPath(new URL("../../packages/file-content/src/index.ts", import.meta.url)),
      "@blacksite/local-runtime": fileURLToPath(new URL("../../packages/local-runtime/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.spec.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
