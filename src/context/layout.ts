/**
 * Layout: which part of the attached context is stable and which is live, and so which cache
 * boundary each sits behind.
 *
 * The attached block used to be one string re-sent after the last cache breakpoint on every model
 * call, so instructions, skills and project memory were billed at the full input price on every
 * tool round although they change perhaps once a session. Stable caching
 * (`blacksite.context.stableCaching`) sends the stable part as a second system block behind its own
 * breakpoint, and keeps only the live part at the uncached tail.
 *
 * This module owns the classification. The wire placement per route (Anthropic system block,
 * Converse cachePoint, OpenAI system prefix, ChatGPT tail) lives with each route's builder in
 * packages/llm, which reads `ModelRequest.contextStable`. Pure.
 */
import type { ContextStability } from "./model.js";

/** Sections of the workspace block, in the order the block has always listed them. */
export type WorkspaceSectionKey =
  | "roots"
  | "projectShape"
  | "toolchains"
  | "activeFile"
  | "openEditors"
  | "diagnostics"
  | "git"
  | "instructions"
  | "workspaceRules"
  | "architecture"
  | "localMap"
  | "baseContext"
  | "structuredBaseContext"
  | "projectMemory"
  | "uiPreferences"
  | "plans"
  | "tickets"
  | "skillRoster"
  | "mcpServers";

/**
 * Stability of each section. `session`: changes when a file it reads changes or the user changes a
 * setting, which costs one cache write. `call`: can change between two tool rounds, so it stays
 * at the tail.
 *
 * Judgement calls, to be checked against the Phase 0 report's cache-read figures:
 * - the architecture summary is derived from the map and changes when an edit changes the map's
 *   shape, which is rare next to tool rounds, so it is stable;
 * - the map neighbourhood depends on which files are open, so it is live;
 * - plans and tickets change whenever the agent updates them, so they are live.
 */
export const WORKSPACE_SECTION_STABILITY: Readonly<Record<WorkspaceSectionKey, ContextStability>> = {
  roots: "session",
  projectShape: "session",
  toolchains: "session",
  activeFile: "call",
  openEditors: "call",
  diagnostics: "call",
  git: "call",
  instructions: "session",
  workspaceRules: "session",
  architecture: "session",
  localMap: "call",
  baseContext: "session",
  structuredBaseContext: "session",
  projectMemory: "session",
  uiPreferences: "session",
  plans: "call",
  tickets: "call",
  skillRoster: "session",
  mcpServers: "session",
};

export function isStableSection(key: WorkspaceSectionKey): boolean {
  return WORKSPACE_SECTION_STABILITY[key] !== "call";
}

/** The workspace block, split. Either half may be empty. */
export interface WorkspaceContextParts {
  /** Exactly what the unsplit block has always been: used when stable caching is off. */
  combined: string;
  stable: string;
  live: string;
}

/** The pieces of the attached context the session owns, besides the workspace block. */
export interface AttachedContextPieces {
  requestProfile: string;
  skills: string;
  workspace: WorkspaceContextParts;
  runNotice: string;
  /** Phase 4.1: facts about the context itself. Empty unless awareness is on. */
  contextStatus?: string;
  checklist: string;
}

/** The attached context, as the two strings a request carries. `stable` is empty when stable
 *  caching is off; `live` is then exactly today's single block body. */
export function layoutAttachedContext(pieces: AttachedContextPieces, stableCaching: boolean): { stable: string; live: string } {
  const join = (parts: string[]): string => parts.filter(Boolean).join("\n\n");
  if (!stableCaching) {
    return {
      stable: "",
      live: join([pieces.requestProfile, pieces.skills, pieces.workspace.combined, pieces.runNotice, pieces.contextStatus ?? "", pieces.checklist]),
    };
  }
  // The request profile and loaded skills change only when the user switches mode or the agent
  // loads a skill: both are stable. The run notice and the checklist can change every round.
  return {
    stable: join([pieces.requestProfile, pieces.skills, pieces.workspace.stable]),
    live: join([pieces.workspace.live, pieces.runNotice, pieces.contextStatus ?? "", pieces.checklist]),
  };
}
