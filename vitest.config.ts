import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/webview/react", import.meta.url)),
      vscode: fileURLToPath(new URL("./tests/unit/helpers/vscode-mock.ts", import.meta.url)),
      "@blacksite/file-content": fileURLToPath(new URL("./packages/file-content/src/index.ts", import.meta.url)),
      "@blacksite/local-runtime": fileURLToPath(new URL("./packages/local-runtime/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.spec.ts"],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      /* Extension host and the vendored packages only. The webview React app is excluded
         on purpose: this suite runs in a node environment and never renders it, so counting
         it here would report a large permanently-uncovered block and make the thresholds
         below meaningless. It is covered by typecheck:webview and vitest.browser.config.ts.
         Restricted to .ts because a bare src/** also sweeps in shell.html and the CSS, which
         the V8 remapper cannot parse. */
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "src/webview/**",
        "**/*.d.ts",
        // Type/contract-only modules: no runtime statements to cover, so including them
        // would only dilute the percentages.
        "src/agent-loop-contract.ts",
        "src/bedrock-types.ts",
        "src/session-state.ts",
      ],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      /* A ratchet, not a target. These sit just under the measured values at the time
         coverage was introduced (statements 61.4 / branches 53.9 / functions 63.3 /
         lines 63.8), so an unrelated change that happens to shift a percentage by a
         fraction does not fail CI, while a real regression does. Raise them when the
         real numbers move up — never lower them to make a red build green. */
      thresholds: {
        statements: 60,
        branches: 52,
        functions: 62,
        lines: 62,
      },
    },
  },
});
