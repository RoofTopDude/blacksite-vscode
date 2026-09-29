import { spawn } from "node:child_process";

export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export interface HookDefinition {
  event: HookEvent;
  command: string;
  args?: string[];
  /** Exact tool names; omitted means every tool. */
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
}
export interface HookOutcome { blocked?: string; warnings?: string[] }
export type HookProvider = (input: HookInput, signal?: AbortSignal) => Promise<HookOutcome>;

/** Validate the whole configuration before running any script. */
export function parseHooks(value: unknown): HookDefinition[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Hooks must be an array of at most 32 entries.");
  return value.map((raw: unknown, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid hook ${index + 1}.`);
    const h = raw as Record<string, unknown>;
    if (Object.keys(h).some((key) => !["event", "command", "args", "tools", "timeoutMs"].includes(key))
      || !HOOK_EVENTS.includes(h.event as HookEvent) || typeof h.command !== "string" || !h.command.trim()
      || (h.args !== undefined && (!Array.isArray(h.args) || !h.args.every((a) => typeof a === "string")))
      || (h.tools !== undefined && (!Array.isArray(h.tools) || !h.tools.every((a) => typeof a === "string" && a.length > 0)))
      || (h.timeoutMs !== undefined && (typeof h.timeoutMs !== "number" || !Number.isInteger(h.timeoutMs) || h.timeoutMs < 100 || h.timeoutMs > 60_000))) {
      throw new Error(`Invalid hook ${index + 1}: check event, command, args, tools and timeoutMs (100–60000).`);
    }
    return { event: h.event as HookEvent, command: h.command, args: h.args as string[] | undefined,
      tools: h.tools as string[] | undefined, timeoutMs: h.timeoutMs as number | undefined };
  });
}

const OUTPUT_LIMIT = 16_384;

/** No shell interpolation: the payload travels only over stdin. */
function runHook(hook: HookDefinition, input: HookInput, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.resolve("Cancelled.");
  return new Promise((resolve) => {
    const child = spawn(hook.command, hook.args ?? [], {
      cwd: input.workspaceRoot, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(error);
    };
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
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(reason);
    };
    const abort = () => terminate("Cancelled.");
    const timer = setTimeout(() => terminate("Timed out."), hook.timeoutMs ?? 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, OUTPUT_LIMIT); });
    child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, OUTPUT_LIMIT); });
    child.on("error", (error) => finish(error.message));
    child.on("close", (code) => finish(code === 0 ? undefined : `Exit ${code ?? "signal"}${output.trim() ? `: ${output.trim()}` : ""}`));
    child.stdin.on("error", () => { /* An early-exiting hook may close stdin; close/error determines its result. */ });
    try { child.stdin.end(JSON.stringify({ version: 1, ...input }) + "\n"); }
    catch (error) { terminate(error instanceof Error ? error.message : String(error)); }
    if (signal?.aborted) abort();
  });
}

export async function runHooks(hooks: HookDefinition[], input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
  const blocking = input.event === "PreToolUse" || input.event === "UserPromptSubmit";
  const warnings: string[] = [];
  for (const hook of hooks) {
    if (hook.event !== input.event || (hook.tools && (!input.toolName || !hook.tools.includes(input.toolName)))) continue;
    let failure: string | undefined;
    try { failure = await runHook(hook, input, signal); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    if (failure) {
      const message = `${input.event} hook (${hook.command}): ${failure}`;
      if (blocking) return { blocked: message };
      warnings.push(message);
    }
    if (signal?.aborted) break;
  }
  return { warnings };
}
