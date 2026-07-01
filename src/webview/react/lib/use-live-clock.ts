import { useEffect, useState } from "react";

/**
 * Returns a timestamp that updates every `intervalMs` while `active` is true, so a
 * component can render a duration that visibly ticks upward for whatever it's timing
 * (a running tool call, a streaming turn, the live session). No timer is created and
 * no re-renders happen while `active` is false — each caller only pays the cost while
 * the specific thing it's timing is actually in progress, so an idle chat has zero
 * background timers.
 */
export function useLiveClock(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return now;
}
