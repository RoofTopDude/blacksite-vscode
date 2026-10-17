/**
 * Draft builders for the exchange kinds the store accepts. Each returns a draft for `put`; none
 * writes anything, and none reads a store.
 */

import type { Ticket } from "../../ticket-store.js";
import type { VerificationResult } from "../verification-lane.js";
import type { WorkReceipt } from "../work-receipt.js";
import {
  ARTIFACT_EXCHANGE_SCHEMA, revisionOf, type ArtifactAccess, type ArtifactSource, type ExchangeDraft,
} from "./model.js";

/**
 * The part of a ticket that work relies on: what it asks for and where. Its status, notes and
 * timestamps change constantly without changing the request, so pinning the whole ticket would
 * make every record stale within the hour. Producers and the resolver must both use this.
 */
export function ticketRevision(ticket: Pick<Ticket, "id" | "title" | "description" | "acceptanceCriteria" | "territory">): string {
  return revisionOf({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description ?? "",
    acceptanceCriteria: ticket.acceptanceCriteria,
    territory: ticket.territory,
  });
}

/** A WorkReceipt pinned by its snapshot. Receipts are immutable, so this never goes stale by itself. */
export function workReceiptSource(receipt: WorkReceipt): ArtifactSource {
  return { kind: "work_receipt", id: receipt.id, revision: revisionOf(receipt) };
}

/**
 * A change receipt is a short handoff that points at a WorkReceipt the host already wrote. It copies
 * neither the file list nor the check output, and it never uses the lane's own account of its work,
 * which lives only in the receipt's `selfReport`.
 */
export function changeReceiptDraft(
  receipt: WorkReceipt,
  access: ArtifactAccess,
  extraSources: readonly ArtifactSource[] = [],
): ExchangeDraft {
  const changed = receipt.observed.filesChanged.length;
  const status = receipt.status.replace(/_/g, " ");
  const verification = receipt.verification.result.replace(/_/g, " ");
  return {
    schemaVersion: ARTIFACT_EXCHANGE_SCHEMA,
    kind: "change_receipt",
    access,
    sources: [workReceiptSource(receipt), ...extraSources],
    payload: {
      summary: `${status}: ${changed} file(s) changed; verification ${verification}.`,
      workReceiptId: receipt.id,
    },
  };
}

/** The verification lane's verdict, pinned to the receipt it judged (#18). */
export function verificationReceiptDraft(
  result: Pick<VerificationResult, "verdict" | "reasons">,
  receipt: WorkReceipt,
  access: ArtifactAccess,
  extraSources: readonly ArtifactSource[] = [],
): ExchangeDraft {
  return {
    schemaVersion: ARTIFACT_EXCHANGE_SCHEMA,
    kind: "verification_receipt",
    access,
    sources: [workReceiptSource(receipt), ...extraSources],
    payload: {
      verdict: result.verdict,
      reasons: result.reasons.slice(0, 8).map((reason) => reason.slice(0, 300)),
      workReceiptId: receipt.id,
    },
  };
}
