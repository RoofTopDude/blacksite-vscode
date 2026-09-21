import { createHash, randomUUID } from "node:crypto";
import type { ContinuationModel } from "../continuation/continuation-model.js";
import { BrowserPolicyError, cancelled, type BrowserAnchor, type BrowserAudit, type BrowserDecision, type BrowserDelegation, type BrowserField, type BrowserProposal } from "./approval-types.js";
import { baseDomain, DomainPolicy, redactedUrl, researchUrl } from "./domain-policy.js";
import { reviewInput, withinDelegation } from "./input-reviewer.js";

export type ProposalInput = Omit<BrowserProposal, "id" | "digest" | "session" | "version" | "expiresAt">;
export interface BrowserApprovalHost {
  ask(proposal: BrowserProposal, signal?: AbortSignal): Promise<BrowserDecision>;
  /** One attested write per decision: a batched card approving four hosts must not reset and
   *  rewrite policy four times. */
  persistDomains?(domains: string[], scope: "workspace" | "global"): Promise<void>;
  audit?(event: BrowserAudit): void;
  reviewer?: ContinuationModel;
}
export interface AccessOptions {
  anchor?: BrowserAnchor;
  /** Exact values the same card should review alongside the grant. A read whose URL carries a
   *  query needs both, and asking twice for one retrieval is the friction this removes. */
  fields?: BrowserField[];
}
export class BrowserApprovalCoordinator {
  private session = randomUUID();
  private epoch = 0;
  private delegation?: BrowserDelegation;
  private revocation = new AbortController();
  constructor(readonly policy: DomainPolicy, private host: BrowserApprovalHost) {}
  delegate(value?: BrowserDelegation): void { this.revocation.abort(); this.revocation = new AbortController(); this.delegation = value ? structuredClone(value) : undefined; this.epoch++; this.session = randomUUID(); }
  get revocationSignal(): AbortSignal { return this.revocation.signal; }
  reset(): void { this.session = randomUUID(); this.delegate(); this.policy.revoke(); }
  assertCurrent(proposal: BrowserProposal, signal?: AbortSignal): void {
    cancelled(signal);
    if (proposal.session !== this.session || proposal.version !== this.policy.version || Date.now() >= proposal.expiresAt) throw new BrowserPolicyError("stale_target", "Authorization expired or was revoked before execution.");
  }
  private proposal(input: ProposalInput): BrowserProposal {
    const p = { ...structuredClone(input), id: randomUUID(), session: this.session, version: this.policy.version, expiresAt: Date.now() + 300_000 };
    return Object.freeze({ ...p, digest: createHash("sha256").update(JSON.stringify(p)).digest("hex") });
  }
  async approve(input: ProposalInput, signal?: AbortSignal): Promise<BrowserProposal> {
    cancelled(signal);
    let proposal = this.proposal(input);
    const epoch = this.epoch;
    const started = Date.now();
    const assertCurrent = () => {
      cancelled(signal);
      if (epoch !== this.epoch || proposal.session !== this.session || proposal.version !== this.policy.version || Date.now() >= proposal.expiresAt) throw new BrowserPolicyError("stale_target", "Approval expired or policy/delegation changed. Request a fresh proposal.");
    };
    let approver: "human" | "reviewer" = "human";
    let reason = "Human decision";
    let decision: BrowserDecision | undefined;
    if (this.delegation && this.host.reviewer && withinDelegation(proposal, this.delegation)) {
      const review = await reviewInput(this.host.reviewer, proposal, this.delegation, signal);
      assertCurrent();
      reason = review.reason;
      if (review.decision !== "ask_human") { approver = "reviewer"; decision = { id: proposal.id, decision: review.decision }; }
    }
    if (!decision) decision = await this.host.ask(structuredClone(proposal), signal);
    assertCurrent();
    if (decision.id !== proposal.id) throw new BrowserPolicyError("stale_target", "Approval identity does not match.");
    const allowed = proposal.kind === "domain" ? ["page", "session", "workspace", "global"] : proposal.kind === "input" ? ["allow", "edit"] : ["allow"];
    if (!allowed.includes(decision.decision)) {
      this.host.audit?.({ id: proposal.id, digest: proposal.digest, kind: proposal.kind, operation: proposal.operation, approver, decision: "deny", reason, elapsedMs: Date.now() - started });
      throw new BrowserPolicyError("denied", "Browser proposal denied. Do not retry through another tool.");
    }
    // Corrected values ride an "edit" decision, or a domain decision whose card also carried
    // exact values to review. Either way the approved proposal is rebuilt around the human's
    // values, so nothing but what was on screen at decision time can execute.
    if (decision.values) {
      if (!proposal.fields.length || decision.values.length !== proposal.fields.length || decision.values.some((v, i) => typeof v !== typeof proposal.fields[i]!.value)) throw new BrowserPolicyError("denied", "Edited values do not match the proposal fields.");
      proposal = this.proposal({ ...input, fields: input.fields.map((f, i) => ({ ...f, value: decision.values![i]! })) });
    } else if (decision.decision === "edit") throw new BrowserPolicyError("denied", "Edited values do not match the proposal fields.");
    if (proposal.kind === "domain") {
      const targets = input.urls?.length ? input.urls : [input.url];
      if (decision.decision === "workspace" || decision.decision === "global") {
        if (!this.host.persistDomains) throw new BrowserPolicyError("approval_required", "Permanent domain approval is unavailable.");
        await this.host.persistDomains([...new Set(targets.map(u => baseDomain(researchUrl(u).hostname)))], decision.decision);
      }
      for (const target of targets) this.policy.grant(target, decision.decision === "page" ? "page" : "session");
    }
    this.host.audit?.({ id: proposal.id, digest: proposal.digest, kind: proposal.kind, operation: proposal.operation, approver, decision: "allow", reason, model: approver === "reviewer" ? this.delegation?.model : undefined, elapsedMs: Date.now() - started });
    return proposal;
  }
  /**
   * Authorize one or more research URLs with a single human decision.
   *
   * Batching is the point: a ten-URL access request used to open ten cards in series, each
   * blocking the next, which is one authorization decided ten times. Denied hosts still win
   * outright, and URLs already covered by policy never raise a card — so a card that does
   * appear only ever lists what genuinely needs a new grant.
   *
   * Returns the approved proposal when one was raised, so a caller that attached `fields` can
   * read the human's exact (possibly corrected) values back out of it.
   */
  async access(raw: string | readonly string[], purpose: string, signal?: AbortSignal, options: AccessOptions = {}): Promise<BrowserProposal | undefined> {
    const urls = (Array.isArray(raw) ? [...raw] : [raw as string]).map(value => researchUrl(String(value)));
    if (!urls.length) throw new BrowserPolicyError("denied", "No research URL was supplied to authorize.");
    // Name every denied host at once: a batch that fails one URL at a time teaches the agent
    // nothing about the rest, and it retries into the same wall.
    const denied = [...new Set(urls.filter(url => this.policy.status(url.href) === "deny").map(url => url.hostname))];
    if (denied.length) throw new BrowserPolicyError("denied", `Research access denied for ${denied.join(", ")}. Retry without ${denied.length > 1 ? "these hosts" : "this host"}.`);
    const ask = urls.filter(url => this.policy.status(url.href) !== "allow");
    if (!ask.length) return undefined;
    // Named and granted by registrable domain, so the card states the decision the human is
    // actually making — "wikipedia.org", covering every article and language subdomain — and
    // ten Wikipedia URLs collapse into one line rather than ten.
    const domains = [...new Set(ask.map(url => baseDomain(url.hostname)))];
    const first = ask[0]!;
    // Domain UI uses redacted display URLs; the exact URLs stay host-owned.
    return this.approve({
      kind: "domain", operation: "read", origin: first.origin, url: first.href, urls: ask.map(url => url.href), domains,
      title: domains.length > 1 ? `${domains.length} domains` : domains[0]!, document: "",
      purpose: `${purpose}\n${ask.map(url => redactedUrl(url.href)).join("\n")}`,
      fields: options.fields ?? [],
      ...(options.anchor ? { anchor: options.anchor } : {}),
    }, signal);
  }
}
