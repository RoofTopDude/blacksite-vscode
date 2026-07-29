/* Host side of the triage sweep: gathers the raw signals (VS Code's published diagnostics and
   marker comments in indexed source), hands them to the pure functions in ticket-sweep.ts, and
   returns ranked, deduped proposals.

   Still proposes only. Filing is the caller's decision — see the ticket_sweep tool and the
   blacksite.sweepForTickets command, which both make acceptance explicit. */

import * as fs from "fs";
import * as vscode from "vscode";
import {
  dedupeProposals, markerProposals, parseMarkers, rankProposals, summarizeDiagnostics, summarizeTestFailures,
  type DiagnosticLike, type TicketProposal,
} from "./ticket-sweep.js";
import type { Ticket } from "./ticket-store.js";
import { fromNodeId, toNodeId, type WorkspaceRoot } from "./graph/workspace-roots.js";

/** Files scanned for markers in one sweep. Bounded so a sweep is a quick action, not a job. */
const MAX_SCANNED_FILES = 1_200;
/** Skip anything larger — a marker inside a 2 MB generated bundle is not actionable work. */
const MAX_FILE_BYTES = 400_000;

export interface SweepOptions {
  /** Restrict to files under this directory prefix. */
  area?: string;
  includeMarkers?: boolean;
  includeDiagnostics?: boolean;
  limit?: number;
  /** Parsed locations from a preceding test run. A sweep never runs tests itself. */
  testFailures?: DiagnosticLike[];
}

export interface SweepResult {
  proposals: TicketProposal[];
  scannedFiles: number;
  /** Total before the limit, so a truncated sweep never reads as a complete one. */
  totalFound: number;
}

export class TicketSweepRunner {
  constructor(
    private readonly _roots: () => WorkspaceRoot[],
    private readonly _indexedFiles: () => string[],
    private readonly _existingTickets: () => Ticket[],
  ) {}

  async run(options: SweepOptions = {}, signal?: AbortSignal): Promise<SweepResult> {
    const includeMarkers = options.includeMarkers !== false;
    const includeDiagnostics = options.includeDiagnostics !== false;
    const limit = Math.max(1, Math.min(100, options.limit ?? 25));
    const area = options.area?.replace(/\\/g, "/").replace(/\/+$/, "");

    const proposals: TicketProposal[] = [];
    let scannedFiles = 0;

    if (includeDiagnostics) {
      proposals.push(...summarizeDiagnostics(this._collectDiagnostics(area)));
    }
    if (options.testFailures?.length) {
      proposals.push(...summarizeTestFailures(options.testFailures.filter((failure) => (
        !area || failure.file === area || failure.file.startsWith(`${area}/`)
      ))));
    }

    if (includeMarkers) {
      const roots = this._roots();
      const candidates = this._indexedFiles()
        .filter((id) => !area || id === area || id.startsWith(`${area}/`))
        .slice(0, MAX_SCANNED_FILES);
      for (const nodeId of candidates) {
        if (signal?.aborted) throw new Error("Ticket sweep cancelled.");
        const absolute = fromNodeId(roots, nodeId);
        if (!absolute) continue;
        let contents: string;
        try {
          // Skip oversized files before reading them, not after.
          if ((await fs.promises.stat(absolute)).size > MAX_FILE_BYTES) continue;
          contents = await fs.promises.readFile(absolute, "utf8");
        } catch {
          continue; // unreadable or vanished mid-sweep — not a sweep failure
        }
        scannedFiles += 1;
        proposals.push(...markerProposals(parseMarkers(nodeId, contents)));
      }
    }

    const deduped = rankProposals(dedupeProposals(proposals, this._existingTickets()));
    return { proposals: deduped.slice(0, limit), scannedFiles, totalFound: deduped.length };
  }

  /** VS Code's published diagnostics, mapped into map node ids and filtered to the area. */
  private _collectDiagnostics(area?: string): DiagnosticLike[] {
    const roots = this._roots();
    const out: DiagnosticLike[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file") continue;
      const nodeId = toNodeId(roots, uri.fsPath);
      if (!nodeId) continue;
      if (area && !(nodeId === area || nodeId.startsWith(`${area}/`))) continue;
      for (const diagnostic of diagnostics) {
        // Information and hints are not work; only errors and warnings propose a ticket.
        if (diagnostic.severity !== vscode.DiagnosticSeverity.Error
          && diagnostic.severity !== vscode.DiagnosticSeverity.Warning) continue;
        out.push({
          file: nodeId,
          message: String(diagnostic.message).split("\n")[0]!.slice(0, 160),
          severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
          line: diagnostic.range.start.line + 1,
          source: diagnostic.source,
        });
      }
    }
    return out;
  }
}
