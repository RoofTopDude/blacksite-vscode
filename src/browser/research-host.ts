import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { BrowserApprovalCoordinator } from "./approval-coordinator.js";
import { BrowserPolicyError, type BrowserAudit, type BrowserDecision, type BrowserDelegation, type BrowserProposal, type ResearchUiState } from "./approval-types.js";
import { DomainPolicy, EMPTY_POLICY, normalizeDomain, normalizePolicy, redactedUrl, type ResearchPolicy } from "./domain-policy.js";
import { ResearchService } from "./research-service.js";
import type { ContinuationModel } from "../continuation/continuation-model.js";

/** All persistent widening is attested in SecretStorage through this trusted UI handler. */
export class ResearchHost {
  readonly policy = new DomainPolicy();
  readonly coordinator: BrowserApprovalCoordinator;
  readonly service: ResearchService;
  private pending = new Map<string, { proposal: BrowserProposal; resolve: (d: BrowserDecision) => void }>();
  private audits: BrowserAudit[] = [];
  private delegation?: BrowserDelegation;
  private disposed = false;
  private saving = false;
  private readonly attestation: string;
  private ready: Promise<void>;
  private configSubscription: vscode.Disposable;
  constructor(private context: vscode.ExtensionContext, workspace: string, private post: (message: unknown) => void, private visible: () => boolean, reviewer: ContinuationModel, private onRevoke?: () => void) {
    this.attestation = `research.policy.${createHash("sha256").update(workspace).digest("hex")}`;
    this.coordinator = new BrowserApprovalCoordinator(this.policy, {
      ask: (p, signal) => this.ask(p, signal),
      persistDomain: async (domain, scope) => { const policy = structuredClone(this.policy.settings); policy.allowedDomains.push(domain); await this.save(policy, scope); },
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
  async dispatch(action: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> { await this.ready; return this.service.dispatch(action, payload, signal); }
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
    const display = { ...proposal, url: redactedUrl(proposal.url) };
    return new Promise<BrowserDecision>((resolve, reject) => {
      const finish = (decision?: BrowserDecision) => {
        if (!this.pending.delete(proposal.id)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (decision) resolve(decision); else reject(new BrowserPolicyError("cancelled", "Browser approval cancelled or expired."));
        void this.send();
      };
      const abort = () => finish();
      this.pending.set(proposal.id, { proposal: display, resolve: decision => finish(decision) });
      const timer = setTimeout(abort, Math.max(1, proposal.expiresAt - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      void this.send();
      if (!this.visible()) {
        const options = proposal.kind === "domain" ? ["Allow page once", "Allow domain this session", "Always in workspace", "Always for user", "Deny"] : proposal.kind === "input" ? ["Approve exact proposal", "Edit and approve", "Deny"] : ["Approve exact proposal", "Deny"];
        void (async () => {
          const choice = await vscode.window.showWarningMessage("Blacksite browser approval", { modal: true, detail: `${display.origin}\n${display.title}\n${display.purpose}\n\n${JSON.stringify(display.fields, null, 2)}` }, ...options);
          if (choice === "Edit and approve") {
            const raw = await vscode.window.showInputBox({ title: "Edit exact values and approve entry", prompt: "JSON array in field order. Press Enter to approve these complete values for this destination.", value: JSON.stringify(display.fields.map(f => f.value)), validateInput: value => {
              try { const edited = JSON.parse(value); return Array.isArray(edited) && edited.length === display.fields.length && edited.every((v, i) => typeof v === typeof display.fields[i]!.value) ? undefined : "Keep the same field count and value types."; } catch { return "Enter a JSON array."; }
            } });
            finish({ id: proposal.id, decision: raw === undefined ? "deny" : "edit", ...(raw !== undefined ? { values: JSON.parse(raw) as Array<string | boolean> } : {}) });
          } else finish({ id: proposal.id, decision: choice === "Allow page once" ? "page" : choice === "Allow domain this session" ? "session" : choice === "Always in workspace" ? "workspace" : choice === "Always for user" ? "global" : choice === "Approve exact proposal" ? "allow" : "deny" });
        })().catch(() => finish());
      }
    });
  }
  reset(): void {
    for (const [id, p] of this.pending) p.resolve({ id, decision: "deny" });
    this.delegation = undefined;
    this.coordinator.reset();
    this.onRevoke?.();
  }
  dispose(): void { this.disposed = true; this.reset(); this.configSubscription.dispose(); }
}
