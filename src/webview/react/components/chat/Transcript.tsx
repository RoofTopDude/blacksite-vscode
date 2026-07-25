import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ChevronUp } from "lucide-react";
import { useStore } from "@/lib/store";
import { Turn } from "./Turn";
import { LiveDot } from "./signal";

/* Long-horizon sessions can accumulate hundreds of turns; rendering them all
   puts thousands of animated nodes in the webview and kills scrolling long
   before the agent stops. Only the most recent window is mounted — older turns
   stay in the chat model and page in through "Show earlier". */
const WINDOW_INITIAL = 30;
const WINDOW_STEP = 50;

export function Transcript() {
  const store = useStore();
  const turns = store.chat.turns;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Mirrors `stick` as render state — a ref alone can't trigger the "jump to live"
  // button to appear/disappear as the user scrolls.
  const [stuck, setStuck] = useState(true);
  const [visible, setVisible] = useState(WINDOW_INITIAL);
  // Scroll anchor for prepends: expanding the window grows content above the
  // viewport, so scrollTop must shift by the growth or the view visibly jumps.
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const prevLen = useRef(turns.length);

  // A shrinking turn list means a new or restored conversation — reset the window.
  useEffect(() => {
    if (turns.length < prevLen.current) setVisible(WINDOW_INITIAL);
    prevLen.current = turns.length;
  }, [turns.length]);

  const hiddenCount = Math.max(turns.length - visible, 0);
  const shownTurns = hiddenCount > 0 ? turns.slice(hiddenCount) : turns;

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const isStuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = isStuck;
    setStuck(isStuck);
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prepend.current) {
      el.scrollTop = prepend.current.top + (el.scrollHeight - prepend.current.height);
      prepend.current = null;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => { stick.current = true; setStuck(true); }, [store.chat.userTurnCount]);

  function showEarlier(): void {
    const el = scrollRef.current;
    if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisible((v) => v + WINDOW_STEP);
  }

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
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={showEarlier}
                className="chat-interactive mx-auto flex items-center gap-1.5 rounded-full border border-border bg-white/[0.03] px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                Show earlier · {hiddenCount} more {hiddenCount === 1 ? "turn" : "turns"}
              </button>
            )}
            {shownTurns.map((turn) => <Turn key={turn.id} turn={turn} />)}
          </div>
        ) : (
          <div className="turn-in relative flex flex-col items-center gap-2.5 px-4 py-10 text-center">
            <div className="welcome-glow" aria-hidden="true" />
            <div className="welcome-orb" aria-hidden="true" />
            <span className="text-[1.35em] font-bold brand-text">Blacksite</span>
            <span className="max-w-[230px] text-base leading-relaxed text-muted-foreground">
              Your workspace is ready. Ask anything, request edits, or right-click code to explain or fix.
            </span>
            <div className="mt-1.5 flex flex-col items-center gap-1.5">
              <span className="welcome-hint"><kbd>@</kbd> attach a file <i>·</i> <kbd>/</kbd> commands</span>
              <span className="welcome-hint"><kbd>↑</kbd> recall a previous message</span>
              <span className="welcome-hint"><kbd>Ctrl+Shift+E</kbd> explain a selection</span>
            </div>
          </div>
        )}
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToLive}
          className="fade-in chat-interactive absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1.5 text-sm font-medium text-foreground shadow-lg hover:border-primary/40"
        >
          {store.chat.running && <LiveDot />}
          <ArrowDown className="size-3" />
          {store.chat.running ? "Jump to live" : "Jump to latest"}
        </button>
      )}
    </div>
  );
}
