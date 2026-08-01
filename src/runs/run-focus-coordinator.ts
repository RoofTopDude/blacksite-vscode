import type { RunFocus } from "./run-model.js";

/** Host-owned shared cursor. It carries intent, not trace payloads. */
export class RunFocusCoordinator {
  private readonly listeners = new Set<(focus: RunFocus) => void>();
  private readonly current = new Map<string, RunFocus>();

  publish(focus: Omit<RunFocus, "updatedAt"> & { updatedAt?: string }): RunFocus {
    const normalized: RunFocus = { ...focus, updatedAt: focus.updatedAt ?? new Date().toISOString() };
    this.current.set(normalized.runId, normalized);
    for (const listener of this.listeners) listener(normalized);
    return normalized;
  }

  get(runId: string): RunFocus | undefined {
    const focus = this.current.get(runId);
    return focus ? structuredClone(focus) : undefined;
  }

  onDidChange(listener: (focus: RunFocus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
