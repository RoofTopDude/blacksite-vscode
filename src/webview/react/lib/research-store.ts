import { useSyncExternalStore } from "react";
import { onMessage, post } from "./bridge";
import type { ResearchUiState } from "../../../browser/approval-types";

const empty = { allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask" as const, searchProvider: "none" as const };
let state: ResearchUiState = { policy: empty, configured: empty, keyConfigured: false, audits: [], pending: [] };
const listeners = new Set<() => void>();
onMessage(message => {
  if (message.type !== "research_state" || !message.state) return;
  state = message.state as ResearchUiState;
  for (const listener of listeners) listener();
});
/** Ephemeral only: never write exact approval values to VS Code webview state. */
export function useResearch() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => state);
}
export function requestResearchState(): void { post({ type: "research_get" }); }
