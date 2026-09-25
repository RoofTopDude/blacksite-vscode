import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { actions, useStore } from "@/lib/store";
import { Field, Note } from "./common";

export function ChatGptAccount() {
  const { chatgpt: account } = useStore();
  useEffect(() => {
    actions.chatGptAccount("refresh");
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") actions.chatGptAccount("refresh");
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const connected = account.status === "connected";
  const connecting = account.status === "connecting";
  return <Field label="ChatGPT subscription" hint="Use your plan's Codex allowance in Blacksite. Access and limits depend on your account. Requires Codex CLI or the Codex VS Code extension; the tool bridge is experimental.">
    <div className="flex flex-col gap-3" aria-live="polite">
      <Note>{connected ? `${account.email ?? "Signed in"}${account.planType ? ` · ${account.planType}` : ""}` : connecting ? "Finish signing in in your browser." : "Sign in to connect your subscription."}</Note>
      <div className="flex flex-wrap gap-2">
        {!connected && !connecting && <Button size="xs" onClick={() => actions.chatGptAccount("login")} disabled={account.refreshing}>Sign in with ChatGPT</Button>}
        {connecting && <Button size="xs" variant="outline" onClick={() => actions.chatGptAccount("cancel")}>Cancel sign-in</Button>}
        {connected && <Button size="xs" variant="outline" onClick={() => actions.chatGptAccount("logout")}>Sign out</Button>}
        <Button size="xs" variant="ghost" onClick={() => actions.chatGptAccount("refresh")} disabled={account.refreshing}>{account.refreshing ? "Refreshing…" : "Refresh usage"}</Button>
      </div>
      {account.error && <p role="alert" className="text-sm text-destructive">{account.error}</p>}
      {connected && account.limits.length === 0 && <Note>Usage limits are not available yet.</Note>}
      {connected && account.limits.map((limit, index) => <div key={limit.limitId ?? index} className="flex flex-col gap-2">
        <Note>{limit.limitName ?? "Codex usage"}</Note>
        {(["primary", "secondary"] as const).map((key) => {
          const window = limit[key];
          if (!window || !Number.isFinite(window.usedPercent)) return null;
          const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
          const minutes = window.windowDurationMins;
          const label = minutes ? minutes % 1440 === 0 ? `${minutes / 1440}-day window` : minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window` : `${key === "primary" ? "Primary" : "Secondary"} window`;
          return <div key={key} className="flex flex-col gap-1">
            <div className="flex justify-between gap-2 text-sm"><span>{label}</span><span>{Math.round(remaining)}% remaining</span></div>
            <meter className="w-full" min={0} max={100} value={remaining} aria-label={`${label} remaining allowance`}>{remaining}%</meter>
            <Note>{window.resetsAt ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : "Reset time not reported"}</Note>
          </div>;
        })}
        {limit.credits && <Note>{limit.credits.unlimited ? "Unlimited credits" : limit.credits.balance != null ? `Credits: ${limit.credits.balance}` : limit.credits.hasCredits ? "Credits available" : "No additional credits"}</Note>}
      </div>)}
      {account.updatedAt && <Note>Last updated {new Date(account.updatedAt).toLocaleTimeString()}. Shared with other Codex usage on this account. These are subscription limits, not ChatGPT chat message limits.</Note>}
      <Note>API keys remain separate. Embeddings and audio transcription still require their own API credentials.</Note>
    </div>
  </Field>;
}
