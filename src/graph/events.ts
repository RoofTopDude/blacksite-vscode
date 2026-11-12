/* Event primitives for the Codebase Map, shaped like vscode.Event / vscode.EventEmitter /
   vscode.Disposable so Map modules can publish events without importing vscode, and VS Code-facing
   code can use them unchanged: a Map Event is assignable to vscode.Event, and its subscriptions
   go straight into a context.subscriptions array. */

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (value: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class Emitter<T> implements Disposable {
  private _listeners: Array<(value: T) => unknown> | null = [];

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
    const listeners = this._listeners;
    if (!listeners) return { dispose: () => undefined };
    listeners.push(bound);
    let disposed = false;
    const subscription: Disposable = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = this._listeners;
        const at = current ? current.indexOf(bound) : -1;
        if (at >= 0) current!.splice(at, 1);
      },
    };
    disposables?.push(subscription);
    return subscription;
  };

  /** Deliver to every current listener. A listener that throws is reported and does not stop the
      others, as VS Code's EventEmitter behaves. */
  fire(value: T): void {
    const listeners = this._listeners;
    if (!listeners || listeners.length === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error("Codebase Map: an event listener failed", error);
      }
    }
  }

  dispose(): void {
    this._listeners = null;
  }
}
