import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";

export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export interface HookDefinition {
  event: HookEvent;
  command: string;
  args?: string[];
  /** Tool names, exact or with `*` wildcards (`file_*`); omitted means every tool. */
  tools?: string[];
  timeoutMs?: number;
}
export interface HookInput {
  event: HookEvent;
  sessionId: string;
  workspaceRoot: string;
  prompt?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: unknown;
  ok?: boolean;
  stopReason?: string;
  /** Stop only: true when the run is already continuing because an earlier Stop hook asked it to. */
  stopHookActive?: boolean;
  /** Notification only. */
  message?: string;
  notificationType?: "approval" | "question" | "run";
}
export interface HookOutcome {
  /** PreToolUse and UserPromptSubmit: the reason the prompt or tool call was stopped. */
  blocked?: string;
  warnings?: string[];
  /** Text for the model: a PostToolUse hook's feedback, or context to add to a submitted prompt. */
  context?: string[];
  /** Stop only: the run should carry on, and this is what the agent is told. */
  resume?: string;
}
export type HookProvider = (input: HookInput, signal?: AbortSignal) => Promise<HookOutcome>;

const CONFIG_KEYS = ["event", "command", "args", "tools", "timeoutMs"];
const KEY_HINTS: Record<string, string> = { matcher: "tools", tool: "tools", timeout: "timeoutMs", hooks: "command and args", type: "command" };
const BLOCKING_EVENTS: readonly string[] = ["PreToolUse", "UserPromptSubmit"];

export interface HookProblem { index: number; message: string; blocking: boolean }

/** True when a raw entry names an event that could never have been a safety check. */
function plainlyNonBlocking(raw: unknown): boolean {
  const event = (raw as { event?: unknown } | null | undefined)?.event;
  return typeof event === "string" && HOOK_EVENTS.includes(event as HookEvent) && !BLOCKING_EVENTS.includes(event);
}

/** Validate every entry, reporting each problem with the entry and field at fault. An entry that
 *  fails still counts as a possible safety check unless its event is plainly a non-blocking one. */
export function validateHooks(value: unknown): { hooks: HookDefinition[]; problems: HookProblem[] } {
  if (!Array.isArray(value) || value.length > 32) return { hooks: [], problems: [{ index: 0, message: "Hooks must be an array of at most 32 entries.", blocking: true }] };
  const hooks: HookDefinition[] = [];
  const problems: HookProblem[] = [];
  value.forEach((raw: unknown, i) => {
    const index = i + 1;
    const fail = (reason: string) => problems.push({ index, message: `Invalid hook ${index}: ${reason}`, blocking: !plainlyNonBlocking(raw) });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("expected an object with event and command.");
    const h = raw as Record<string, unknown>;
    const unknown = Object.keys(h).find((key) => !CONFIG_KEYS.includes(key));
    if (unknown) return fail(`unknown key "${unknown}"${KEY_HINTS[unknown] ? ` (use ${KEY_HINTS[unknown]})` : ""}; allowed keys are ${CONFIG_KEYS.join(", ")}.`);
    if (!HOOK_EVENTS.includes(h.event as HookEvent)) return fail(`event must be one of ${HOOK_EVENTS.join(", ")}.`);
    if (typeof h.command !== "string" || !h.command.trim()) return fail("command must be a non-empty executable name or path.");
    if (h.args !== undefined && (!Array.isArray(h.args) || !h.args.every((a) => typeof a === "string"))) return fail("args must be an array of strings.");
    if (h.tools !== undefined && (!Array.isArray(h.tools) || !h.tools.every((a) => typeof a === "string" && a.length > 0))) return fail("tools must be an array of non-empty tool names.");
    if (h.timeoutMs !== undefined && (typeof h.timeoutMs !== "number" || !Number.isInteger(h.timeoutMs) || h.timeoutMs < 100 || h.timeoutMs > 60_000)) return fail("timeoutMs must be a whole number from 100 to 60000.");
    hooks.push({ event: h.event as HookEvent, command: h.command, args: h.args as string[] | undefined,
      tools: h.tools as string[] | undefined, timeoutMs: h.timeoutMs as number | undefined });
  });
  return { hooks, problems };
}

