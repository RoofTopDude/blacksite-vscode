import { createHash, randomUUID } from "node:crypto";
import type { ContinuationModel } from "../continuation/continuation-model.js";
import { BrowserPolicyError, cancelled, type BrowserAudit, type BrowserDecision, type BrowserDelegation, type BrowserProposal } from "./approval-types.js";
import { DomainPolicy, redactedUrl, researchUrl } from "./domain-policy.js";
import { reviewInput, withinDelegation } from "./input-reviewer.js";

export type ProposalInput = Omit<BrowserProposal, "id" | "digest" | "session" | "version" | "expiresAt">;
export interface BrowserApprovalHost {
  ask(proposal: BrowserProposal, signal?: AbortSignal): Promise<BrowserDecision>;
  persistDomain?(domain: string, scope: "workspace" | "global"): Promise<void>;
  audit?(event: BrowserAudit): void;
  reviewer?: ContinuationModel;
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
    if (decision.decision === "edit") {
      if (!decision.values || decision.values.length !== proposal.fields.length || decision.values.some((v, i) => typeof v !== typeof proposal.fields[i]!.value)) throw new BrowserPolicyError("denied", "Edited values do not match the proposal fields.");
      proposal = this.proposal({ ...input, fields: input.fields.map((f, i) => ({ ...f, value: decision.values![i]! })) });
    }
    if (proposal.kind === "domain") {
      if (decision.decision === "workspace" || decision.decision === "global") {
        if (!this.host.persistDomain) throw new BrowserPolicyError("approval_required", "Permanent domain approval is unavailable.");
        await this.host.persistDomain(researchUrl(input.url).hostname, decision.decision);
      }
      this.policy.grant(input.url, decision.decision === "page" ? "page" : "session");
    }
    this.host.audit?.({ id: proposal.id, digest: proposal.digest, kind: proposal.kind, operation: proposal.operation, approver, decision: "allow", reason, model: approver === "reviewer" ? this.delegation?.model : undefined, elapsedMs: Date.now() - started });
    return proposal;
  }
  async access(raw: string, purpose: string, signal?: AbortSignal): Promise<void> {
    const url = researchUrl(raw);
    const status = this.policy.status(url.href);
    if (status === "deny") throw new BrowserPolicyError("denied", `Research access denied for ${url.hostname}.`);
    if (status === "allow") return;
    // Domain UI uses a redacted display URL; the exact URL stays host-owned.
    await this.approve({ kind: "domain", operation: "read", origin: url.origin, url: url.href, title: url.hostname, document: "", purpose: `${purpose}\n${redactedUrl(url.href)}`, fields: [] }, signal);
  }
}
