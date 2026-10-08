import * as vscode from "vscode";
import {
  HOOK_EVENTS, locateHookProgram, runHooks, validateHooks,
  type HookDefinition, type HookInput, type HookOutcome, type HookProvider, type HookRunRecord,
} from "./hooks.js";

let runLog: { appendLine(line: string): void } | undefined;
/** Where each finished hook is reported. Without it a hook that works leaves no sign that it ran. */
export function setHookRunLog(log: { appendLine(line: string): void } | undefined): void { runLog = log; }

const runListeners = new Set<(record: HookRunRecord) => void>();

/** Every finished hook run, for the Hooks page's recent-runs list. */
export function onHookRun(listener: (record: HookRunRecord) => void): vscode.Disposable {
  runListeners.add(listener);
  return new vscode.Disposable(() => { runListeners.delete(listener); });
}

function logRun(record: HookRunRecord): void {
  const { hook, input, failure, exitCode, decision, elapsedMs } = record;
  const time = new Date().toTimeString().slice(0, 8);
  const target = input.toolName ? ` ${input.toolName}` : "";
  const outcome = failure ? `failed after ${elapsedMs} ms: ${failure.split("\n")[0]!.slice(0, 200)}`
    : `exit ${exitCode ?? 0}${decision ? `, decision ${decision}` : ""} in ${elapsedMs} ms`;
  runLog?.appendLine(`[${time}] ${input.event}${target}: ${[hook.command, ...(hook.args ?? [])].join(" ").slice(0, 160)} → ${outcome}`);
  for (const listener of runListeners) {
    try { listener(record); } catch { /* a page that went away must not affect the run */ }
  }
}

/** Only user settings can authorize scripts; repository settings cannot install hooks. */
function userConfiguredHooks(): unknown {
  return vscode.workspace.getConfiguration("blacksite.hooks").inspect<unknown>("commands")?.globalValue ?? [];
}

/** The user-settings value exactly as written, invalid entries included, for the Hooks page. */
export function rawHookEntries(): unknown[] {
  const value = userConfiguredHooks();
  return Array.isArray(value) ? value : [];
}

/** Hooks are read from user settings only, so that is the only place the page writes them. */
export async function writeHookEntries(entries: unknown[]): Promise<void> {
  await vscode.workspace.getConfiguration("blacksite.hooks").update("commands", entries, vscode.ConfigurationTarget.Global);
}

/** A tool name the hook's `tools` filter would match, for a test run. */
function sampleToolName(hook: HookDefinition): string {
  const pattern = hook.tools?.[0];
  if (!pattern) return "file_read";
  return pattern.includes("*") ? pattern.replace(/\*/g, "sample") : pattern;
}

/** What the agent would send this hook, with placeholder values, so a test exercises the same
 *  stdin shape and environment as a real run. */
export function sampleHookInput(hook: HookDefinition, workspaceRoot: string): HookInput {
  const base = { event: hook.event, sessionId: "hooks-page-test", workspaceRoot };
  switch (hook.event) {
    case "UserPromptSubmit": return { ...base, prompt: "Test prompt sent from the Blacksite Hooks page." };
    case "PreToolUse": return { ...base, toolCallId: "test_call", toolName: sampleToolName(hook), toolInput: { path: "README.md" } };
    case "PostToolUse": return { ...base, toolCallId: "test_call", toolName: sampleToolName(hook), toolInput: { path: "README.md" }, ok: true, result: { ok: true } };
    case "Stop": return { ...base, stopReason: "end_turn", stopHookActive: false };
    case "Notification": return { ...base, message: "Test notification from the Blacksite Hooks page.", notificationType: "approval" };
  }
}

export interface HookTestResult {
  /** Plain-language verdict: what the agent would have done. */
  summary: string;
  tone: "ok" | "warn" | "error";
  record?: HookRunRecord;
  outcome: HookOutcome;
}

/** Run one hook once with a sample payload, the way the agent would, and say what it decided. */
export async function testHook(hook: HookDefinition, workspaceRoot: string, signal?: AbortSignal): Promise<HookTestResult> {
  let record: HookRunRecord | undefined;
  const outcome = await runHooks([hook], sampleHookInput(hook, workspaceRoot), signal, (run) => { record = run; logRun(run); });
  const elapsed = record ? ` in ${record.elapsedMs} ms` : "";
  if (outcome.blocked) return { summary: `Blocked${elapsed}. The agent would stop here: ${outcome.blocked}`, tone: "warn", record, outcome };
  if (outcome.resume) return { summary: `Asked the agent to keep going${elapsed}: ${outcome.resume}`, tone: "warn", record, outcome };
  // Exit 2 (or a block decision) after a tool is how a hook talks to the agent, not a failure.
  if (outcome.context?.length) {
    return record?.failure || record?.decision === "block"
      ? { summary: `Sent the agent feedback${elapsed}: ${outcome.context.join(" ")}`, tone: "warn", record, outcome }
      : { summary: `Passed${elapsed}, with a note for the agent: ${outcome.context.join(" ")}`, tone: "ok", record, outcome };
  }
  if (record?.failure) return { summary: `Failed${elapsed}: ${record.failure}`, tone: "error", record, outcome };
  return { summary: `Passed${elapsed} (exit ${record?.exitCode ?? 0}).`, tone: "ok", record, outcome };
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
