/**
 * Relevance-ranked, bounded packets of exchange references for a delegated agent.
 *
 * A packet is built only when a caller asks for one. Nothing here puts it into a prompt. Each item
 * carries a short summary, the record ID, and the freshness of its sources. It never carries
 * transcripts, tool output or the evidence the record points at. A consumer that needs more reads
 * that reference through its own access check.
 *
 * Pure. Ranking uses only the overlap between a record's sources and what the consumer is working
 * on, plus whether the record is usable. Records have no timestamp, so recency is not a signal.
 */

import { redactSecretsInText } from "../../shared/redaction.js";
import { assessRecord, type SourceFreshness, type SourceResolver } from "./freshness.js";
import type { ArtifactKind, ExchangeRecord } from "./model.js";

export const DEFAULT_PACKET_ITEMS = 6;
export const MAX_PACKET_ITEMS = 12;
export const DEFAULT_PACKET_BYTES = 4096;
export const MAX_PACKET_BYTES = 16384;
const MAX_SUMMARY_CHARS = 300;

export interface PacketRequest {
  records: readonly ExchangeRecord[];
  resolve: SourceResolver;
  /**
   * Source IDs the consumer is working on: ticket, plan, step or file IDs. When given, only records
   * sharing at least one source with them are included, most overlap first. Empty or absent means
   * every record is a candidate, usable ones first.
   */
  relevantTo?: readonly string[];
  maxItems?: number;
  /** Serialized size of the whole packet, measured per item. */
  maxBytes?: number;
}

export interface PacketItem {
  id: string;
  kind: ArtifactKind;
  summary: string;
  freshness: SourceFreshness;
  usable: boolean;
  /** How many of the record's sources the consumer is working on. */
  overlap: number;
  /** IDs of sources that are not fresh, so the consumer can say why it did not rely on them. */
  notFresh: string[];
}

export interface ArtifactPacket {
  items: PacketItem[];
  /** Relevant records left out because the item or byte bound was reached. */
  omitted: number;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * A record's own words, clipped, with anything that looks like a credential masked: a packet is
 * handed to another lane, and a summary must not carry a secret across that boundary.
 */
export function summarizeRecord(record: ExchangeRecord): string {
  const text = record.kind === "change_receipt" ? record.payload.summary
    : record.kind === "verification_receipt"
      ? `Verification: ${record.payload.verdict.replace(/_/g, " ")}${record.payload.reasons[0] ? ` (${record.payload.reasons[0].replace(/_/g, " ")})` : ""} for receipt ${record.payload.workReceiptId}.`
      : `${record.payload.decision}. ${record.payload.rationale}`;
  return clip(redactSecretsInText(text), MAX_SUMMARY_CHARS);
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.trunc(value), min), max);

export function buildArtifactPacket(request: PacketRequest): ArtifactPacket {
  const wanted = new Set(request.relevantTo ?? []);
  const maxItems = clamp(request.maxItems ?? DEFAULT_PACKET_ITEMS, 1, MAX_PACKET_ITEMS);
  const maxBytes = clamp(request.maxBytes ?? DEFAULT_PACKET_BYTES, 512, MAX_PACKET_BYTES);

  const candidates = request.records.map((record) => {
    const assessment = assessRecord(record, request.resolve);
    const overlap = record.sources.filter((source) => wanted.has(source.id)).length;
    return { record, assessment, overlap };
  }).filter((entry) => wanted.size === 0 || entry.overlap > 0);

  candidates.sort((a, b) => b.overlap - a.overlap
    || Number(b.assessment.usable) - Number(a.assessment.usable)
    || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));

  const items: PacketItem[] = [];
  let bytes = 2;
  let omitted = 0;
  for (const { record, assessment, overlap } of candidates) {
    const item: PacketItem = {
      id: record.id,
      kind: record.kind,
      summary: summarizeRecord(record),
      freshness: assessment.freshness,
      usable: assessment.usable,
      overlap,
      notFresh: assessment.sources.filter((source) => source.freshness !== "fresh").map((source) => source.id),
    };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length >= maxItems || bytes + size > maxBytes) {
      omitted += 1;
      continue;
    }
    items.push(item);
    bytes += size;
  }
  return { items, omitted };
}
