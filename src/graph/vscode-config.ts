/* The extension's Codebase Map settings (`blacksite.graph.*`), read from VS Code and resolved by
   the pure rules in config.ts. */

import * as vscode from "vscode";
import {
  readLandingView,
  resolveGraphCapacity,
  resolveGraphExclusions,
  resolveNeighborhoodMode,
  resolveTraceFadeSeconds,
  type GraphConfig,
} from "./config.js";

/** Where the extension keeps the Map's derived state under the first workspace root. Never
    indexed (it is the policy's neverIndex). */
export const BLACKSITE_STATE_DIR = ".blacksite";

export function readGraphConfig(): GraphConfig {
  const cfg = vscode.workspace.getConfiguration("blacksite.graph");
  const capacity = resolveGraphCapacity({
    performanceProfile: cfg.get("performanceProfile"),
    maxNodes: cfg.get("maxNodes"),
    maxIndexedFiles: cfg.get("maxIndexedFiles"),
    maxRenderedStars: cfg.get("maxRenderedStars"),
    maxRelationshipEdges: cfg.get("maxRelationshipEdges"),
  });
  const exclusions = resolveGraphExclusions({
    excludeDotDirectories: cfg.get("excludeDotDirectories"),
    dotDirectoryAllowlist: cfg.get("dotDirectoryAllowlist"),
    respectGitignore: cfg.get("respectGitignore"),
  });
  return {
    ...capacity,
    ...exclusions,
    neverIndex: [BLACKSITE_STATE_DIR],
    traceFadeSeconds: resolveTraceFadeSeconds(cfg.get<number>("traceFadeSeconds", 45)),
    traceShellEvents: cfg.get<boolean>("traceShellEvents", true),
    neighborhoods: resolveNeighborhoodMode(cfg.get("neighborhoods")),
    backgroundSymbols: cfg.get<boolean>("backgroundSymbols", false),
    landingView: readLandingView(cfg.get("landingView")),
  };
}
