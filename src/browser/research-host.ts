import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { BrowserApprovalCoordinator } from "./approval-coordinator.js";
import { BrowserPolicyError, type BrowserAnchor, type BrowserAudit, type BrowserDecision, type BrowserDelegation, type BrowserProposal, type ResearchUiState } from "./approval-types.js";
import { DomainPolicy, EMPTY_POLICY, normalizeDomain, normalizePolicy, redactedUrl, type ResearchPolicy } from "./domain-policy.js";
import { ResearchService } from "./research-service.js";
import type { ContinuationModel } from "../continuation/continuation-model.js";

/**
 * Raised when a proposal opens and again when it settles, so the chat surface can show the
 * wait as the blocked tool call's own approval gate — the same treatment every other gated
 * tool gets — instead of a panel floating outside the transcript. Carries no field values:
 * exact values stay on the ephemeral research channel and never enter the transcript.
 */
export interface BrowserGateEvent {
  proposalId: string;
  anchor: BrowserAnchor;
  open: boolean;
  /** The human's decision on a gate that closed with one. Absent when it closed without. */
  decision?: BrowserDecision["decision"];
  /** Present when a closed gate should say why it stopped waiting (expired, revoked). */
  reason?: string;
}

/** Mirrors the 5-minute freshness window the coordinator stamps onto every proposal. */
const APPROVAL_WINDOW_MS = 300_000;
/* Modal labels are the same words the in-chat card uses, so the fallback is not a second
   vocabulary the user has to learn for the same four decisions. */
const ALLOW_SESSION = "Allow this session";
const ALLOW_ONCE = "Just this page";
const ALWAYS_PROJECT = "Always: this project";
const ALWAYS_EVERYWHERE = "Always: all projects";
const APPROVE = "Approve exact values";
const EDIT = "Edit and approve";
const DENY = "Deny";
function modalTitle(proposal: BrowserProposal): string {
  const hosts = new Set(proposal.domains?.length ? proposal.domains : (proposal.urls ?? [proposal.url]).map(url => { try { return new URL(url).hostname; } catch { return proposal.title; } }));
  if (proposal.kind === "domain") return hosts.size > 1 ? `Allow research access to ${hosts.size} domains?` : `Allow research access to ${[...hosts][0]}?`;
  if (proposal.kind === "script") return `Run a privileged test script on ${proposal.origin}?`;
  if (proposal.kind === "input") return `Send these exact values to ${proposal.origin}?`;
  return `Approve a browser action on ${proposal.origin}?`;
}

