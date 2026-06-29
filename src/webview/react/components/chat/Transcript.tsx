import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { Turn } from "./Turn";

export function Transcript() {
  const store = useStore();
  const turns = store.chat.turns;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => { stick.current = true; }, [store.chat.turns.length]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-2 py-2.5">
      {store.chat.hasMessages && turns.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 py-9 text-center">
          <span className="text-[1.35em] font-bold brand-text">Blacksite</span>
          <span className="max-w-[220px] text-[11.5px] leading-relaxed text-muted-foreground">
            Your workspace is ready. Ask anything, request edits, or right-click code to explain or fix.
          </span>
          <span className="mt-0.5 text-[10.5px] text-muted-foreground opacity-60">Ctrl+Shift+E to explain a selection</span>
        </div>
      )}
    </div>
  );
}
