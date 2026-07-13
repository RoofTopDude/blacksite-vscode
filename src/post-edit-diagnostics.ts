import * as vscode from "vscode";
import { WorkspaceIdentity } from "./lsp/workspace-identity.js";

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

export interface NormalizedDiagnostic {
  path: string;
  rootId?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: string;
  message: string;
  source?: string;
  code?: string;
  codeTarget?: string;
  snippet?: string;
  tags?: string[];
  relatedInformation?: Array<{
    path: string;
    rootId?: string;
    line: number;
    column: number;
    message: string;
  }>;
}

export interface DiagnosticBaseline {
  readonly fingerprints: Map<string, NormalizedDiagnostic>;
}

export interface DiagnosticSnapshot {
  status: "ready" | "partial" | "unknown" | "timed_out" | "cancelled";
  scope: "file" | "published_workspace" | "activated_workspace";
  counts: SeverityCounts;
  allCounts: SeverityCounts;
  /** Backwards-compatible summary fields used by existing result cards. */
  errors: number;
  warnings: number;
  problems: NormalizedDiagnostic[];
  totalFound: number;
  truncated: boolean;
  freshness: {
    observedDiagnosticChange: boolean;
    waitedMs: number;
    documentVersions: Record<string, number>;
  };
  coverage: {
    requestedFiles?: number;
    activatedFiles?: number;
    diagnosticUris: number;
    capped?: boolean;
  };
  delta?: {
    introduced: NormalizedDiagnostic[];
    resolved: NormalizedDiagnostic[];
    persisting: NormalizedDiagnostic[];
  };
}

export type ChangedDiagnostics = DiagnosticSnapshot;

interface SnapshotOptions {
  uris?: vscode.Uri[];
  severity?: string;
  timeoutMs?: number;
  quietMs?: number;
  limit?: number;
  signal?: AbortSignal;
  baseline?: DiagnosticBaseline;
  waitForChange?: boolean;
  scope?: DiagnosticSnapshot["scope"];
  coverageCapped?: boolean;
}

const SEVERITY_NAMES = ["error", "warning", "info", "hint"];
const SEVERITY_THRESHOLD: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export async function captureDiagnosticBaseline(
  uris: vscode.Uri[],
  workspaceRoot: string,
): Promise<DiagnosticBaseline> {
  const identity = new WorkspaceIdentity(workspaceRoot);
  const rows = await normalizeEntries(entriesForUris(dedupe(uris)), identity);
  return { fingerprints: new Map(rows.map((problem) => [fingerprint(problem), problem])) };
}

export async function collectForUris(
  uris: vscode.Uri[],
  workspaceRoot: string,
  opts: { timeoutMs?: number; quietMs?: number; limit?: number; signal?: AbortSignal; baseline?: DiagnosticBaseline } = {},
): Promise<DiagnosticSnapshot> {
  return collectDiagnosticSnapshot(workspaceRoot, {
    uris,
    timeoutMs: opts.timeoutMs,
    quietMs: opts.quietMs,
    limit: opts.limit,
    signal: opts.signal,
    baseline: opts.baseline,
    waitForChange: true,
    scope: "file",
  });
}

export async function collectDiagnosticSnapshot(
  workspaceRoot: string,
  opts: SnapshotOptions = {},
): Promise<DiagnosticSnapshot> {
  const identity = new WorkspaceIdentity(workspaceRoot);
  const uris = opts.uris ? dedupe(opts.uris) : undefined;
  const documentVersions: Record<string, number> = {};
  let activatedFiles = 0;

  if (uris) {
    for (const uri of uris) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const display = identity.fromUri(uri);
        const key = display.ok ? `${display.value.rootId}:${display.value.path}` : uri.toString();
        documentVersions[key] = doc.version;
        activatedFiles += 1;
      } catch { /* invalid paths are rejected by callers; a disappearing file stays unactivated */ }
    }
  }

  const wait = opts.waitForChange && uris?.length
    ? await waitForDiagnosticQuiescence(uris, {
        timeoutMs: opts.timeoutMs ?? 1_500,
        quietMs: opts.quietMs ?? 180,
        signal: opts.signal,
      })
    : { observed: false, timedOut: false, cancelled: false, waitedMs: 0 };

  const rawEntries = uris ? entriesForUris(uris) : vscode.languages.getDiagnostics();
  const workspaceEntries = rawEntries.filter(([uri]) => identity.contains(uri));
  const allProblems = await normalizeEntries(workspaceEntries, identity);
  const allCounts = countSeverities(allProblems);
  const threshold = SEVERITY_THRESHOLD[opts.severity?.toLowerCase() ?? ""];
  const filtered = threshold === undefined
    ? allProblems
    : allProblems.filter((problem) => severityNumber(problem.severity) <= threshold);
  filtered.sort(compareProblems);
  const limit = Math.max(1, opts.limit ?? 20);
  const problems = filtered.slice(0, limit);
  const counts = countSeverities(filtered);

  const scope = opts.scope ?? (uris ? "file" : "published_workspace");
  const status: DiagnosticSnapshot["status"] = wait.cancelled
    ? "cancelled"
    : scope === "published_workspace"
      ? "partial"
      : wait.timedOut
        ? "timed_out"
        : wait.observed
          ? "ready"
          : "unknown";

  const delta = opts.baseline ? diagnosticDelta(opts.baseline, allProblems) : undefined;
  return {
    status,
    scope,
    counts,
    allCounts,
    errors: counts.error,
    warnings: counts.warning,
    problems,
    totalFound: filtered.length,
    truncated: filtered.length > problems.length,
    freshness: {
      observedDiagnosticChange: wait.observed,
      waitedMs: wait.waitedMs,
      documentVersions,
    },
    coverage: {
      requestedFiles: uris?.length,
      activatedFiles: uris ? activatedFiles : undefined,
      diagnosticUris: workspaceEntries.filter(([, diagnostics]) => diagnostics.length > 0).length,
      capped: opts.coverageCapped || undefined,
    },
    delta,
  };
}

