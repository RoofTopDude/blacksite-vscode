import * as vscode from "vscode";

export type ProviderOutcome<T> =
  | { status: "ok"; value: T; durationMs: number; attempts: number; warmedUp?: boolean }
  | { status: "timeout"; durationMs: number; attempts: number }
  | { status: "error"; message: string; durationMs: number; attempts: number }
  | { status: "cancelled"; durationMs: number; attempts: number }
  | { status: "unavailable"; reason?: string; durationMs: number; attempts: number };

export interface ProviderExecutionOptions<T> {
  signal?: AbortSignal;
  /** Total wall-clock budget across every attempt and backoff. */
  totalTimeoutMs?: number;
  /** Maximum attempts, including the initial request. Read operations opt into >1. */
  maxAttempts?: number;
  delayMs?: number;
  /** Only successful values for which this returns true are retried. */
  isEmpty?: (value: T) => boolean;
  /** Side-effect commands commonly resolve with void; provider reads should not opt in. */
  allowUndefined?: boolean;
}

export type ProviderCommandRunner = <T>(command: string, ...args: unknown[]) => PromiseLike<T>;

const DEFAULT_TIMEOUT_MS = 9_000;

/**
 * Executes VS Code language-feature commands without collapsing empty results,
 * provider failures, cancellation, and timeouts into the same `undefined` value.
 *
 * VS Code's execute-provider commands do not accept a public CancellationToken.
 * Cancellation therefore stops local waiting and retries; the already-started
 * command is still observed to avoid an unhandled rejection.
 */
export class ProviderExecutor {
  constructor(
    private readonly _run: ProviderCommandRunner = <T>(command: string, ...args: unknown[]) =>
      vscode.commands.executeCommand<T>(command, ...args),
  ) {}

  async execute<T>(
    command: string,
    args: unknown[] = [],
    opts: ProviderExecutionOptions<T> = {},
  ): Promise<ProviderOutcome<T>> {
    const started = Date.now();
    const deadline = started + Math.max(1, opts.totalTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
    const delayMs = Math.max(0, opts.delayMs ?? 300);
    let attempts = 0;

    while (attempts < maxAttempts) {
      if (opts.signal?.aborted) return this._terminal("cancelled", started, attempts);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this._terminal("timeout", started, attempts);

      attempts += 1;
      const outcome = await this._attempt<T>(command, args, remaining, opts.signal);
      if (outcome.status !== "ok") {
        return { ...outcome, durationMs: Date.now() - started, attempts };
      }

      if ((outcome.value === undefined || outcome.value === null) && !opts.allowUndefined) {
        return {
          status: "unavailable",
          reason: "The provider command returned no value; the feature may be unavailable at this location.",
          durationMs: Date.now() - started,
          attempts,
        };
      }

      let empty = false;
      try {
        empty = opts.isEmpty?.(outcome.value) ?? false;
      } catch (error) {
        return {
          status: "error",
          message: `Provider returned an unexpected result shape: ${errorMessage(error)}`,
          durationMs: Date.now() - started,
          attempts,
        };
      }
      if (!empty || attempts >= maxAttempts) {
        return {
          status: "ok",
          value: outcome.value,
          durationMs: Date.now() - started,
          attempts,
          warmedUp: attempts > 1 || undefined,
        };
      }

      const waitBudget = deadline - Date.now();
      if (waitBudget <= 0) return this._terminal("timeout", started, attempts);
      const waited = await abortableDelay(Math.min(delayMs, waitBudget), opts.signal);
      if (!waited) return this._terminal("cancelled", started, attempts);
    }

    return this._terminal("timeout", started, attempts);
  }

  private _terminal(
    status: "timeout" | "cancelled",
    started: number,
    attempts: number,
  ): ProviderOutcome<never> {
    return { status, durationMs: Date.now() - started, attempts };
  }

  private _attempt<T>(
    command: string,
    args: unknown[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProviderOutcome<T>> {
    if (signal?.aborted) return Promise.resolve({ status: "cancelled", durationMs: 0, attempts: 0 });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: ProviderOutcome<T>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => finish({ status: "cancelled", durationMs: 0, attempts: 1 });
      const timer = setTimeout(() => finish({ status: "timeout", durationMs: timeoutMs, attempts: 1 }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      let request: PromiseLike<T>;
      try {
        request = this._run<T>(command, ...args);
      } catch (err) {
        finish({ status: "error", message: errorMessage(err), durationMs: 0, attempts: 1 });
        return;
      }
      Promise.resolve(request).then(
        (value) => finish({ status: "ok", value, durationMs: 0, attempts: 1 }),
        (err) => finish({ status: "error", message: errorMessage(err), durationMs: 0, attempts: 1 }),
      );
    });
  }
}

export function providerMetadata(outcome: ProviderOutcome<unknown>): Record<string, unknown> {
  return {
    providerStatus: outcome.status,
    durationMs: outcome.durationMs,
    attempts: outcome.attempts,
    warmedUp: outcome.status === "ok" ? outcome.warmedUp : undefined,
  };
}

export function providerFailureMessage(feature: string, outcome: ProviderOutcome<unknown>): string {
  if (outcome.status === "error") return `${feature} provider failed: ${outcome.message}`;
  if (outcome.status === "timeout") return `${feature} provider timed out after ${outcome.durationMs}ms.`;
  if (outcome.status === "cancelled") return "Cancelled.";
  if (outcome.status === "unavailable") return outcome.reason ?? `No ${feature} provider is available.`;
  return `${feature} provider returned no result.`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
