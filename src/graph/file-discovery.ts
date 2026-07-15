/* Pure file-discovery policy for the Codebase Map. Keeping this separate from
   graph-indexer.ts makes the corpus boundary explicit and unit-testable without
   a VS Code host. Source files, standalone API contracts, and project/service
   manifests all belong in the index even when a manifest has no extension. */

import { langOf, normalizeGraphPath } from "./graph-model.js";
import { isClientConfigPath } from "./client-config.js";

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "kt", "kts", "scala", "sc", "dart",
  "rb", "php", "cs", "c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh",
  "lua", "ex", "exs", "sh", "bash", "zsh", "ksh", "fish",
  "css", "scss", "less", "html", "htm", "vue", "svelte", "cshtml", "razor",
  "json", "jsonc", "webmanifest", "md", "yaml", "yml", "toml", "mk",
  /* Standalone contracts/specifications. These were already understood by the
     relationship indexer, but previously never survived file discovery. */
  "proto", "graphql", "graphqls", "gql",
  /* Ecosystem manifests whose filename varies (for example foo.csproj or
     package.rockspec). They are useful service-boundary evidence even when the
     renderer has no language-specific import scanner for their contents. */
  "csproj", "sln", "sbt", "rockspec",
]);

const MANIFEST_NAMES = new Set([
  "package.json", "deno.json", "deno.jsonc",
  "pyproject.toml", "setup.cfg", "setup.py",
  "go.mod", "go.work", "cargo.toml",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json", "nx.json", "turbo.json", "rush.json",
  "workspace", "workspace.bazel", "module.bazel",
  "dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "gemfile", "composer.json", "pubspec.yaml", "mix.exs", "build.sbt", "package.swift",
  /* Build orchestration + Python dependency manifests: these carry inter-service
     and inter-package edges (Makefile includes, requirements editable installs)
     that were previously never surfaced. */
  "makefile", "gnumakefile",
]);

const VARIABLE_MANIFEST_RE = /(?:^|\/)(?:dockerfile(?:\.[^/]+)?|requirements[\w.-]*\.(?:txt|in)|[^/]+\.(?:csproj|sln|rockspec))$/i;

function basename(relPath: string): string {
  const normalized = normalizeGraphPath(relPath);
  return (normalized.slice(normalized.lastIndexOf("/") + 1) || normalized).toLowerCase();
}

/** Project/service manifests invalidate topology or service-boundary inference,
    so callers can choose a full rebuild when one changes. */
export function isGraphManifestPath(relPath: string): boolean {
  const normalized = normalizeGraphPath(relPath);
  return MANIFEST_NAMES.has(basename(normalized)) || VARIABLE_MANIFEST_RE.test(normalized);
}

/** Whether a workspace file contributes to the graph corpus. Client-config
    shapes (.env*, nginx conf) carry the env-var URLs and reverse-proxy routes
    that verify cross-service HTTP clients — without them, config-driven calls
    are invisible to the service lens. */
export function isGraphIndexablePath(relPath: string): boolean {
  const normalized = normalizeGraphPath(relPath);
  return SOURCE_EXTENSIONS.has(langOf(normalized)) || isGraphManifestPath(normalized) || isClientConfigPath(normalized);
}
