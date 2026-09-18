import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { post } from "@/lib/bridge";
import { useResearch, requestResearchState } from "@/lib/research-store";
import type { BrowserDecision, BrowserProposal } from "../../../../browser/approval-types";

export function visibleValue(value: string | boolean): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function ProposalCard({ proposal: p }: { proposal: BrowserProposal }) {
  const [values, setValues] = useState(p.fields.map(f => f.value));
  const [sent, setSent] = useState(false);
  const decide = (decision: BrowserDecision["decision"]) => {
    setSent(true);
    post({ type: "browser_decision", decision: { id: p.id, decision, ...(decision === "edit" ? { values } : {}) } });
  };
  return <section aria-label="Browser approval" className="flex flex-col gap-2 rounded-md border border-border p-3">
    <strong>{p.kind === "domain" ? "Research domain access" : p.kind === "input" ? "Review exact browser input" : p.kind === "script" ? "Privileged local test script" : "Browser action approval"}</strong>
    <p className="break-all text-sm">{p.origin} · {p.title}</p>
    <p className="break-all text-xs text-muted-foreground">{p.url} · Document {p.document || "not loaded"}</p>
    <p className="whitespace-pre-wrap text-sm">{p.purpose}</p>
    {p.kind === "domain" && <p className="text-xs">Domain grants include subdomains. Page once does not approve redirects to other pages. Source access does not establish reliability.</p>}
    {p.fields.map((field, i) => <div key={`${p.id}-${i}`} className="flex flex-col gap-1">
      <Label htmlFor={`${p.id}-${i}`}>{field.label} ({field.type}, {field.mode})</Label>
      {p.kind === "input" && typeof field.value === "string"
        ? <Textarea id={`${p.id}-${i}`} value={String(values[i])} onChange={e => setValues(v => v.map((x, n) => n === i ? e.target.value : x))} rows={4} spellCheck={false} />
        : p.kind === "input" && typeof field.value === "boolean"
          ? <label className="flex gap-2"><input id={`${p.id}-${i}`} type="checkbox" checked={values[i] === true} onChange={e => setValues(v => v.map((x, n) => n === i ? e.target.checked : x))} />Checked</label>
          : null}
      <pre tabIndex={0} aria-label={`Exact escaped value for ${field.label}`} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2 text-xs">{visibleValue(values[i]!)}</pre>
    </div>)}
    <p className="text-xs text-muted-foreground">Full values are shown above; escaped view exposes whitespace and invisible characters. Expires {new Date(p.expiresAt).toLocaleTimeString()}.</p>
    <div className="flex flex-wrap gap-2">
      {p.kind === "domain" ? <>
        <Button size="sm" disabled={sent} onClick={() => decide("page")}>Page once</Button>
        <Button size="sm" variant="outline" disabled={sent} onClick={() => decide("session")}>Domain this session</Button>
        <Button size="sm" variant="outline" disabled={sent} onClick={() => decide("workspace")}>Always in workspace</Button>
        <Button size="sm" variant="outline" disabled={sent} onClick={() => decide("global")}>Always for user</Button>
      </> : <Button size="sm" disabled={sent} onClick={() => decide(JSON.stringify(values) === JSON.stringify(p.fields.map(f => f.value)) ? "allow" : "edit")}>Approve exact {p.kind === "input" ? "values" : "operation"}</Button>}
      <Button size="sm" variant="outline" disabled={sent} onClick={() => decide("deny")}>Deny</Button>
    </div>
  </section>;
}
export function BrowserApprovals() {
  const state = useResearch();
  useEffect(requestResearchState, []);
  if (!state.pending.length && !state.delegation) return null;
  return <aside className="flex max-h-[65vh] shrink-0 flex-col gap-2 overflow-auto border-t border-border bg-background p-2" aria-label="Pending browser approvals">
    {state.delegation && <div className="flex items-center gap-2 text-xs"><span>Browser approval reviewer active · {state.delegation.model}</span><Button size="xs" variant="outline" onClick={() => post({ type: "research_revoke" })}>Revoke</Button></div>}
    {state.pending.map(p => <ProposalCard key={p.id} proposal={p} />)}
  </aside>;
}
