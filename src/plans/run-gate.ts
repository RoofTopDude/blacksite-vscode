/**
 * What a working plan run settles about a gated call before a model or a person is asked.
 *
 * Two of the user's own decisions come first, in order: an answer they already gave to this exact
 * call from the run's queue (good for one repeat), then the permissions they ticked when they
 * started the run. Only after those does the approval mode apply.
 *
 * And one floor: once the conversation has read content someone else wrote — a web page, an MCP
 * result, an issue — no model approves a network operation for an unattended run. That is the
 * shape of an injected instruction exfiltrating data or pulling in code, and the person is the
 * only reviewer who cannot be talked into it by the content itself.
 *
 * Pure: the host passes in the rules and a way to use up a one-shot approval.
 */

import type { ApprovalCategory } from "../approval-scope.js";
import { describeUntrustedSources } from "../continuation/approval-review.js";
import { approvalFingerprint } from "../gate-deferral.js";
import { envelopeCovers, type RunPermission } from "./run-envelope.js";

export interface RunGateRequest {
  toolName: string;
  category: ApprovalCategory;
  tier: string;
  description: string;
  input: Record<string, unknown>;
  unrecognizedCommand?: boolean;
  untrustedSources?: string[];
}

export interface RunGateRules {
  allow: readonly RunPermission[];
  runBranch?: string;
  /** Use up the one-shot approval for this call, returning the decision it came from. */
  takePreapproval(fingerprint: string): string | undefined;
}

export interface RunGateAllowed {
  action: "allow";
  by: "earlier_answer" | "charter";
  /** Shown on the tool row. */
  reason: string;
  /** Kept in the run's record of what ran without asking. */
  record: string;
}

export function settleRunGate(request: RunGateRequest, rules: RunGateRules): RunGateAllowed | undefined {
  const earlier = rules.takePreapproval(approvalFingerprint(request.toolName, request.description));
  if (earlier) return { action: "allow", by: "earlier_answer", reason: `You approved this earlier (${earlier}).`, record: `You approved this as ${earlier}.` };
  const charter = envelopeCovers(request, { allow: rules.allow, runBranch: rules.runBranch });
  if (charter.covered) return { action: "allow", by: "charter", reason: `Allowed by the run's charter: ${charter.reason}.`, record: charter.reason };
  return undefined;
}

export function untrustedNetworkFloor(request: Pick<RunGateRequest, "tier" | "category" | "untrustedSources">): { action: "escalate"; reason: string } | undefined {
  const untrusted = request.untrustedSources ?? [];
  if (untrusted.length === 0 || (request.tier !== "network" && request.category !== "mcp")) return undefined;
  return {
    action: "escalate",
    reason: `This run has read ${describeUntrustedSources(untrusted)}, so network operations wait for you instead of the reviewer.`,
  };
}
