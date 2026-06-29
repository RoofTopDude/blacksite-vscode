import type { SubagentProfile } from "./chat-provider.js";

export const BUILTIN_SUBAGENT_PROFILES: readonly SubagentProfile[] = [
  {
    id: "frontend_ui",
    name: "Frontend UI",
    description: "UI-facing implementation and browser-surface verification.",
    systemPromptAddition:
      "Focus on browser-facing behavior, UI state wiring, styling integrity, and user-visible regressions. Prefer concise observations tied to concrete surfaces and verification steps.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "backend_api",
    name: "Backend API",
    description: "Server, runtime, schema, and integration work.",
    systemPromptAddition:
      "Focus on backend behavior, contracts, process execution, local services, and failure handling. Prefer concrete command paths, data flow checks, and minimal verification sets.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "qa_regression",
    name: "QA Regression",
    description: "Targeted verification and failure reproduction.",
    systemPromptAddition:
      "Focus on reproducing defects, selecting the smallest credible regression coverage, and surfacing behavior deltas with exact evidence.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "repo_ops",
    name: "Repo Ops",
    description: "Git, local tooling, and operator-focused repo workflows.",
    systemPromptAddition:
      "Focus on repository operations, local command execution, workspace state, and safe confirmation handling for network or destructive actions.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
] as const;

export function getBuiltinSubagentProfiles(): SubagentProfile[] {
  return BUILTIN_SUBAGENT_PROFILES.map((p) => ({ ...p }));
}

export function mergeBuiltinSubagentProfiles(
  customProfiles: readonly SubagentProfile[] | null | undefined,
): SubagentProfile[] {
  const builtins = getBuiltinSubagentProfiles();
  const custom = (customProfiles ?? []).filter((p) => !p.builtin);
  return [...builtins, ...custom];
}

export function findSubagentProfile(
  customProfiles: readonly SubagentProfile[] | null | undefined,
  profileId: string,
): SubagentProfile | null {
  return mergeBuiltinSubagentProfiles(customProfiles).find((p) => p.id === profileId) ?? null;
}
