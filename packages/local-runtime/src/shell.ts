import { spawn } from "child_process";
import type { ShellPayload, ShellResult } from "./types.js";
import { validateArgs, planSpawn, resolveShellConfirmation, type CommandPolicy, type SpawnPlan } from "./security.js";
import { describeMissingCommand, detectMissingCommand, installHintFor, type InstallHint } from "./missing-command.js";
import { ProcessManager } from "./process-manager.js";
import { resolveWorkspaceCwd } from "./path-policy.js";

const SHELL_TIMEOUT_MS = 60_000;
const STDOUT_MAX = 128 * 1024;
const STDERR_MAX = 32 * 1024;

function buildEnv(): NodeJS.ProcessEnv {
  const src = process.env;
  const keys = process.platform === "win32"
    ? ["APPDATA", "ComSpec", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT",
       "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PYTHONIOENCODING",
       "SystemRoot", "TEMP", "TMP", "USERPROFILE"]
    : ["HOME", "LANG", "LC_ALL", "PATH", "PYTHONIOENCODING", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (typeof src[key] === "string") env[key] = src[key];
  }
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

/**
 * Run a one-shot command asynchronously and collect its output, mirroring the shape
 * `spawnSync` used to return. This is what keeps `handleShell` from blocking the extension
 * host: `spawnSync` runs entirely on the calling thread, so any shell_run tool call — a
 * completely routine agent action (npm install, a test run, a build) — froze the ENTIRE
 * VS Code UI for up to the command's timeout (as long as 10 minutes), not just this
 * extension. VS Code surfaces that as "Extension host is not responding," which reads to a
 * user as the extension crashing. `spawn` runs the child out-of-process; only I/O
 * event handling stays on this thread, which is cheap.
 *
 * Output is capped by truncating growth (not by killing the process on overflow, unlike
 * spawnSync's `maxBuffer`) — a verbose-but-harmless command still completes normally instead
 * of being killed for talking too much. Listens on "close" rather than "exit" so all
 * buffered stdout/stderr data has actually arrived before resolving (a listener on "exit"
 * can fire before the stdio pipes finish draining, which would silently truncate the tail
 * of the output).
 */
export function runShellCommand(
  plan: SpawnPlan,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; cancelled: boolean }> {
  if (signal?.aborted) {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(plan.command, plan.args, {
      cwd, env: buildEnv(), shell: plan.shell, windowsHide: true,
      // Stdin explicitly closed: nothing ever supplies input, and leaving it open as an
      // unclosed pipe risks a command that waits on stdin EOF hanging until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killChild = (force: boolean) => {
      // On Windows every command is routed through cmd.exe (see planSpawn). Killing only
      // that wrapper leaves the real command running and the stdio pipes open, so the tool
      // promise does not settle until the orphan exits naturally. taskkill /T closes the
      // complete wrapper tree and makes cancellation/timeout prompt and deterministic.
      if (process.platform === "win32" && child.pid) {
        try {
          const killer = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.on("error", () => {
            try { child.kill(force ? "SIGKILL" : undefined); } catch { /* best effort */ }
          });
          return;
        } catch { /* fall through to ChildProcess.kill */ }
      }
      try { child.kill(force ? "SIGKILL" : undefined); } catch { /* best effort */ }
    };
    const terminate = () => {
      killChild(process.platform === "win32");
      // Escalate to SIGKILL if the process ignores the polite signal, mirroring
      // ProcessManager.kill's escalation for long-running background processes.
      killTimer = setTimeout(() => {
        if (settled) return;
        killChild(true);
      }, 1500);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode, timedOut, cancelled });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += chunk.toString("utf8");
    });
    // A ChildProcess is an EventEmitter; an "error" (e.g. ENOENT — command not found) with
    // no listener is an unhandled 'error' event, which Node treats as an uncaught exception
    // and would crash the whole extension host. This listener is what prevents that.
    child.on("error", (err: Error) => {
      stderr += (stderr ? "\n" : "") + err.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * True for the exit codes that specifically mean "there was no such command".
 *
 * Deliberately narrow. Matching *any* failure whose output mentions "command not found"
 * would hijack a genuine build failure that happens to echo that phrase from an optional
 * probe (`command -v foo || echo "foo: command not found"`), replacing the real error the
 * agent needs with an install hint for a tool it never required. A false negative here just
 * means the status quo — the failure is reported normally, with its output intact.
 *
 *   null — the spawn itself failed (POSIX ENOENT); nothing ever started.
 *   127  — the POSIX shell convention for "command not found".
 *   9009 — cmd.exe's equivalent, which is what every Windows command routes through
 *          (see planSpawn).
 */
function isCommandNotFoundExit(exitCode: number | null): boolean {
  return exitCode === null || exitCode === 127 || exitCode === 9009;
}

export async function handleShell(
  payload: ShellPayload,
  workspaceRoot: string,
  policy: CommandPolicy = {},
  signal?: AbortSignal,
): Promise<
  | ShellResult
  | { ok: false; error: string; missingCommand?: InstallHint; cancelled?: boolean; stdout?: string; stderr?: string }
  | { ok: true; requiresConfirmation: true; tier: string; description: string; unrecognizedCommand?: boolean }
> {
  const command = String(payload.command || "").trim();
  const args = Array.isArray(payload.args) ? payload.args.map((a) => String(a)).filter(Boolean) : [];
  const confirmed = payload.confirmed === true;
  const timeoutMs = Math.min(Math.max(Number(payload.timeout) || SHELL_TIMEOUT_MS, 1000), 10 * 60 * 1000);

  if (!command) return { ok: false, error: "Missing command." };

  // `command` is the executable, not a shell line: it's spawned directly, so shell operators
  // (&&, ||, |, ;, >, <, $(…), backticks) in it are never interpreted. Models frequently
  // cram a whole command line into `command` and get a confusing ENOENT. Detect that and
  // return actionable guidance instead — but only when the operators are in `command`
  // itself, so an explicit `bash -lc "a && b"` (operators live in args) still runs.
  if (/(&&|\|\||[|;<>`]|\$\()/.test(command)) {
    return {
      ok: false,
      error:
        "`command` is the executable name only — shell operators (&&, ||, |, ;, >, <, $(…)) in it are not interpreted. " +
        "Either issue separate shell_run calls, or invoke a shell explicitly: command \"bash\" with args [\"-lc\", \"<full command line>\"] " +
        "(or command \"cmd\" with args [\"/c\", \"<line>\"] on Windows).",
    };
  }

  const outcome = resolveShellConfirmation(command, args, confirmed, payload.allowedBinaries, policy);
  if (outcome.kind === "denied") return { ok: false, error: outcome.error };

  let cwd: string;
  try {
    cwd = resolveWorkspaceCwd(workspaceRoot, payload.cwd);
    validateArgs(command, args, { workspaceRoot, cwd, policy });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.kind === "confirm") {
    return { ok: true, requiresConfirmation: true, tier: outcome.tier, description: outcome.description, unrecognizedCommand: outcome.unrecognizedCommand };
  }

  const plan = planSpawn(command, args);
  const result = await runShellCommand(plan, cwd, timeoutMs, signal);

  if (result.cancelled) {
    return {
      ok: false,
      error: "Command cancelled.",
      cancelled: true,
      stdout: result.stdout.slice(0, STDOUT_MAX),
      stderr: result.stderr.slice(0, STDERR_MAX),
    };
  }

  /* The executable does not exist, so nothing ran. Reported as an ordinary result that is
     near-indistinguishable from a command that ran and printed nothing, and the agent
     re-issues it — and whatever it was a prerequisite for — until the iteration cap ends
     the turn. Fail it explicitly instead, and carry the install hint so the editor can
     offer the user a one-click fix.

     The reported name is preferred over the spawned one because the miss is usually nested
     (cmd.exe on Windows, or an explicit `bash -lc`), where the spawned binary is the shell,
     rather than the tool that is actually absent. */
  const missing = !result.timedOut && isCommandNotFoundExit(result.exitCode)
    ? detectMissingCommand(result.stderr)
    : null;
  if (missing) {
    const hint = installHintFor(missing);
    return { ok: false, error: describeMissingCommand(hint), missingCommand: hint };
  }

  return {
    ok: true,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, STDOUT_MAX),
    stderr: result.stderr.slice(0, STDERR_MAX),
    timedOut: result.timedOut,
    tier: outcome.tier,
    cwd,
  };
}

export { ProcessManager, buildEnv };