/** Validate the whole configuration before running any script. */
export function parseHooks(value: unknown): HookDefinition[] {
  const { hooks, problems } = validateHooks(value);
  if (problems.length) throw new Error(problems[0]!.message);
  return hooks;
}

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `*` matches any run of characters; anything else must match exactly. */
export function toolMatches(patterns: string[] | undefined, toolName: string | undefined): boolean {
  if (!patterns) return true;
  if (!toolName) return false;
  return patterns.some((pattern) => pattern === toolName
    || (pattern.includes("*") && new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$").test(toolName)));
}

export interface HookLaunch { file: string; args: string[]; windowsVerbatimArguments?: boolean }

/** Where a hook's program would be found, or undefined. Used to tell the user why a hook cannot start. */
export function locateHookProgram(command: string, cwd: string,
  platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (candidate: string) => boolean = isFile): string | undefined {
  if (platform === "win32") return findWindowsExecutable(command, cwd, env, exists);
  const candidates = command.includes("/") ? [path.posix.resolve(cwd, command)]
    : (env.PATH ?? "").split(":").filter(Boolean).map((directory) => path.posix.join(directory, command));
  return candidates.find((candidate) => exists(candidate));
}

const isFile = (candidate: string): boolean => { try { return statSync(candidate).isFile(); } catch { return false; } };
const CMD_SCRIPT = /\.(?:cmd|bat)$/i;
const NPM_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const CMD_META = /([()[\]%!^"`<>&|;, *?])/g;

function findWindowsExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv, exists: (candidate: string) => boolean): string | undefined {
  const win = path.win32;
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  const qualified = /[\\/]/.test(command) || win.isAbsolute(command);
  // A bare name is looked up on PATH only. The working directory is the workspace, and a
  // repository must not be able to supply the program a hook runs.
  const directories = qualified ? [win.dirname(win.resolve(cwd, command))]
    : (env.PATH ?? env.Path ?? "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const base = qualified ? win.basename(command) : command;
  const extension = win.extname(base).toLowerCase();
  const names = extensions.includes(extension) || (extension && qualified) ? [base] : extensions.map((ext) => base + ext);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = win.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * How to start a hook's program. Node's spawn without a shell looks for `name.exe` only and, since
 * the batch-file security fix, refuses `.cmd` and `.bat` outright, so on Windows `npm`, `npx`,
 * `prettier` and every other npm shim failed to launch. They are found through PATH and PATHEXT
 * and run through cmd.exe with each argument quoted, which keeps the payload-only-on-stdin rule.
 */
export function resolveHookLaunch(command: string, args: string[], cwd: string,
  platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (candidate: string) => boolean = isFile): HookLaunch {
  if (platform !== "win32") return { file: command, args };
  const found = findWindowsExecutable(command, cwd, env, exists);
  if (!found) return { file: command, args };
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase());
  const extension = path.win32.extname(found).toLowerCase();
  if (extension && !extensions.includes(extension)) {
    throw new Error(`Windows cannot run a ${extension} file directly. Set command to its interpreter (node, python, pwsh) and put the script path in args.`);
  }
  if (!CMD_SCRIPT.test(found)) return { file: found, args };
  if (args.some((arg) => /["%\r\n\0]/.test(arg))) {
    throw new Error("A .cmd or .bat command cannot take arguments containing a double quote, a percent sign or a line break. Use node, python or pwsh to run the script instead.");
  }
  const twice = NPM_SHIM.test(found);
  const quote = (arg: string) => {
    let value = `"${arg.replace(/(\\+)$/, "$1$1")}"`;
    value = value.replace(CMD_META, "^$1");
    return twice ? value.replace(CMD_META, "^$1") : value;
  };
  const line = [found.replace(CMD_META, "^$1"), ...args.map(quote)].join(" ");
  return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

const OUTPUT_LIMIT = 16_384;
const CONTEXT_LIMIT = 8_000;

interface HookRun {
  /** Set for a launch error, a timeout, a cancellation or a nonzero exit. */
  failure?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

/** No shell interpolation: the payload travels only over stdin. */
function runHook(hook: HookDefinition, input: HookInput, signal?: AbortSignal): Promise<HookRun> {
  if (signal?.aborted) return Promise.resolve({ failure: "Cancelled.", stdout: "", stderr: "" });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Set once the child exists: a launch that fails first has nothing to clear.
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const done = (failure?: string, exitCode?: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ failure, exitCode, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      const launch = resolveHookLaunch(hook.command, hook.args ?? [], input.workspaceRoot);
      child = spawn(launch.file, launch.args, {
        cwd: input.workspaceRoot, shell: false, windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          BLACKSITE_HOOK_EVENT: input.event, BLACKSITE_SESSION_ID: input.sessionId, BLACKSITE_WORKSPACE: input.workspaceRoot,
          ...(input.toolName ? { BLACKSITE_TOOL_NAME: input.toolName } : {}),
        },
      });
    } catch (error) {
      done(error instanceof Error ? error.message : String(error));
      return;
    }
    const terminate = (reason: string) => {
      if (settled) return;
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => { child.kill(); });
          killer.unref();
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      done(reason);
    };
    const abort = () => terminate("Cancelled.");
    timer = setTimeout(() => terminate("Timed out."), hook.timeoutMs ?? 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, OUTPUT_LIMIT); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, OUTPUT_LIMIT); });
    child.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT"
      ? `Command not found: "${hook.command}" (${error.message}). Use a full path, or a program on your PATH.` : error.message));
    child.on("close", (code) => {
      const output = (stdout + stderr).slice(0, OUTPUT_LIMIT).trim();
      done(code === 0 ? undefined : `Exit ${code ?? "signal"}${output ? `: ${output}` : ""}`, code ?? undefined);
    });
    child.stdin?.on("error", () => { /* An early-exiting hook may close stdin; close/error determines its result. */ });
    try { child.stdin?.end(JSON.stringify({ version: 1, ...input }) + "\n"); }
    catch (error) { terminate(error instanceof Error ? error.message : String(error)); }
    if (signal?.aborted) abort();
  });
}