/** All persistent widening is attested in SecretStorage through this trusted UI handler. */
export class ResearchHost {
  readonly policy = new DomainPolicy();
  readonly coordinator: BrowserApprovalCoordinator;
  readonly service: ResearchService;
  private pending = new Map<string, { proposal: BrowserProposal; resolve: (d: BrowserDecision, reason?: string) => void }>();
  private audits: BrowserAudit[] = [];
  private delegation?: BrowserDelegation;
  private disposed = false;
  private saving = false;
  private readonly attestation: string;
  private ready: Promise<void>;
  private configSubscription: vscode.Disposable;
  constructor(private context: vscode.ExtensionContext, workspace: string, private post: (message: unknown) => void, private visible: () => boolean, reviewer: ContinuationModel, private onRevoke?: () => void, private onGate?: (event: BrowserGateEvent) => void) {
    this.attestation = `research.policy.${createHash("sha256").update(workspace).digest("hex")}`;
    this.coordinator = new BrowserApprovalCoordinator(this.policy, {
      ask: (p, signal) => this.ask(p, signal),
      persistDomains: async (domains, scope) => { const policy = structuredClone(this.policy.settings); policy.allowedDomains.push(...domains); await this.save(policy, scope); },
      audit: event => { this.audits = [...this.audits.slice(-99), event]; void this.send(); },
      reviewer,
    });
    this.service = new ResearchService(this.coordinator, async () => context.secrets.get("blacksite.research.braveKey"));
    this.ready = this.refresh();
    this.configSubscription = vscode.workspace.onDidChangeConfiguration(e => {
      if (!this.saving && e.affectsConfiguration("blacksite.research")) {
        this.reset();
        this.ready = this.ready.then(() => this.refresh());
      }
    });
  }
  private configured(): ResearchPolicy {
    const c = vscode.workspace.getConfiguration("blacksite");
    return normalizePolicy({ allowedDomains: c.get<string[]>("research.allowedDomains", []), deniedDomains: c.get<string[]>("research.deniedDomains", []), unknownDomainPolicy: c.get<"ask" | "deny">("research.unknownDomainPolicy", "ask"), searchProvider: c.get<"none" | "brave">("research.searchProvider", "none") });
  }
  private async refresh(): Promise<void> {
    try {
      const configured = this.configured();
      const saved = await this.context.secrets.get(this.attestation);
      const trusted = saved ? normalizePolicy(JSON.parse(saved) as ResearchPolicy) : EMPTY_POLICY;
      // Settings-file edits can restrict access immediately, but cannot widen it.
      const effective = { ...configured, allowedDomains: configured.allowedDomains.filter(d => trusted.allowedDomains.includes(d)), deniedDomains: [...new Set([...configured.deniedDomains, ...trusted.deniedDomains])], searchProvider: trusted.searchProvider === configured.searchProvider ? configured.searchProvider : "none" as const };
      this.policy.replace(effective);
      // Remember revocations too: removing a deny or restoring a removed allow in a
      // settings file must never reactivate a historical human grant.
      await this.context.secrets.store(this.attestation, JSON.stringify(effective));
    } catch { this.policy.replace({ ...EMPTY_POLICY, unknownDomainPolicy: "deny" }); }
  }
  private async save(policy: ResearchPolicy, scope: "workspace" | "global"): Promise<void> {
    const normalized = normalizePolicy(policy);
    this.reset();
    const c = vscode.workspace.getConfiguration("blacksite");
    this.saving = true;
    try {
      for (const [key, value] of Object.entries(normalized)) await c.update(`research.${key}`, value, scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
      await this.context.secrets.store(this.attestation, JSON.stringify(normalized));
      await this.refresh();
    } finally { this.saving = false; }
  }
  async dispatch(action: string, payload: Record<string, unknown>, signal?: AbortSignal, anchor?: BrowserAnchor): Promise<unknown> { await this.ready; return this.service.dispatch(action, payload, signal, anchor); }
  async handle(message: Record<string, unknown>): Promise<void> {
    await this.ready;
    try {
      if (message.type === "browser_decision") {
        const d = message.decision as BrowserDecision;
        if (d && typeof d.id === "string") this.pending.get(d.id)?.resolve(d);
      } else if (message.type === "research_save") {
        if (message.clearKey !== true) await this.save(message.policy as ResearchPolicy, message.scope === "global" ? "global" : "workspace");
        if (typeof message.key === "string" && message.key) await this.context.secrets.store("blacksite.research.braveKey", message.key);
        if (message.clearKey === true) await this.context.secrets.delete("blacksite.research.braveKey");
      } else if (message.type === "research_mode") {
        if (message.mode !== "human" && message.mode !== "reviewer") throw new Error("Invalid browser input review preference.");
        if (message.mode === "human") { this.delegation = undefined; this.coordinator.delegate(); }
        await vscode.workspace.getConfiguration("blacksite").update("browser.inputApprovalMode", message.mode, vscode.ConfigurationTarget.Workspace);
      } else if (message.type === "research_delegate") {
        const d = message.delegation as BrowserDelegation;
        if (!d || !d.intent?.trim() || !d.model?.trim() || !Array.isArray(d.domains) || !Array.isArray(d.operations) || d.operations.some(o => !["search", "fill"].includes(o))) throw new Error("Delegation needs your task, reviewer model, explicit domains and operation classes.");
        const isLocal = (domain: string) => ["localhost", "127.0.0.1", "[::1]"].includes(domain);
        const domains = d.domains.map(domain => isLocal(domain) ? domain : normalizeDomain(domain));
        if (!domains.length || domains.some(domain => !isLocal(domain) && domain !== "api.search.brave.com" && this.policy.status(`https://${domain}/`) !== "allow")) throw new Error("Delegate only approved domains or explicit local testing hosts. Brave query review may include api.search.brave.com.");
        this.delegation = { ...d, domains };
        this.coordinator.delegate(this.delegation);
      } else if (message.type === "research_revoke") this.reset();
      await this.send();
    } catch (e) { await this.send(e instanceof Error ? e.message : "Invalid research settings."); }
  }
  get reviewerModel(): string | undefined { return this.delegation?.model; }
  async send(error?: string): Promise<void> {
    if (this.disposed) return;
    let configured = EMPTY_POLICY;
    try { configured = this.configured(); } catch { /* fail closed; expose settings validation error */ }
    const preference = vscode.workspace.getConfiguration("blacksite").get<string>("browser.inputApprovalMode", "human");
    const state: ResearchUiState = { policy: this.policy.settings, configured, delegation: this.delegation, inputApprovalPreference: preference === "reviewer" ? "reviewer" : "human", keyConfigured: !!await this.context.secrets.get("blacksite.research.braveKey"), pending: [...this.pending.values()].map(p => p.proposal), audits: this.audits, error };
    this.post({ type: "research_state", state });
  }
  private async ask(proposal: BrowserProposal, signal?: AbortSignal): Promise<BrowserDecision> {
    if (this.disposed || signal?.aborted) throw new BrowserPolicyError("cancelled", "Browser approval cancelled.");
    const display = { ...proposal, url: redactedUrl(proposal.url), ...(proposal.urls ? { urls: proposal.urls.map(redactedUrl) } : {}) };
    return new Promise<BrowserDecision>((resolve, reject) => {
      const finish = (decision?: BrowserDecision, reason?: string) => {
        if (!this.pending.delete(proposal.id)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (proposal.anchor) this.onGate?.({ proposalId: proposal.id, anchor: proposal.anchor, open: false, ...(decision ? { decision: decision.decision } : {}), ...(reason ? { reason } : {}) });
        if (decision) resolve(decision); else reject(new BrowserPolicyError("cancelled", reason ?? "Browser approval cancelled or expired."));
        void this.send();
      };
      const abort = () => finish();
      // An unanswered proposal expires rather than authorizing stale work later. Saying so is
      // the difference between a card that silently vanishes and one the user can act on again.
      const expire = () => finish(undefined, `This browser approval expired after ${Math.round(APPROVAL_WINDOW_MS / 60_000)} minutes without a decision. Nothing was sent. Ask again to retry.`);
      this.pending.set(proposal.id, { proposal: display, resolve: finish });
      const timer = setTimeout(expire, Math.max(1, proposal.expiresAt - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      if (proposal.anchor) this.onGate?.({ proposalId: proposal.id, anchor: proposal.anchor, open: true });
      void this.send();
      if (!this.visible()) {
        // Fallback for a hidden chat view. Same decisions, same words as the in-chat card, and
        // the values as readable lines rather than a JSON dump nobody can check at a glance.
        const options = proposal.kind === "domain" ? [ALLOW_SESSION, ALLOW_ONCE, ALWAYS_PROJECT, ALWAYS_EVERYWHERE, DENY] : proposal.kind === "input" ? [APPROVE, EDIT, DENY] : [APPROVE, DENY];
        const values = display.fields.map(f => `${f.label} (${f.type}): ${JSON.stringify(f.value)}`).join("\n");
        const targets = (display.urls ?? [display.url]).join("\n");
        void (async () => {
          const choice = await vscode.window.showWarningMessage(modalTitle(proposal), { modal: true, detail: [display.purpose, targets, values].filter(Boolean).join("\n\n") }, ...options);
          if (choice === EDIT) {
            const raw = await vscode.window.showInputBox({ title: "Edit exact values and approve entry", prompt: "JSON array in field order. Press Enter to approve these complete values for this destination.", value: JSON.stringify(display.fields.map(f => f.value)), validateInput: value => {
              try { const edited = JSON.parse(value); return Array.isArray(edited) && edited.length === display.fields.length && edited.every((v, i) => typeof v === typeof display.fields[i]!.value) ? undefined : "Keep the same field count and value types."; } catch { return "Enter a JSON array."; }
            } });
            finish({ id: proposal.id, decision: raw === undefined ? "deny" : "edit", ...(raw !== undefined ? { values: JSON.parse(raw) as Array<string | boolean> } : {}) });
          } else finish({ id: proposal.id, decision: choice === ALLOW_ONCE ? "page" : choice === ALLOW_SESSION ? "session" : choice === ALWAYS_PROJECT ? "workspace" : choice === ALWAYS_EVERYWHERE ? "global" : choice === APPROVE ? "allow" : "deny" });
        })().catch(() => finish());
      }
    });
  }
  reset(): void {
    for (const [id, p] of this.pending) p.resolve({ id, decision: "deny" }, "Browser authorization was revoked before this request was answered. Nothing was sent.");
    this.delegation = undefined;
    this.coordinator.reset();
    this.onRevoke?.();
  }
  dispose(): void { this.disposed = true; this.reset(); this.configSubscription.dispose(); }
}
