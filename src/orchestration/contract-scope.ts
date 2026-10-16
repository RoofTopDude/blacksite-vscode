/**
 * Where a tool call would write, and whether a contract covers it.
 *
 * Checked by the host before the call runs (AgentSession) and again where editor edits are
 * applied (contract-edit-provider.ts), because a rename or a code action names no files in its
 * input. Shell commands are deliberately not here: their targets cannot be known before they run,
 * so writes they make outside the territory are found afterwards and recorded on the receipt.
 *
 * Pure. See docs/orchestration-p0-implementation-plan.md §3.5.
 */

import { isAlwaysInBounds } from "../plans/run-tripwires.js";
import { normalizeScopePath, pathInScope, type WorkContract } from "./work-contract.js";

function text(value: unknown): string[] {
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function targetPath(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) return text((value as Record<string, unknown>).path);
  return [];
}

/**
 * The paths a file-mutating tool call targets, read from its arguments, or null when the tool is
 * not one whose targets its input names (reads, shell commands, renames, code actions).
 */
export function mutationTargets(toolName: string, input: Record<string, unknown>): string[] | null {
  switch (toolName) {
    case "file_edit":
    case "json_edit":
    case "file_write":
    case "file_delete":
    case "file_mkdir":
      return text(input.path);
    case "file_copy":
      return text(input.destination);
    case "file_move":
      return [...text(input.source), ...text(input.destination)];
    case "file_edit_batch":
      return Array.isArray(input.edits) ? input.edits.flatMap((edit) => (edit && typeof edit === "object" ? text((edit as Record<string, unknown>).path) : [])) : [];
    case "code_insert":
    case "code_replace":
      return targetPath(input.target);
    case "code_replace_batch":
      return Array.isArray(input.edits)
        ? input.edits.flatMap((edit) => (edit && typeof edit === "object" ? targetPath((edit as Record<string, unknown>).target) : []))
        : [];
    default:
      return null;
  }
}

export interface ScopeContext {
  /** Map an absolute or relative path to the workspace-relative form contracts use; null when
   *  it is outside every workspace root. */
  toRelative(file: string): string | null;
  /** Paths the session may always write: its scratch directory. */
  isScratch?(relative: string): boolean;
}

/**
 * The targets a contract does not cover. Paths an earlier approval already granted, scratch
 * files and lockfiles are never reported. A path outside every workspace root is reported as
 * written: no contract covers it.
 */
export function outOfScope(
  contract: Pick<WorkContract, "territory">,
  targets: readonly string[],
  granted: ReadonlySet<string>,
  context: ScopeContext,
): string[] {
  const writable = contract.territory.writable;
  const out: string[] = [];
  for (const target of targets) {
    const relative = context.toRelative(target);
    const key = relative ? normalizeScopePath(relative) : null;
    if (!key) {
      if (writable !== "workspace" && !out.includes(target)) out.push(target);
      continue;
    }
    if (granted.has(key) || context.isScratch?.(key) || isAlwaysInBounds(key) || pathInScope(key, writable)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export function scopeGateDescription(paths: readonly string[], objective: string): string {
  const shown = paths.slice(0, 8).join(", ") + (paths.length > 8 ? `, and ${paths.length - 8} more` : "");
  return `Write outside this lane's work contract: ${shown}. `
    + `The contract covers: ${objective.split("\n")[0]?.slice(0, 160) ?? "its declared files"}.`;
}
