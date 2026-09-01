import * as vscode from "vscode";

export type GraphPerformanceProfile = "safe" | "balanced" | "large" | "extreme" | "custom";

/** Whether the map separates distinct codebases into neighborhood territories:
    "auto" decides adaptively (only for large/multi-codebase workspaces), "on"
    forces it, "off" keeps the flat layout. See graph/neighborhoods.ts. */
export type GraphNeighborhoodMode = "auto" | "on" | "off";

export interface GraphCapacityConfig {
  performanceProfile: GraphPerformanceProfile;
  maxIndexedFiles: number;
  maxRenderedStars: number;
  maxRelationshipEdges: number;
}

/** What the map never looks at. Resolved separately from capacity because it
    describes the corpus itself, not a projection of it — see graph/exclusions.ts. */
export interface GraphExclusionConfig {
  excludeDotDirectories: boolean;
  dotDirectoryAllowlist: readonly string[];
}

export interface GraphConfig extends GraphCapacityConfig, GraphExclusionConfig {
  traceFadeSeconds: number;
  traceShellEvents: boolean;
  neighborhoods: GraphNeighborhoodMode;
  /** Opt-in background LSP symbol sweep (call/reference/supertype edges over the
      whole corpus). Off by default — it's the highest-cost layer. See
      graph/symbol-indexer.ts. */
  backgroundSymbols: boolean;
}

export const PROFILE_CAPS: Record<Exclude<GraphPerformanceProfile, "custom">, Omit<GraphCapacityConfig, "performanceProfile">> = {
  safe: { maxIndexedFiles: 4000, maxRenderedStars: 2000, maxRelationshipEdges: 2000 },
  balanced: { maxIndexedFiles: 12000, maxRenderedStars: 4000, maxRelationshipEdges: 5000 },
  large: { maxIndexedFiles: 50000, maxRenderedStars: 15000, maxRelationshipEdges: 20000 },
  extreme: { maxIndexedFiles: 150000, maxRenderedStars: 50000, maxRelationshipEdges: 75000 },
};

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function capacityCap(value: unknown, min: number, max: number, fallback: number): number {
  const n = num(value);
  if (n === undefined) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function resolveGraphCapacity(raw: {
  performanceProfile?: unknown;
  maxNodes?: unknown;
  maxIndexedFiles?: unknown;
  maxRenderedStars?: unknown;
  maxRelationshipEdges?: unknown;
}): GraphCapacityConfig {
  const profile = raw.performanceProfile === "safe"
    || raw.performanceProfile === "balanced"
    || raw.performanceProfile === "large"
    || raw.performanceProfile === "extreme"
    || raw.performanceProfile === "custom"
    ? raw.performanceProfile
    : "balanced";
  const legacyMaxNodes = num(raw.maxNodes);
  const base = profile === "custom"
    ? {
      maxIndexedFiles: Math.max(legacyMaxNodes ?? PROFILE_CAPS.balanced.maxIndexedFiles, PROFILE_CAPS.balanced.maxIndexedFiles),
      maxRenderedStars: legacyMaxNodes ?? PROFILE_CAPS.balanced.maxRenderedStars,
      maxRelationshipEdges: PROFILE_CAPS.balanced.maxRelationshipEdges,
    }
    : PROFILE_CAPS[profile];
  const maxRenderedStars = capacityCap(raw.maxRenderedStars, 100, 100000, legacyMaxNodes ?? base.maxRenderedStars);
  const maxIndexedFiles = capacityCap(raw.maxIndexedFiles, 100, 250000, Math.max(base.maxIndexedFiles, maxRenderedStars, legacyMaxNodes ?? 0));
  const maxRelationshipEdges = capacityCap(raw.maxRelationshipEdges, 0, 150000, base.maxRelationshipEdges);
  return { performanceProfile: profile, maxIndexedFiles, maxRenderedStars, maxRelationshipEdges };
}

/** Coerce the exclusion settings. Pure and forgiving in the same shape as
    resolveGraphCapacity: malformed user settings resolve to the default rather
    than throwing, since a bad value here would otherwise take the whole map
    down. Allowlist entries are normalized (and dropped when unusable) by
    graph/exclusions.ts, which owns the spelling rules. */
export function resolveGraphExclusions(raw: {
  excludeDotDirectories?: unknown;
  dotDirectoryAllowlist?: unknown;
}): GraphExclusionConfig {
  const allowlist = Array.isArray(raw.dotDirectoryAllowlist)
    ? raw.dotDirectoryAllowlist.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    /* Default on: the pre-policy behavior indexed tooling state, and that was
       a bug that happened to be the status quo. Only an explicit false opts
       back into it. */
    excludeDotDirectories: raw.excludeDotDirectories !== false,
    dotDirectoryAllowlist: allowlist,
  };
}

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
  });
  return {
    ...capacity,
    ...exclusions,
    traceFadeSeconds: clamp(cfg.get<number>("traceFadeSeconds", 45), 2, 3600, 45),
    traceShellEvents: cfg.get<boolean>("traceShellEvents", true),
    neighborhoods: readNeighborhoodMode(cfg.get("neighborhoods")),
    backgroundSymbols: cfg.get<boolean>("backgroundSymbols", false),
  };
}

function readNeighborhoodMode(value: unknown): GraphNeighborhoodMode {
  return value === "on" || value === "off" ? value : "auto";
}
