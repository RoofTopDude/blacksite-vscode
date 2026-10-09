import { useEffect, useState } from "react";

/* Every ticking duration in a running chat asks for the same one-second beat: each live tool call,
   the streaming turn, every running lane, the run bar. Giving each its own interval meant dozens
   of timers firing in the same second in a long run, each waking the page on its own. They now
   share one, which runs only while something is listening. */
const SHARED_INTERVAL_MS = 1000;
const sharedListeners = new Set<(now: number) => void>();
let sharedTimer: ReturnType<typeof setInterval> | undefined;

function subscribeShared(listener: (now: number) => void): () => void {
  sharedListeners.add(listener);
  sharedTimer ??= setInterval(() => {
    const now = Date.now();
    for (const each of sharedListeners) each(now);
  }, SHARED_INTERVAL_MS);
  return () => {
    sharedListeners.delete(listener);
    if (sharedListeners.size === 0 && sharedTimer !== undefined) {
      clearInterval(sharedTimer);
      sharedTimer = undefined;
    }
  };
}

/**
 * Returns a timestamp that updates every `intervalMs` while `active` is true, so a
 * component can render a duration that visibly ticks upward for whatever it's timing
 * (a running tool call, a streaming turn, the live session). No timer is created and
 * no re-renders happen while `active` is false — each caller only pays the cost while
 * the specific thing it's timing is actually in progress, so an idle chat has zero
 * background timers.
 */
export function useLiveClock(active: boolean, intervalMs = SHARED_INTERVAL_MS): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    if (intervalMs === SHARED_INTERVAL_MS) return subscribeShared(setNow);
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return now;
}
