import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

/* Boundaries for packages/llm (see the config entries that use these). */
const LLM_FORBIDDEN_PATHS = [{ name: "vscode", message: "@blacksite-agent/llm runs outside VS Code; take what you need as an argument." }];
const LLM_ESCAPES = [
  // Deep enough to leave packages/llm from any file in src/, src/node/ or test/.
  { group: ["../../../*", "../../src/*", "../../tests/*"], message: "Import from inside packages/llm only." },
  { group: ["@blacksite/*"], message: "The published package cannot depend on the extension's private packages." },
];
const LLM_NODE_BUILTINS = {
  group: ["node:*", "fs", "fs/*", "path", "os", "http", "https", "crypto", "child_process", "readline", "stream", "stream/*", "url", "util", "zlib", "net", "tls", "events"],
  message: "The core entry must stay runtime-neutral; put Node-only code under src/node.",
};

export default tseslint.config(
  {
    ignores: [
      "out/**",
      "dist/**",
      "packages/*/dist/**",
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
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Just the two classic hook-correctness rules — the plugin's bundled
      // "recommended" configs also pull in ~15 newer React Compiler rules
      // (purity, immutability, set-state-in-render, ...) this codebase has
      // never been linted against; rolling those out is a separate decision.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The webview already carries 330+ aria/role attributes and exactly one clickable
      // <div>; these rules keep that from eroding rather than demanding new work. The
      // plugin's "recommended" preset is deliberately not spread in — it turns on a wider
      // set this code has never been linted against, which is a separate decision.
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-role": ["error", { ignoreNonDOM: true }],
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "jsx-a11y/no-redundant-roles": "error",
      "jsx-a11y/tabindex-no-positive": "error",
      // Warnings, not errors: an interactive non-button element is occasionally the right
      // call in a dense tool UI, and this surfaces each one for a decision rather than
      // failing the build on it.
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
    },
  },
  {
    // The model transport package is published on its own: it may not reach back into the
    // extension, the editor API or the extension's private packages. Its core entry is also
    // runtime-neutral (fetch, Web Streams, WebCrypto) so a browser or worker can load it;
    // Node-only code lives under src/node and ships as "@blacksite-agent/llm/node".
    files: ["packages/llm/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: LLM_FORBIDDEN_PATHS, patterns: [...LLM_ESCAPES, LLM_NODE_BUILTINS] }],
    },
  },
  {
    files: ["packages/llm/src/node/**/*.ts", "packages/llm/test/**/*.ts", "packages/llm/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: LLM_FORBIDDEN_PATHS, patterns: LLM_ESCAPES }],
    },
  },
  {
    // The extension consumes the package through its public entry points only.
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["**/packages/llm/src/**", "@blacksite-agent/llm/src/*", "@blacksite-agent/llm/dist/*"], message: "Import \"@blacksite-agent/llm\", \"/node\" or \"/testing\" instead of the package's files." }],
      }],
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
