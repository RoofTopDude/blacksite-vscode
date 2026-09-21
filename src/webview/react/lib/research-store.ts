import { useSyncExternalStore } from "react";
import { onMessage, post } from "./bridge";
import { nextPendingSeq, type BrowserGate } from "./chat-model";
import type { ResearchUiState } from "../../../browser/approval-types";

const empty = { allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask" as const, searchProvider: "none" as const };
let state: ResearchUiState = { policy: empty, configured: empty, keyConfigured: false, audits: [], pending: [] };
let gates: BrowserGate[] = [];
/** Arrival order per proposal id, so re-sending the same pending set (every audit entry and
 *  every settings save re-broadcasts it) does not keep re-dating a card the user is reading. */
const arrivals = new Map<string, number>();
const listeners = new Set<() => void>();
onMessage(message => {
  if (message.type !== "research_state" || !message.state) return;
  state = message.state as ResearchUiState;
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const live = new Set(pending.map(proposal => proposal.id));
  for (const id of [...arrivals.keys()]) if (!live.has(id)) arrivals.delete(id);
  // Stamped from the same clock the transcript's gates use, so a web approval queues in the
  // docked action bar by when it actually arrived rather than always at one end.
  gates = pending.map(proposal => {
    let pendingSeq = arrivals.get(proposal.id);
    if (pendingSeq === undefined) arrivals.set(proposal.id, pendingSeq = nextPendingSeq());
    return { proposal, pendingSeq };
  });
  for (const listener of listeners) listener();
});
function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
/** Ephemeral only: never write exact approval values to VS Code webview state. */
export function useResearch() {
  return useSyncExternalStore(subscribe, () => state);
}
/** Just the proposals awaiting a human, for the shared pending queue. */
export function useBrowserGates(): BrowserGate[] {
  return useSyncExternalStore(subscribe, () => gates);
}
export function requestResearchState(): void { post({ type: "research_get" }); }
