/**
 * The artifact exchange as the extension uses it (#17).
 *
 *  - Producers: every lane receipt becomes a change receipt, and every verification lane verdict a
 *    verification receipt, each pinned to the WorkReceipt it describes and the ticket it served.
 *  - A resolver that judges freshness against the real stores: receipts, tickets and files.
 *  - The packet a delegated lane is given: prior work on the same tickets or plan, by reference,
 *    bounded in size, with stale items marked. The lane gets IDs and one-line summaries, never
 *    another lane's transcript.
 *
 * Every entry point checks the flag. With it off nothing is read or written, and the lane prompt
 * is exactly what it was. All writes are workspace-scoped and made by the host, never by a model.
 */

import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "node:path";
import type { Ticket } from "../../ticket-store.js";
import type { VerificationResult } from "../verification-lane.js";
import type { WorkReceipt } from "../work-receipt.js";
import type { SourceResolver } from "./freshness.js";
import { revisionOf, type ArtifactActor, type ArtifactSource, type ExchangeRecord } from "./model.js";
import { buildArtifactPacket, type ArtifactPacket } from "./packet.js";
import { changeReceiptDraft, ticketRevision, verificationReceiptDraft } from "./producers.js";
import { ArtifactExchangeStore } from "./store.js";

export interface ExchangeHostPorts {
  workspaceRoot: string;
  /** The `blacksite.orchestration.artifactExchange` flag, read on every call. */
  enabled: () => boolean;
  receipt(id: string): WorkReceipt | undefined;
  ticket(id: string): Ticket | undefined;
}

const HOST: ArtifactActor = { kind: "host" };
const MAX_HASHED_BYTES = 2 * 1024 * 1024;
const PACKET_RECORDS = 50;

export class ExchangeHost {
  readonly store: ArtifactExchangeStore;

  constructor(private readonly _ports: ExchangeHostPorts) {
    this.store = new ArtifactExchangeStore(_ports.workspaceRoot, { enabled: _ports.enabled });
  }

  /**
   * Freshness against the stores the host owns. A source kind it cannot resolve (a plan step, a
   * map node) is reported missing, so a record that rests on it is never counted as fresh.
   */
  resolver(): SourceResolver {
    const root = path.resolve(this._ports.workspaceRoot);
    return (source) => {
      if (source.kind === "work_receipt") {
        const receipt = this._ports.receipt(source.id);
        return receipt ? { state: "current", revision: revisionOf(receipt) } : { state: "missing" };
      }
      if (source.kind === "ticket") {
        const ticket = this._ports.ticket(source.id);
        return ticket ? { state: "current", revision: ticketRevision(ticket) } : { state: "missing" };
      }
      if (source.kind === "file") {
        const absolute = path.resolve(root, source.id);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return { state: "denied" };
        try {
          const stat = fs.statSync(absolute);
          if (!stat.isFile() || stat.size > MAX_HASHED_BYTES) return { state: "missing" };
          return { state: "current", revision: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") };
        } catch {
          return { state: "missing" };
        }
      }
      return { state: "missing" };
    };
  }

  /** Record a lane's receipt as a change receipt. Never throws: a record is a side effect. */
  recordLaneReceipt(receipt: WorkReceipt): ExchangeRecord | undefined {
    if (!this._ports.enabled()) return undefined;
    try {
      return this.store.put(changeReceiptDraft(receipt, { scope: "workspace" }, this._subjectSources(receipt)), HOST);
    } catch {
      return undefined;
    }
  }

  /** Record the verification lane's verdict on a receipt. Never throws. */
  recordVerification(result: Pick<VerificationResult, "verdict" | "reasons">, receipt: WorkReceipt): ExchangeRecord | undefined {
    if (!this._ports.enabled()) return undefined;
    try {
      return this.store.put(verificationReceiptDraft(result, receipt, { scope: "workspace" }, this._subjectSources(receipt)), HOST);
    } catch {
      return undefined;
    }
  }

  /**
   * Prior work relevant to these IDs (tickets, plans), as text a lane prompt can carry. Undefined
   * when the flag is off or nothing is relevant, so the prompt is unchanged.
   */
  packetFor(relevantTo: readonly string[], actor: ArtifactActor = HOST): string | undefined {
    if (!this._ports.enabled()) return undefined;
    const ids = [...new Set(relevantTo.filter(Boolean))];
    if (ids.length === 0) return undefined;
    try {
      const listing = this.store.list(actor, { limit: PACKET_RECORDS, relevantTo: ids, newestFirst: true });
      const packet = buildArtifactPacket({ records: listing.records, resolve: this.resolver(), relevantTo: ids });
      return packet.items.length ? renderPacket(packet) : undefined;
    } catch {
      return undefined;
    }
  }

  private _subjectSources(receipt: WorkReceipt): ArtifactSource[] {
    const ticketId = receipt.subject.ticketId;
    const ticket = ticketId ? this._ports.ticket(ticketId) : undefined;
    return ticket ? [{ kind: "ticket", id: ticket.id, revision: ticketRevision(ticket) }] : [];
  }
}

/** The packet as prompt text. Stale items stay listed, marked, so a lane can say why it set them aside. */
export function renderPacket(packet: ArtifactPacket): string {
  const lines = packet.items.map((item) => {
    const state = item.usable ? "" : ` [${item.freshness}: ${item.notFresh.join(", ")} changed or went missing since]`;
    return `- ${item.kind.replace(/_/g, " ")} ${item.id.slice(0, 18)}: ${item.summary}${state}`;
  });
  if (packet.omitted > 0) lines.push(`- (${packet.omitted} more not shown)`);
  return [
    "Prior work on this, by reference (host-recorded handoffs, not transcripts):",
    ...lines,
    "Rely only on items without a bracketed note. A noted item describes files or receipts that have changed since; re-check before building on it.",
  ].join("\n");
}
