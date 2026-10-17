/**
 * Freshness of an exchange record's sources, judged when the record is read and never stored.
 *
 * A record says what its producer saw, pinned by revision. Whether that is still true is for the
 * host to say: it resolves each source to the revision now in force, or reports that the source is
 * missing or not visible to the caller. A record is usable only when every source is fresh. A stale
 * or unavailable input stays visible, so a consumer can say why it did not rely on it.
 *
 * Pure. The host supplies the resolver. This module never opens a file or a store.
 */

import type { ArtifactSource, ExchangeRecord } from "./model.js";

export type SourceResolution =
  | { state: "current"; revision: string }
  | { state: "missing" }
  | { state: "denied" };

export type SourceFreshness = "fresh" | "stale" | "unavailable" | "denied";

export type SourceResolver = (source: ArtifactSource) => SourceResolution;

export interface SourceAssessment {
  kind: ArtifactSource["kind"];
  id: string;
  freshness: SourceFreshness;
  /** The revision now in force, present only when it differs from the pinned one. */
  currentRevision?: string;
}

export interface RecordAssessment {
  recordId: string;
  /** The least fresh source decides the record's freshness. */
  freshness: SourceFreshness;
  usable: boolean;
  sources: SourceAssessment[];
}

const SEVERITY: Record<SourceFreshness, number> = { fresh: 0, stale: 1, unavailable: 2, denied: 3 };

function judge(source: ArtifactSource, resolve: SourceResolver): SourceAssessment {
  const base = { kind: source.kind, id: source.id };
  let resolution: SourceResolution;
  try {
    resolution = resolve(source);
  } catch {
    // A resolver that throws has not shown the source is current. Never read that as fresh.
    return { ...base, freshness: "unavailable" };
  }
  if (resolution.state === "denied") return { ...base, freshness: "denied" };
  if (resolution.state === "missing") return { ...base, freshness: "unavailable" };
  if (resolution.revision === source.revision) return { ...base, freshness: "fresh" };
  return { ...base, freshness: "stale", currentRevision: resolution.revision };
}

export function assessRecord(record: ExchangeRecord, resolve: SourceResolver): RecordAssessment {
  const sources = record.sources.map((source) => judge(source, resolve));
  const freshness = sources.reduce<SourceFreshness>(
    (worst, source) => (SEVERITY[source.freshness] > SEVERITY[worst] ? source.freshness : worst),
    "fresh",
  );
  return { recordId: record.id, freshness, usable: freshness === "fresh", sources };
}
