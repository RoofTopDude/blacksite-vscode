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
/** Where in the transcript a proposal came from, so the approval can be presented as the
 *  blocked tool call's own gate instead of an unattached panel. Absent for proposals raised
 *  outside a tool call (or by a runner that does not thread its call id). */
export interface BrowserAnchor {
  toolCallId: string;
  toolName: string;
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
  /** Domain proposals may cover several URLs at once so one human decision can answer a
   *  batched access request instead of one card per URL. `url` stays the first entry. */
  urls?: string[];
  /** The registrable domains this card would actually grant ("wikipedia.org", not
   *  "en.wikipedia.org"). Computed host-side so the approval UI states the true scope of the
   *  decision without having to carry a public-suffix list into the webview bundle. */
  domains?: string[];
  anchor?: BrowserAnchor;
}
export interface BrowserDecision {
  id: string;
  decision: "allow" | "deny" | "edit" | "page" | "session" | "workspace" | "global";
  /** Human-corrected field values. Valid on an "edit" decision and on a domain decision
   *  whose card also carried exact values to review (a read that needs both a grant and a
   *  query review is one card, not two). */
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
