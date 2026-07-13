import { randomUUID } from "node:crypto";
import * as path from "node:path";

/** Serializes the full prepare/preview/apply/verify lifecycle across parent and delegated sessions. */
export class MutationCoordinator {
  private static readonly _workspaces = new Map<string, MutationCoordinator>();
  private _queue: Promise<void> = Promise.resolve();

  /** Parent and delegated sessions targeting the same workspace share one queue. */
  static forWorkspace(workspaceRoot: string): MutationCoordinator {
    const key = path.resolve(workspaceRoot).toLowerCase();
    let coordinator = this._workspaces.get(key);
    if (!coordinator) {
      coordinator = new MutationCoordinator();
      this._workspaces.set(key, coordinator);
    }
    return coordinator;
  }

  run<T>(operation: (transactionId: string) => Promise<T>): Promise<T> {
    const transactionId = randomUUID();
    const result = this._queue.then(() => operation(transactionId));
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
