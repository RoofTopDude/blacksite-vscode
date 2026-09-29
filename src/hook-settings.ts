import * as vscode from "vscode";
import { HOOK_EVENTS, locateHookProgram, runHooks, validateHooks, type HookProvider, type HookRunRecord } from "./hooks.js";

let runLog: { appendLine(line: string): void } | undefined;
/** Where each finished hook is reported. Without it a hook that works leaves no sign that it ran. */
export function setHookRunLog(log: { appendLine(line: string): void } | undefined): void { runLog = log; }

function logRun({ hook, input, failure, exitCode, decision, elapsedMs }: HookRunRecord): void {
  const time = new Date().toTimeString().slice(0, 8);
  const target = input.toolName ? ` ${input.toolName}` : "";
  const outcome = failure ? `failed after ${elapsedMs} ms: ${failure.split("\n")[0]!.slice(0, 200)}`
    : `exit ${exitCode ?? 0}${decision ? `, decision ${decision}` : ""} in ${elapsedMs} ms`;
  runLog?.appendLine(`[${time}] ${input.event}${target}: ${[hook.command, ...(hook.args ?? [])].join(" ").slice(0, 160)} → ${outcome}`);
}

/** Only user settings can authorize scripts; repository settings cannot install hooks. */
function userConfiguredHooks(): unknown {
  return vscode.workspace.getConfiguration("blacksite.hooks").inspect<unknown>("commands")?.globalValue ?? [];
}

export const configuredHooks: HookProvider = async (input, signal) => {
  if (!vscode.workspace.isTrusted) return {};
  const { hooks, problems } = validateHooks(userConfiguredHooks());
  if (input.event === "PreToolUse" || input.event === "UserPromptSubmit") {
    // A malformed entry may have been meant as a safety check, so it fails closed. The message
    // says which entry and field, and where to fix it, rather than blocking without explanation.
    const stopper = problems.find((problem) => problem.blocking);
    if (stopper) return { blocked: `${stopper.message} Fix blacksite.hooks.commands in your user settings; until then prompts and tool calls are blocked.` };
  }
  const outcome = await runHooks(hooks, input, signal, logRun);
  // Once per run, so a broken entry for a step that cannot block is still noticed.
  if (input.event === "Stop") outcome.warnings = [...(outcome.warnings ?? []), ...problems.map((problem) => problem.message)];
  return outcome;
};

/** What the hooks setting currently amounts to, one line per finding, for the "Check Hooks" command. */
export function describeHooks(workspaceRoot: string): { lines: string[]; healthy: boolean } {
  const lines: string[] = [];
  let healthy = true;
  const inspected = vscode.workspace.getConfiguration("blacksite.hooks").inspect<unknown[]>("commands");
  if (!vscode.workspace.isTrusted) { lines.push("This workspace is not trusted, so no hooks run."); healthy = false; }
  const shadowed = [inspected?.workspaceValue, inspected?.workspaceFolderValue].some((value) => Array.isArray(value) && value.length > 0);
  if (shadowed) lines.push("Ignored: blacksite.hooks.commands is also set in workspace settings. Hooks are read from user settings only.");
  const { hooks, problems } = validateHooks(userConfiguredHooks());
  for (const problem of problems) { lines.push(`✗ ${problem.message}`); healthy = false; }
  for (const hook of hooks) {
    const found = locateHookProgram(hook.command, workspaceRoot);
    if (!found) healthy = false;
    const scope = hook.tools?.length ? ` for ${hook.tools.join(", ")}` : "";
    lines.push(`${found ? "✓" : "✗"} ${hook.event}${scope}: ${hook.command}${found ? ` → ${found}` : " was not found on PATH or at that path"}`);
  }
  if (!hooks.length && !problems.length) lines.push(`No hooks are configured. Add entries to blacksite.hooks.commands in your user settings (events: ${HOOK_EVENTS.join(", ")}).`);
  return { lines, healthy };
}
