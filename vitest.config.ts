import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./tests/unit/helpers/vscode-mock.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.spec.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
