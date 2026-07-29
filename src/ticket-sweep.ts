/* Triage sweeps: turn signals the workspace already carries — published diagnostics and
   TODO/FIXME markers in indexed source — into *proposed* tickets.
 *
 * Nothing here files anything. A sweep returns candidates; the agent or the user decides which
 * become tickets, and they land in "triage" so acceptance stays an explicit act. That is the
 * whole reason this is a separate module from TicketStore: sweeping is a suggestion engine,
 * filing is a commitment, and conflating them would let a noisy repo fill the queue by itself.
 *
 * The pure functions (parseMarkers, dedupeProposals, summarizeDiagnostics) take plain data so
 * they can be unit-tested without a workspace or a language server.
 */

import { normalizeTerritoryFile, type Ticket, type TicketPriority } from "./ticket-store.js";

/** Markers worth proposing. NOTE/HACK are deliberately excluded — they annotate, they don't ask. */
const MARKER_PATTERN = /(?:^|[^A-Za-z])(TODO|FIXME|XXX|BUG)\b[:\s-]*(.*)$/;
/** A marker line longer than this is prose that happens to contain the word; skip it. */
const MAX_MARKER_LINE = 400;
const MAX_TITLE = 140;

export type SweepSource = "diagnostic" | "marker" | "test";

export interface TicketProposal {
  title: string;
  /** Workspace-relative map node id this proposal concerns. */
  file: string;
  line?: number;
  source: SweepSource;
  priority: TicketPriority;
  detail?: string;
  /** Stable identity for dedupe against already-filed tickets — see proposalKey. */
  key: string;
}

/** One marker occurrence found in a file. */
export interface MarkerHit {
  file: string;
  line: number;
  marker: string;
  text: string;
}

/**
 * Extract TODO/FIXME/XXX/BUG markers from one file's text.
 *
 * Line numbers are 1-based to match every other location the agent sees. A marker with no
 * text after it is kept — "// FIXME" alone still marks a real spot — but titled by its
 * location instead of its (absent) message.
 */
export function parseMarkers(file: string, contents: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length > MAX_MARKER_LINE) continue;
    const match = MARKER_PATTERN.exec(line);
    if (!match) continue;
    hits.push({
      file,
      line: index + 1,
      marker: match[1]!.toUpperCase(),
      text: (match[2] ?? "").trim().replace(/\*\/\s*$/, "").replace(/-->\s*$/, "").trim(),
    });
  }
  return hits;
}

const MARKER_PRIORITY: Record<string, TicketPriority> = {
  FIXME: "high", BUG: "high", XXX: "normal", TODO: "normal",
};

/** Identity for a proposal, so re-sweeping does not re-propose what is already filed.
 *  Keyed on file + normalized text rather than line number, because a marker that moves
 *  down the file when something is inserted above it is still the same marker. */
export function proposalKey(file: string, text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
  return `${normalizeTerritoryFile(file)}::${normalized}`;
}

export function markerProposals(hits: readonly MarkerHit[]): TicketProposal[] {
  return hits.map((hit) => {
    const text = hit.text || `${hit.marker} at line ${hit.line}`;
    return {
      title: `${hit.marker}: ${text}`.slice(0, MAX_TITLE),
      file: normalizeTerritoryFile(hit.file),
      line: hit.line,
      source: "marker" as const,
      priority: MARKER_PRIORITY[hit.marker] ?? "normal",
      detail: `${hit.file}:${hit.line}`,
      key: proposalKey(hit.file, text),
    };
  });
}

export interface DiagnosticLike {
  file: string;
  message: string;
  severity: "error" | "warning";
  line?: number;
  source?: string;
}

/**
 * Group diagnostics into one proposal per file rather than one per diagnostic.
 *
 * Fifty errors in one file is one piece of work, not fifty tickets — and a queue that can be
 * flooded by a single broken import is a queue nobody will trust. Errors outrank warnings;
 * a file carrying only warnings proposes at normal priority.
 */
