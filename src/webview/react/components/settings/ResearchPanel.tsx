import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Section, Field, Note } from "./common";
import { useResearch } from "@/lib/research-store";
import { post } from "@/lib/bridge";
import type { ResearchPolicy } from "../../../../browser/approval-types";

export function ResearchPanel() {
  const state = useResearch();
  const [draft, setDraft] = useState<ResearchPolicy>();
  const [key, setKey] = useState("");
  const [intent, setIntent] = useState("");
  const [domains, setDomains] = useState("");
  const [model, setModel] = useState("");
  const [operation, setOperation] = useState("search");
  const [scope, setScope] = useState("workspace");
  const policy = draft ?? state.configured;
  const update = (change: Partial<ResearchPolicy>) => setDraft({ ...policy, ...change });
  return <Section>
    <Note>Public HTTPS reading and Brave search use approved domains. Interactive Chromium is limited to explicit local testing origins; public rendering, PDF, uploads and credential entry are unavailable.</Note>
    <Field label="Allowed domains" hint="One hostname per line, including its subdomains. Workspace lists replace the user list. Only this confirmation grants new access.">
      <Textarea aria-label="Allowed research domains" value={policy.allowedDomains.join("\n")} onChange={e => update({ allowedDomains: e.target.value.split("\n") })} />
    </Field>
    <Field label="Denied domains" hint="Denies override every matching grant."><Textarea aria-label="Denied research domains" value={policy.deniedDomains.join("\n")} onChange={e => update({ deniedDomains: e.target.value.split("\n") })} /></Field>
    <Note>Effective allowed domains: {state.policy.allowedDomains.join(", ") || "none"}. Effective search provider: {state.policy.searchProvider}.</Note>
    <Field label="Unknown domains"><Select ariaLabel="Unknown domain policy" value={policy.unknownDomainPolicy} options={[{ value: "ask", label: "Ask human" }, { value: "deny", label: "Deny" }]} onChange={v => update({ unknownDomainPolicy: v as "ask" | "deny" })} /></Field>
    <Field label="Search provider" hint="Enabling Brave authorizes sending reviewed queries to its API. Source-domain grants are separate."><Select ariaLabel="Search provider" value={policy.searchProvider} options={[{ value: "none", label: "None" }, { value: "brave", label: "Brave" }]} onChange={v => update({ searchProvider: v as "none" | "brave" })} /></Field>
    <Field label="Brave API key" hint={state.keyConfigured ? "Key configured in SecretStorage. Leave empty to retain it." : "Stored in VS Code SecretStorage."}><Input aria-label="Brave API key" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} /></Field>
    <Select ariaLabel="Settings scope" value={scope} options={[{ value: "workspace", label: "Workspace" }, { value: "global", label: "User" }]} onChange={setScope} />
    <div className="flex flex-wrap gap-2"><Button onClick={() => { post({ type: "research_save", policy: { ...policy, allowedDomains: policy.allowedDomains.filter(Boolean), deniedDomains: policy.deniedDomains.filter(Boolean) }, key, scope }); setKey(""); setDraft(undefined); }}>Confirm domain and provider policy</Button><Button variant="outline" onClick={() => post({ type: "research_save", policy: state.configured, clearKey: true, scope })}>Remove key</Button></div>
    <Field label="Browser approval reviewer" hint="Human review is the default. Delegation applies only to this chat session and never includes new domains, scripts or consequential actions. Uses the current configured provider in a separate no-tools call.">
      <Select ariaLabel="Preferred input review mode" value={state.inputApprovalPreference ?? "human"} options={[{ value: "human", label: "Human review" }, { value: "reviewer", label: "Prefer reviewer (explicit delegation still required)" }]} onChange={mode => post({ type: "research_mode", mode })} />
      <Label htmlFor="browser-review-intent">Your original task</Label><Textarea id="browser-review-intent" value={intent} onChange={e => setIntent(e.target.value)} />
      <Label htmlFor="browser-review-domains">Delegated domains</Label><Input id="browser-review-domains" placeholder="api.search.brave.com" value={domains} onChange={e => setDomains(e.target.value)} />
      <Label htmlFor="browser-review-model">Reviewer model ID</Label><Input id="browser-review-model" value={model} onChange={e => setModel(e.target.value)} />
      <Select ariaLabel="Delegated operation classes" value={operation} onChange={setOperation} options={[{ value: "search", label: "Search queries" }, { value: "fill", label: "Form filling" }, { value: "both", label: "Queries and form filling" }]} />
      <Button disabled={!intent.trim() || !domains.trim() || !model.trim()} onClick={() => post({ type: "research_delegate", delegation: { intent, model, domains: domains.split(/[,\s]+/).filter(Boolean), operations: operation === "both" ? ["search", "fill"] : [operation] } })}>Delegate review for this session</Button>
      <Button variant="outline" onClick={() => post({ type: "research_revoke" })}>Revoke delegation and session grants</Button>
    </Field>
    {state.error && <p role="alert">{state.error}</p>}
    {state.audits.length > 0 && <details><summary>Recent approval decisions (values are not retained)</summary>{state.audits.slice(-10).reverse().map(a => <p key={a.id} className="break-all text-xs">{a.approver} {a.model ?? ""} · {a.operation} · {a.decision} · {a.reason} · {a.digest}</p>)}</details>}
  </Section>;
}
