/** Serializable, transient host/webview contract. Never persist exact proposals. */
export interface ResearchPolicy {
  allowedDomains: string[];
  deniedDomains: string[];
  unknownDomainPolicy: "ask" | "deny";
  searchProvider: "none" | "brave";
}
export interface ResearchUiState {
  policy: ResearchPolicy;
  configured: ResearchPolicy;
  delegation?: BrowserDelegation;
  keyConfigured: boolean;
  inputApprovalPreference?: "human" | "reviewer";
  audits: BrowserAudit[];
  pending: BrowserProposal[];
  error?: string;
}
export interface BrowserField {
  target: string;
  label: string;
  type: string;
  mode: "replace" | "append";
  value: string | boolean;
}
export interface BrowserProposal {
  id: string;
  digest: string;
  session: string;
  version: number;
  expiresAt: number;
  kind: "domain" | "input" | "action" | "script";
  operation: string;
  origin: string;
  url: string;
  title: string;
  document: string;
  purpose: string;
  fields: BrowserField[];
}
export interface BrowserDecision {
  id: string;
  decision: "allow" | "deny" | "edit" | "page" | "session" | "workspace" | "global";
  values?: Array<string | boolean>;
}
export interface BrowserDelegation {
  intent: string;
  domains: string[];
  operations: Array<"search" | "fill">;
  model: string;
}
export interface BrowserAudit {
  id: string;
  digest: string;
  kind: BrowserProposal["kind"];
  operation: string;
  approver: "human" | "reviewer";
  decision: string;
  reason: string;
  model?: string;
  elapsedMs: number;
}
export class BrowserPolicyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserPolicyError("cancelled", "Browser operation cancelled.");
}
/** Works on supported extension hosts that predate AbortSignal.any; releases listeners. */
export async function withSignals<T>(signals: Array<AbortSignal | undefined>, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }
  try { cancelled(controller.signal); return await operation(controller.signal); }
  finally { for (const signal of signals) signal?.removeEventListener("abort", abort); }
}
