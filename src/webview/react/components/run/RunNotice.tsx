import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "@/lib/store";

const SHOWN_FOR_MS = 9_000;

/**
 * What the host said about a run that the user should see once: a plan that cannot start, a
 * restore that was refused, a report not yet written. Without it those answers went nowhere and
 * the button the user pressed simply seemed to do nothing.
 */
export function RunNotice() {
  const store = useStore();
  const notice = store.runNotice;
  const [shownNonce, setShownNonce] = useState(0);
  const nonce = notice?.nonce ?? 0;

  useEffect(() => {
    if (!nonce) return;
    setShownNonce(nonce);
    const timer = setTimeout(() => setShownNonce(0), SHOWN_FOR_MS);
    return () => clearTimeout(timer);
  }, [nonce]);

  if (!notice || shownNonce !== notice.nonce) return null;
  return (
    <div className="run-notice reveal-in" role={notice.level === "error" ? "alert" : "status"} data-level={notice.level}>
      <span className="min-w-0 flex-1 text-sm">{notice.message}</span>
      <button type="button" className="chat-interactive rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setShownNonce(0)} aria-label="Dismiss" title="Dismiss">
        <X className="size-3" />
      </button>
    </div>
  );
}
