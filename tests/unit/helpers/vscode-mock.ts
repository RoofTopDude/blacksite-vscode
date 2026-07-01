export const window = {
  showWarningMessage: async (..._args: unknown[]): Promise<string | undefined> => "Deny",
  showInformationMessage: async (..._args: unknown[]): Promise<string | undefined> => undefined,
};

/** Minimal EventEmitter parity for host modules (e.g. PlanningStore) under unit tests. */
export class EventEmitter<T> {
  private readonly _listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void): { dispose: () => void } => {
    this._listeners.add(listener);
    return { dispose: () => { this._listeners.delete(listener); } };
  };
  fire(data: T): void {
    for (const listener of this._listeners) listener(data);
  }
  dispose(): void {
    this._listeners.clear();
  }
}