interface Directive { decision?: string; reason?: string; additionalContext?: string }

/** A hook that exits 0 may print one JSON object to say more than pass or fail. Anything else it
 *  prints is ignored. The object can stop a step or add text for the model; it cannot approve
 *  a tool call or change what the model asked for. */
function readDirective(stdout: string): Directive | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return {
      decision: typeof value.decision === "string" ? value.decision : undefined,
      reason: typeof value.reason === "string" ? value.reason : undefined,
      additionalContext: typeof value.additionalContext === "string" ? value.additionalContext.slice(0, CONTEXT_LIMIT) : undefined,
    };
  } catch { return undefined; }
}

/** Exit status 2 is the hook's way of talking to the model on the events that cannot be blocked. */
const MODEL_EXIT_CODE = 2;

/** One finished script, for the run log. Carries no payload: only what ran, how it ended, and how long it took. */
export interface HookRunRecord { hook: HookDefinition; input: HookInput; failure?: string; exitCode?: number; decision?: string; elapsedMs: number }

export async function runHooks(hooks: HookDefinition[], input: HookInput, signal?: AbortSignal, onRun?: (record: HookRunRecord) => void): Promise<HookOutcome> {
  const blocking = BLOCKING_EVENTS.includes(input.event);
  const warnings: string[] = [];
  const context: string[] = [];
  const resume: string[] = [];
  const outcome = (): HookOutcome => ({
    warnings, ...(context.length ? { context } : {}), ...(resume.length ? { resume: resume.join("\n\n") } : {}),
  });
  for (const hook of hooks) {
    if (hook.event !== input.event || !toolMatches(hook.tools, input.toolName)) continue;
    const label = `${input.event} hook (${hook.command})`;
    const startedAt = Date.now();
    const run = await runHook(hook, input, signal);
    const directive = run.failure ? undefined : readDirective(run.stdout);
    try { onRun?.({ hook, input, failure: run.failure, exitCode: run.exitCode, decision: directive?.decision, elapsedMs: Date.now() - startedAt }); }
    catch { /* a broken log must never change what a hook does */ }
    if (run.failure) {
      if (blocking) return { blocked: `${label}: ${run.failure}` };
      warnings.push(`${label}: ${run.failure}`);
      if (run.exitCode === MODEL_EXIT_CODE) {
        const said = (run.stderr.trim() || run.stdout.trim()) || run.failure;
        (input.event === "Stop" ? resume : context).push(said);
      }
    } else if (directive?.decision === "block") {
      const reason = directive.reason?.trim() || "Blocked by the hook.";
      if (blocking) return { blocked: `${label}: ${reason}` };
      warnings.push(`${label}: ${reason}`);
      (input.event === "Stop" ? resume : context).push(reason);
    }
    if (directive?.additionalContext?.trim() && (input.event === "UserPromptSubmit" || input.event === "PostToolUse")) {
      context.push(directive.additionalContext.trim());
    }
    if (signal?.aborted) break;
  }
  return outcome();
}
