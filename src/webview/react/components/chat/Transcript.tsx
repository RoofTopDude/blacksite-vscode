import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useStore } from "@/lib/store";
import { Turn } from "./Turn";
import { LiveDot } from "./signal";

export function Transcript() {
  const store = useStore();
  const turns = store.chat.turns;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Mirrors `stick` as render state — a ref alone can't trigger the "jump to live"
  // button to appear/disappear as the user scrolls.
  const [stuck, setStuck] = useState(true);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const isStuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = isStuck;
    setStuck(isStuck);
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => { stick.current = true; setStuck(true); }, [store.chat.userTurnCount]);

  function jumpToLive(): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setStuck(true);
  }

  const showJump = !stuck && turns.length > 0;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-2.5 py-3">
        {store.chat.hasMessages && turns.length > 0 ? (
          <div className="flex flex-col gap-3.5">
            {turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-9 text-center">
            <span className="text-[1.35em] font-bold brand-text">Blacksite</span>
            <span className="max-w-[220px] text-[11.5px] leading-relaxed text-muted-foreground">
              Your workspace is ready. Ask anything, request edits, or right-click code to explain or fix.
            </span>
            <div className="mt-1 flex flex-col items-center gap-0.5 text-[10.5px] text-muted-foreground opacity-60">
              <span><span className="font-mono">@</span> to attach a file · <span className="font-mono">/</span> for commands</span>
              <span>Ctrl+Shift+E to explain a selection</span>
            </div>
          </div>
        )}
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToLive}
          className="fade-in chat-interactive absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1.5 text-[10.5px] font-medium text-foreground shadow-lg hover:border-primary/40"
        >
          {store.chat.running && <LiveDot />}
          <ArrowDown className="size-3" />
          {store.chat.running ? "Jump to live" : "Jump to latest"}
        </button>
      )}
    </div>
  );
}
