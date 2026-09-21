import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StatusPill } from "./signal";
import { post } from "@/lib/bridge";
import { useLiveClock } from "@/lib/use-live-clock";
import { useBrowserGates, useResearch } from "@/lib/research-store";
import { actions, useStore } from "@/lib/store";
import type { BrowserDecision, BrowserProposal } from "../../../../browser/approval-types";

export function visibleValue(value: string | boolean): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Every URL a domain card covers; a batched access request carries several. */
function proposalUrls(p: BrowserProposal): string[] {
  return p.urls?.length ? p.urls : [p.url];
}

/**
 * What the card is really deciding about. A domain proposal is answered in registrable
 * domains the host computed ("wikipedia.org"), because that is the grant; only proposals
 * without them — an input or action card — fall back to the literal hostname.
 */
export function proposalHosts(p: BrowserProposal): string[] {
  if (p.domains?.length) return p.domains;
  return [...new Set(proposalUrls(p).map((url) => {
    try { return new URL(url).hostname; } catch { return p.title; }
  }))];
}

function countdown(msLeft: number): string {
  const total = Math.max(0, Math.round(msLeft / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One web approval, rendered wherever a gate is shown: inline on the tool call in the
 * transcript and in the docked action bar. It deliberately reads like the command-approval
 * card next to it — same decision vocabulary, same always-allow scope pair — because it is
 * the same kind of decision, and the only reason it ever looked different was that it came
 * down a separate channel.
 *
 * Exact values stay local: they arrive on the ephemeral research channel, are rendered (and
 * edited) here, and are never written into the transcript or webview state.
 */
export function BrowserProposalBody({ proposal: p }: { proposal: BrowserProposal }) {
  const [values, setValues] = useState(p.fields.map(f => f.value));
  const [sent, setSent] = useState(false);
  const hosts = useMemo(() => proposalHosts(p), [p]);
  const urls = proposalUrls(p);
  const now = useLiveClock(!sent);
  const edited = JSON.stringify(values) !== JSON.stringify(p.fields.map(f => f.value));
  const decide = (decision: BrowserDecision["decision"]) => {
    setSent(true);
    post({ type: "browser_decision", decision: { id: p.id, decision, ...(decision !== "deny" && edited ? { values } : {}) } });
  };
  // Only input cards and domain cards that merged a query review accept corrections; the
  // coordinator answers an edited action/script proposal with a denial, so never offer one.
  const editable = p.kind === "input" || p.kind === "domain";
  const alwaysLabel = hosts.length > 1 ? `these ${hosts.length} domains` : hosts[0] || p.title;

  return (
    <div className="flex flex-col gap-2" aria-label="Browser approval">
      <div className="chat-sunken px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone="info" className="text-2xs">{p.kind === "domain" ? "web access" : p.kind === "input" ? "outbound values" : p.kind === "script" ? "test script" : "browser action"}</StatusPill>
          {hosts.map(host => <span key={host} className="break-all font-mono text-xs text-foreground">{host}</span>)}
        </div>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-snug text-muted-foreground">{p.purpose}</p>
        {urls.length > 1 && (
          <ul className="mt-1 max-h-32 overflow-auto">
            {urls.map(url => <li key={url} className="break-all font-mono text-2xs text-muted-foreground">{url}</li>)}
          </ul>
        )}
      </div>

      {p.kind === "domain" && (
        <p className="text-2xs leading-snug text-muted-foreground">
          Approving covers {hosts.length > 1 ? "these domains" : hosts[0] || p.title} and every subdomain, so the agent can read any page on {hosts.length > 1 ? "them" : "it"} without asking again.
          {" "}Domains you block in settings always win. Source access does not establish reliability.
        </p>
      )}

      {p.fields.map((field, i) => (
        <div key={`${p.id}-${i}`} className="flex flex-col gap-1">
          <Label htmlFor={`${p.id}-${i}`}>{field.label} ({field.type}, {field.mode})</Label>
          {!editable
            ? null
            : typeof field.value === "string"
            ? <Textarea id={`${p.id}-${i}`} value={String(values[i])} onChange={e => setValues(v => v.map((x, n) => n === i ? e.target.value : x))} rows={3} spellCheck={false} disabled={sent} />
            : <label className="flex gap-2 text-xs"><input id={`${p.id}-${i}`} type="checkbox" checked={values[i] === true} disabled={sent} onChange={e => setValues(v => v.map((x, n) => n === i ? e.target.checked : x))} />Checked</label>}
          <pre tabIndex={0} aria-label={`Exact escaped value for ${field.label}`} className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 text-2xs">{visibleValue(values[i]!)}</pre>
        </div>
      ))}

      {p.fields.length > 0 && (
        <p className="text-2xs leading-snug text-muted-foreground">
          Full values are shown above; the escaped view exposes whitespace and invisible characters. Only what is on screen when you decide is sent.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-1.5">
          {p.kind === "domain" ? (
            <>
              {/* The site-wide grant is the primary action: a research read is almost never a
                  single page, and making the narrow one the default is what turned reading a
                  documentation site into an approval per URL. */}
              <Button type="button" size="xs" disabled={sent} onClick={() => decide("session")}>Allow this session</Button>
              <Button type="button" size="xs" variant="outline" disabled={sent} onClick={() => decide("page")}>Just this page</Button>
            </>
          ) : (
            <Button type="button" size="xs" disabled={sent} onClick={() => decide(edited ? "edit" : "allow")}>Approve exact values</Button>
          )}
          <Button type="button" size="xs" variant="destructive" disabled={sent} onClick={() => decide("deny")}>Deny</Button>
        </div>
        {/* Mirrors the always-allow group on a command approval: one decision, two scopes. */}
        {p.kind === "domain" && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-white/[0.02] px-1.5 py-1">
            <span className="shrink-0 text-xs text-muted-foreground">
              Always allow <span className="font-mono text-foreground">{alwaysLabel}</span>
            </span>
            <div className="ml-auto flex gap-1">
              <Button type="button" size="xs" variant="outline" disabled={sent} onClick={() => decide("workspace")}>This project</Button>
              <Button type="button" size="xs" variant="outline" disabled={sent} onClick={() => decide("global")}>All projects</Button>
            </div>
          </div>
        )}
      </div>

      {/* An unanswered proposal expires rather than authorizing stale work later, so the
          remaining time is part of the decision rather than a surprise. */}
      <p className="text-2xs text-muted-foreground">
        {sent ? "Decision sent." : `Expires in ${countdown(p.expiresAt - now)} if left unanswered.`}
      </p>
    </div>
  );
}

/** Shown while the gate event has arrived but the proposal itself has not — the two travel on
 *  different channels, and an empty flicker reads worse than saying what is happening. */
export function BrowserProposalPlaceholder() {
  return <p className="text-xs text-muted-foreground">Fetching the details of this web access request…</p>;
}

/**
 * Persistent reminder that a model, not the user, is clearing browser input proposals for
 * this session. Kept outside the pending queue on purpose: it is standing state, not an
 * action, and it must stay visible on every view.
 */
export function BrowserDelegationBanner() {
  const state = useResearch();
  if (!state.delegation) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-[color:var(--s-warn)]/10 px-2 py-1 text-2xs">
      <span className="flex-1 truncate text-foreground">
        Browser input approvals are delegated to <span className="font-mono">{state.delegation.model}</span> for this session.
      </span>
      <Button size="xs" variant="outline" onClick={() => post({ type: "research_revoke" })}>Revoke</Button>
    </div>
  );
}

/**
 * Off-chat reminder that a web approval is blocking the run.
 *
 * The pending queue lives in the chat's docked action bar, which the Settings and History
 * views replace — and a run blocked on the user must never be invisible just because they
 * tabbed away. One line, one jump back.
 */
export function BrowserApprovalJumpBar() {
  const store = useStore();
  const gates = useBrowserGates();
  if (store.view === "chat" || gates.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => actions.setView("chat")}
      className="chat-interactive flex items-center gap-2 border-b border-primary/30 bg-primary/[0.08] px-2 py-1.5 text-left text-xs"
    >
      <span className="pulse-dot" />
      <span className="flex-1 truncate font-medium text-foreground">
        {gates.length === 1 ? "A web access request is waiting for you" : `${gates.length} web access requests are waiting for you`}
      </span>
      <span className="shrink-0 text-primary">Review</span>
    </button>
  );
}