export function summarizeDiagnostics(diagnostics: readonly DiagnosticLike[]): TicketProposal[] {
  const byFile = new Map<string, DiagnosticLike[]>();
  for (const diagnostic of diagnostics) {
    const file = normalizeTerritoryFile(diagnostic.file);
    if (!file) continue;
    const bucket = byFile.get(file);
    if (bucket) bucket.push(diagnostic);
    else byFile.set(file, [diagnostic]);
  }

  const proposals: TicketProposal[] = [];
  for (const [file, entries] of byFile) {
    const errors = entries.filter((entry) => entry.severity === "error");
    const lead = errors[0] ?? entries[0]!;
    const count = entries.length;
    const suffix = count > 1 ? ` (+${count - 1} more in this file)` : "";
    proposals.push({
      title: `${errors.length > 0 ? "Fix" : "Clean up"} ${file.split("/").pop()}: ${lead.message}${suffix}`.slice(0, MAX_TITLE),
      file,
      line: lead.line,
      source: "diagnostic",
      priority: errors.length > 0 ? "high" : "normal",
      detail: `${count} ${count === 1 ? "diagnostic" : "diagnostics"}, ${errors.length} error${errors.length === 1 ? "" : "s"}`,
      // Keyed on the file alone: the specific lead message changes as the file is edited, but
      // "this file has diagnostics" is the same piece of work throughout.
      key: proposalKey(file, "diagnostics"),
    });
  }
  return proposals;
}

/** Test runners are intentionally not invoked by a sweep. The agent passes
 * concrete failing test locations from a prior test_run result, keeping this a
 * no-surprises proposal pass while still giving failed tests the same triage
 * landing zone as diagnostics and markers. */
export function summarizeTestFailures(failures: readonly DiagnosticLike[]): TicketProposal[] {
  const proposals: TicketProposal[] = [];
  for (const failure of failures) {
    const file = normalizeTerritoryFile(failure.file);
    const message = String(failure.message ?? "").split("\n")[0]!.trim();
    if (!file || !message) continue;
    proposals.push({
      title: `Fix failing test ${file.split("/").pop()}: ${message}`.slice(0, MAX_TITLE),
      file,
      line: failure.line,
      source: "test",
      priority: "high",
      detail: failure.source ? `test runner: ${failure.source}` : "failing test",
      key: proposalKey(file, `test failure ${message}`),
    });
  }
  return proposals;
}

/**
 * Drop proposals already represented by a ticket.
 *
 * Matches on the stable key, and also on a ticket whose territory covers the file and whose
 * title contains the marker text — because a user who filed the same thing by hand should not
 * see it proposed again just because they phrased the title differently.
 */
export function dedupeProposals(
  proposals: readonly TicketProposal[],
  existing: readonly Ticket[],
): TicketProposal[] {
  const seenKeys = new Set<string>();
  const filedKeys = new Set(
    existing.filter((ticket) => ticket.originRef?.startsWith("sweep:")).map((ticket) => ticket.originRef!.slice(6)),
  );

  return proposals.filter((proposal) => {
    if (seenKeys.has(proposal.key)) return false;
    if (filedKeys.has(proposal.key)) return false;

    const covered = existing.some((ticket) => {
      if (ticket.status === "done" || ticket.status === "cancelled") return false;
      const touchesFile = ticket.territory.files.includes(proposal.file);
      if (!touchesFile) return false;
      const haystack = ticket.title.toLowerCase();
      const needle = proposal.title.toLowerCase().replace(/^(todo|fixme|xxx|bug):\s*/, "").slice(0, 40);
      return needle.length > 8 && haystack.includes(needle);
    });
    if (covered) return false;

    seenKeys.add(proposal.key);
    return true;
  });
}

/** Rank so the most actionable proposals surface first when a sweep is truncated. */
export function rankProposals(proposals: readonly TicketProposal[]): TicketProposal[] {
  const priorityRank: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...proposals].sort((left, right) => (
    priorityRank[left.priority] - priorityRank[right.priority]
    || (left.source === right.source ? 0 : left.source === "diagnostic" ? -1 : 1)
    || left.file.localeCompare(right.file)
  ));
}
