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

export interface GraphConfig extends GraphCapacityConfig {
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

export function readGraphConfig(): GraphConfig {
  const cfg = vscode.workspace.getConfiguration("blacksite.graph");
  const capacity = resolveGraphCapacity({
    performanceProfile: cfg.get("performanceProfile"),
    maxNodes: cfg.get("maxNodes"),
    maxIndexedFiles: cfg.get("maxIndexedFiles"),
    maxRenderedStars: cfg.get("maxRenderedStars"),
    maxRelationshipEdges: cfg.get("maxRelationshipEdges"),
  });
  return {
    ...capacity,
    traceFadeSeconds: clamp(cfg.get<number>("traceFadeSeconds", 45), 2, 3600, 45),
    traceShellEvents: cfg.get<boolean>("traceShellEvents", true),
    neighborhoods: readNeighborhoodMode(cfg.get("neighborhoods")),
    backgroundSymbols: cfg.get<boolean>("backgroundSymbols", false),
  };
}

function readNeighborhoodMode(value: unknown): GraphNeighborhoodMode {
  return value === "on" || value === "off" ? value : "auto";
}
