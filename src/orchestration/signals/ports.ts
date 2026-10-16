/**
 * The host side of what signals may do: the only effects consumers can have, implemented over the
 * loop store, the loop supervisor, the plan run and the attention center.
 *
 * Note what is missing: nothing here starts, resumes or creates a loop, creates a ticket, closes
 * one, or touches a ceiling, an approval or a contract. A loop that could continue is *offered*
 * to the user, and the offer is withdrawn when it stops being true (plan D4, D5).
 *
 * No vscode import: the stores and surfaces are passed in through narrow interfaces.
 */

import type { AttentionItem } from "../../chat/attention.js";
import type { LoopReassessment, LoopRecord, LoopResumeOffer } from "../../loops/loop-model.js";
import type { ReassessmentEntry } from "./consumers.js";
import type { SignalPorts } from "./service.js";

export interface SignalPortDeps {
  loops: {
    get(loopId: string): LoopRecord | undefined;
    setResumeOffer(loopId: string, offer: LoopResumeOffer | undefined): LoopRecord | undefined;
    addReassessment(loopId: string, entry: LoopReassessment): void;
  };
  supervisor: { wake(loopId: string): void };
  attention?: () => { raise(item: AttentionItem): boolean; resolve(id: string): void } | undefined;
  planRuns?: () => { noteReassessment(runId: string, entry: Omit<ReassessmentEntry, "at">): void } | undefined;
  /** Leave a note on an open ticket, once per signal. The host checks both conditions. */
  noteTicket(ticketId: string, signalId: string, text: string): void;
  now?: () => number;
}

export function canContinueAttentionId(loopId: string): string {
  return `loop:${loopId}:can_continue`;
}

export function reassessAttentionId(loopId: string): string {
  return `loop:${loopId}:reassess`;
}

export function createSignalPorts(deps: SignalPortDeps): SignalPorts {
  const now = deps.now ?? (() => Date.now());
  return {
    wakeLoop(loopId) {
      deps.supervisor.wake(loopId);
    },
    offerResume(loopId, offer) {
      const record = deps.loops.setResumeOffer(loopId, { at: new Date(now()).toISOString(), ready: offer.ready, because: offer.because, signalIds: offer.signalIds });
      if (!record?.resumeOffer) return;
      deps.attention?.()?.raise({
        id: canContinueAttentionId(loopId),
        kind: "loop_can_continue",
        severity: "needs_you",
        source: "loop",
        title: `Loop “${record.definition.title}” can continue`,
        detail: `${offer.because} Resume it from the Loops view when you are ready; it will not restart by itself.`.slice(0, 400),
        at: now(),
      });
    },
    withdrawOffer(loopId) {
      deps.loops.setResumeOffer(loopId, undefined);
      deps.attention?.()?.resolve(canContinueAttentionId(loopId));
    },
    flag(target, entry) {
      if (target.planRunId) {
        const { at: _at, ...rest } = entry;
        deps.planRuns?.()?.noteReassessment(target.planRunId, rest);
      }
      if (target.loopId) {
        deps.loops.addReassessment(target.loopId, { ...entry });
        const record = deps.loops.get(target.loopId);
        if (!record) return;
        const count = record.reassessments?.length ?? 1;
        deps.attention?.()?.raise({
          id: reassessAttentionId(target.loopId),
          kind: "loop_reassess",
          severity: "info",
          source: "loop",
          title: `Loop “${record.definition.title}”: ${count} thing${count === 1 ? "" : "s"} to look at`,
          detail: entry.detail.slice(0, 300),
          at: now(),
        });
      }
    },
    noteTicket(ticketId, signalId, text) {
      deps.noteTicket(ticketId, signalId, text);
    },
  };
}

/** The marker a signal's note carries, so the same signal never notes a ticket twice. */
export function signalNoteMarker(signalId: string): string {
  return `(signal ${signalId})`;
}
