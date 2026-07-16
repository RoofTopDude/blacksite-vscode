import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "out/**",
      "dist/**",
      "node_modules/**",
      "*.vsix",
      "src/webview/react/dist/**",
      "tests/integration/lsp/fixture/**",
    ],
  },
  {
    // Pre-existing eslint-disable comments (mostly for no-explicit-any, which
    // this rollout leaves off — see below) shouldn't fail the build just
    // because the rule they name is off.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-run scripts and test harnesses, not bundled/typechecked with the
    // extension host — they need Node's ambient globals, and .cjs files are
    // CommonJS by definition so requiring no-require-imports on them is moot.
    files: ["scripts/**/*.{mjs,cjs}", "tests/**/*.{mjs,cjs}"],
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Type-aware rules for the extension host source, scoped to its own tsconfig
    // so tests/ (which isn't type-checked by tsc either — see tsconfig.json's
    // "include") doesn't need a project entry of its own.
    files: ["src/**/*.ts"],
    ignores: ["src/webview/react/**"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["src/webview/react/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./src/webview/react/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Just the two classic hook-correctness rules — the plugin's bundled
      // "recommended" configs also pull in ~15 newer React Compiler rules
      // (purity, immutability, set-state-in-render, ...) this codebase has
      // never been linted against; rolling those out is a separate decision.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      // tsc already runs with noUnusedLocals/noUnusedParameters, so unused-code
      // hygiene is covered there; keep this rollout focused on the correctness
      // classes tsc can't see (floating promises, misused promises).
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
