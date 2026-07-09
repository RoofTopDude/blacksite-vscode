/* Cancellation helpers for LSP calls that already carry their own timeout
   (via lsp-queries.ts's execProvider/withTimeout). Kept vscode-free and pure
   so it's unit-testable with the real global AbortController.

   Deliberately wraps at the call site rather than threading a signal into
   execProvider/withTimeout's own signature: those are shared with the
   Codebase Map's symbol layer (graph-provider.ts, graph/symbol-indexer.ts),
   which has no signal to give and shouldn't be forced to change. */

/** Races an already-started promise against an abort signal. On abort,
    rejects "Cancelled."; otherwise passes the original resolution or
    rejection through unchanged. Removes its listener on every settle path. */
export function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {}); // we're not otherwise consuming p; avoid an unhandled rejection
    return Promise.reject(new Error("Cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("Cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/** Like withAbort, but also races a timeout that resolves undefined (silent,
    matching lsp-queries.ts's withTimeout) rather than rejecting — for calls
    that bypass the shared execProvider layer and need their own timeout,
    while still preserving a genuine rejection from `p` unchanged. */
export function withDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  return withAbort(
    new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    }),
    signal,
  );
}