export async function waitForDiagnosticQuiescence(
  uris: vscode.Uri[],
  opts: { timeoutMs: number; quietMs: number; signal?: AbortSignal },
): Promise<{ observed: boolean; timedOut: boolean; cancelled: boolean; waitedMs: number }> {
  const started = Date.now();
  if (opts.signal?.aborted) return { observed: false, timedOut: false, cancelled: true, waitedMs: 0 };
  return new Promise((resolve) => {
    const keys = new Set(uris.map((uri) => uri.toString()));
    let observed = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (timedOut: boolean, cancelled: boolean): void => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      clearTimeout(deadlineTimer);
      if (quietTimer) clearTimeout(quietTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ observed, timedOut, cancelled, waitedMs: Date.now() - started });
    };
    const onAbort = (): void => finish(false, true);
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((uri) => keys.has(uri.toString()))) return;
      observed = true;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(false, false), opts.quietMs);
    });
    const deadlineTimer = setTimeout(() => finish(true, false), opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Compatibility wrapper for older call sites; prefer waitForDiagnosticQuiescence. */
export async function waitForDiagnosticChange(uris: vscode.Uri[], timeoutMs: number): Promise<void> {
  await waitForDiagnosticQuiescence(uris, { timeoutMs, quietMs: 1 });
}

function entriesForUris(uris: vscode.Uri[]): Array<[vscode.Uri, readonly vscode.Diagnostic[]]> {
  return uris.map((uri) => [uri, vscode.languages.getDiagnostics(uri)]);
}

async function normalizeEntries(
  entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>,
  identity: WorkspaceIdentity,
): Promise<NormalizedDiagnostic[]> {
  const documents = new Map<string, vscode.TextDocument>();
  const rows: NormalizedDiagnostic[] = [];
  for (const [uri, diagnostics] of entries) {
    const workspacePath = identity.fromUri(uri);
    if (!workspacePath.ok) continue;
    const display = identity.display(workspacePath.value);
    let document = documents.get(uri.toString());
    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(uri);
        documents.set(uri.toString(), document);
      } catch { /* snippet remains absent */ }
    }
    for (const diagnostic of diagnostics) {
      rows.push({
        ...display,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1,
        severity: SEVERITY_NAMES[diagnostic.severity] ?? "info",
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnosticCode(diagnostic.code),
        codeTarget: diagnosticCodeTarget(diagnostic.code),
        snippet: safeSnippet(document, diagnostic.range.start.line),
        tags: diagnostic.tags?.map((tag) => tag === vscode.DiagnosticTag.Deprecated ? "deprecated" : "unnecessary"),
        relatedInformation: diagnostic.relatedInformation?.flatMap((related) => {
          const relatedPath = identity.fromUri(related.location.uri);
          if (!relatedPath.ok) return [];
          return [{
            ...identity.display(relatedPath.value),
            line: related.location.range.start.line + 1,
            column: related.location.range.start.character + 1,
            message: related.message,
          }];
        }),
      });
    }
  }
  return rows;
}

function diagnosticDelta(baseline: DiagnosticBaseline, current: NormalizedDiagnostic[]): DiagnosticSnapshot["delta"] {
  const after = new Map(current.map((problem) => [fingerprint(problem), problem]));
  const introduced = [...after].filter(([key]) => !baseline.fingerprints.has(key)).map(([, problem]) => problem);
  const persisting = [...after].filter(([key]) => baseline.fingerprints.has(key)).map(([, problem]) => problem);
  const resolved = [...baseline.fingerprints].filter(([key]) => !after.has(key)).map(([, problem]) => problem);
  return { introduced, resolved, persisting };
}

function fingerprint(problem: NormalizedDiagnostic): string {
  return [
    problem.rootId ?? "",
    problem.path,
    problem.line,
    problem.column,
    problem.endLine,
    problem.endColumn,
    problem.severity,
    problem.source ?? "",
    problem.code ?? "",
    problem.message,
  ].join("\u0000");
}

function countSeverities(problems: readonly NormalizedDiagnostic[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const problem of problems) counts[problem.severity as keyof SeverityCounts] += 1;
  return counts;
}

function severityNumber(severity: string): number {
  const value = SEVERITY_NAMES.indexOf(severity);
  return value < 0 ? vscode.DiagnosticSeverity.Information : value;
}

function compareProblems(a: NormalizedDiagnostic, b: NormalizedDiagnostic): number {
  return severityNumber(a.severity) - severityNumber(b.severity)
    || (a.rootId ?? "").localeCompare(b.rootId ?? "")
    || a.path.localeCompare(b.path)
    || a.line - b.line
    || a.column - b.column
    || (a.source ?? "").localeCompare(b.source ?? "")
    || (a.code ?? "").localeCompare(b.code ?? "");
}

function diagnosticCode(code: vscode.Diagnostic["code"]): string | undefined {
  if (code == null) return undefined;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return String(code.value);
}

function diagnosticCodeTarget(code: vscode.Diagnostic["code"]): string | undefined {
  return code && typeof code === "object" && code.target ? code.target.toString() : undefined;
}

function safeSnippet(document: vscode.TextDocument | undefined, line: number): string | undefined {
  if (!document || line < 0 || line >= document.lineCount) return undefined;
  return document.lineAt(line).text.trim();
}

function dedupe(uris: vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
}
