/**
 * Plan mode is read-only, enforced by the harness rather than asked of the model.
 *
 * The plan profile used to be prompt text alone: it told the model to stay read-only while every
 * write tool stayed advertised and dispatchable. A model that decided to "just fix it quickly"
 * could, and a prompt-injected file could make it. Now the mutating tools are withheld from the
 * catalog while plan mode is active, and anything that still reaches dispatch — a hallucinated
 * call, or a shell command that would write — is refused before it runs.
 *
 * What stays available is what planning needs: reading and searching, language intelligence,
 * git inspection, running tests for evidence, and the planning artifacts the profile asks for
 * (plans, todos, plan documents, tickets, notes, memory). The user leaves plan mode by switching
 * the request mode, or by asking for implementation when the mode is Auto.
 */

import { isReadOnlyCommand } from "@blacksite/local-runtime";
import { isMutatingServiceTool } from "./tools/definitions.js";

/** Tools whose purpose is to change the workspace, the machine, or an external system. */
const PLAN_MODE_WITHHELD: ReadonlySet<string> = new Set([
  // Workspace files — direct, batched, structured, and language-server edits.
  "file_edit", "file_edit_batch", "json_edit", "file_write", "file_delete", "file_move", "file_copy", "file_mkdir",
  "code_insert", "code_replace", "code_replace_batch", "code_rename", "code_actions", "code_format",
  // Repository and machine state.
  "worktree_op",
  // Authoring agent procedures changes how every later run behaves; it is not a planning artifact.
  "skill_write",
  // Unattended execution and recorded action sequences.
  "loop_control", "sequence_execute", "sequence_resume",
  // Browser input and in-page code. Navigation, reading and screenshots stay available for research.
  "browser_type", "browser_fill_form", "browser_submit", "browser_evaluate", "browser_run_script",
]);

/** git_op operations that only read. */
const READ_ONLY_GIT_OPS: ReadonlySet<string> = new Set(["context", "status", "diff", "log"]);

export function planModeWithholds(toolName: string): boolean {
  return PLAN_MODE_WITHHELD.has(toolName) || isMutatingServiceTool(toolName);
}

const PLAN_MODE_EXIT_HINT =
  "Plan mode is read-only. Finish the plan and tell the user it is ready; they can switch the request mode to carry it out.";

/**
 * Why this call may not run in plan mode, or null when it may. Covers the withheld tools (a call
 * the model should never have been able to make) and the argument-dependent cases: a shell or
 * background command whose classified tier is anything but read, and a mutating git operation.
 */
export function planModeRefusal(toolName: string, runtimeType: string, payload: Record<string, unknown>): string | null {
  if (planModeWithholds(toolName)) {
    return `${toolName} changes files or external state and is unavailable in plan mode. ${PLAN_MODE_EXIT_HINT}`;
  }
  if (runtimeType === "system.shell" || runtimeType === "system.process.start") {
    const command = String(payload["command"] ?? "").trim();
    const args = Array.isArray(payload["args"]) ? (payload["args"] as unknown[]).map(String) : [];
    if (!command) return null; // validation reports the missing command itself
    if (!isReadOnlyCommand(command, args)) {
      return `\`${[command, ...args].join(" ")}\` could change files or state, and plan mode only runs read-only commands `
        + "(inspection tools such as rg, cat, ls, and read-only git subcommands such as status, log, diff, show). "
        + "Use the file and search tools to inspect, and test_run for test evidence. " + PLAN_MODE_EXIT_HINT;
    }
    return null;
  }
  if (runtimeType === "workspace.git") {
    const op = String(payload["op"] ?? "").trim();
    if (op && !READ_ONLY_GIT_OPS.has(op)) {
      return `git_op "${op}" changes the repository and is unavailable in plan mode (read-only operations: ${[...READ_ONLY_GIT_OPS].join(", ")}). ${PLAN_MODE_EXIT_HINT}`;
    }
  }
  return null;
}
