import * as fs from "fs";
import * as path from "path";
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

/**
 * Whether one requested file's diagnostics describe its current content.
 *
 * - `ready`: a publish for this file arrived during the wait, or the last publish seen for it
 *   matches the content the document holds now.
 * - `timed_out`: the file has a checker, but its last publish describes older content and no new
 *   one arrived in time.
 * - `no_checker`: nothing has ever published diagnostics for this file since the tracker started.
 *   For a file the session edited, that means no language server or linter covers it (Markdown,
 *   most YAML/TOML), so an empty result is not evidence either way.
 */
export type FileDiagnosticStatus = "ready" | "timed_out" | "no_checker";

export interface DiagnosticSnapshot {
  status: "ready" | "partial" | "unknown" | "timed_out" | "cancelled" | "no_checker";
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
    /** Per requested file (keyed like documentVersions), when files were requested. */
    files?: Record<string, FileDiagnosticStatus>;
  };
  coverage: {
    requestedFiles?: number;
    activatedFiles?: number;
    diagnosticUris: number;
    capped?: boolean;
    /** Files left out because they no longer exist on disk (see isStaleDiagnosticUri). */
    deletedFilesSkipped?: number;
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

/**
 * When each file's diagnostics were last published, and for which document version.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A snapshot used to count as current only if a publish arrived *during* its 1.5 s wait. A
 * language server publishes once per change, usually within moments of the edit, so a check the
 * agent ran a few seconds later saw nothing new and reported `timed_out` for a file whose
 * diagnostics were perfectly current. Files with no checker at all (Markdown, most YAML) timed
 * out every time. The verification gate read both as a failed check, and the agent learned that
 * code_diagnostics "always times out" and to discount it.
 *
 * Remembering the last publish per file lets a quiet wait be read correctly: the diagnostics VS
 * Code holds already describe the current content, or nothing has ever checked this file.
 *
 * ── Bounds ──────────────────────────────────────────────────────────────────
 * One listener for the whole extension, and an insertion-ordered map capped at MAX_TRACKED_URIS
 * so a workspace-wide publish over tens of thousands of files cannot grow it without limit.
 */
const MAX_TRACKED_URIS = 10_000;

interface PublishRecord {
  at: number;
  /** Version of the open document when the publish arrived; undefined if it was not open. */
  version?: number;
}

const publishes = new Map<string, PublishRecord>();
/** File extensions something has published diagnostics for since the tracker started: evidence that a language server for them is running. */
const publishedExtensions = new Set<string>();
let trackerStarted = false;

/** Languages that normally have a language server. A file in one of them that nothing has published for
 *  is more likely waiting on a server that has not started than uncheckable, so it is never "no_checker". */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go", ".java", ".kt", ".kts", ".cs",
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".swift", ".rb", ".php", ".vue", ".svelte",
]);

function recordPublishes(uris: readonly vscode.Uri[]): void {
  const now = Date.now();
  const openVersions = new Map<string, number>();
  for (const doc of vscode.workspace.textDocuments ?? []) openVersions.set(doc.uri.toString(), doc.version);
  for (const uri of uris) {
    const key = uri.toString();
    publishes.delete(key);
    publishes.set(key, { at: now, version: openVersions.get(key) });
    publishedExtensions.add(path.extname(uri.path).toLowerCase());
  }
  while (publishes.size > MAX_TRACKED_URIS) {
    const oldest = publishes.keys().next().value;
    if (oldest === undefined) break;
    publishes.delete(oldest);
  }
}

/** Start recording diagnostic publishes. Call once at activation; the returned disposable stops it. */
export function startDiagnosticPublishTracker(): vscode.Disposable {
  trackerStarted = true;
  const subscription = vscode.languages.onDidChangeDiagnostics((event) => recordPublishes(event.uris));
  return {
    dispose: () => {
      subscription.dispose();
      trackerStarted = false;
      publishes.clear();
      publishedExtensions.clear();
    },
  };
}

/** Read whether the diagnostics VS Code holds for `uri` describe the content it has now. */
function fileStatusFromHistory(uri: vscode.Uri, currentVersion: number | undefined): FileDiagnosticStatus {
  const record = publishes.get(uri.toString());
  if (!record) {
    const extension = path.extname(uri.path).toLowerCase();
    if (!CODE_EXTENSIONS.has(extension)) return "no_checker";
    // A code file with no publish: if the language's server has reported on other files it has seen this one
    // (a clean file may publish nothing); if none has, the server may simply not be up yet, which is not a pass.
    return publishedExtensions.has(extension) ? "ready" : "timed_out";
  }
  if (record.version !== undefined) return record.version === currentVersion ? "ready" : "timed_out";
  // Published while the file was closed: current unless the file changed on disk since.
  try {
    return fs.statSync(uri.fsPath).mtimeMs <= record.at ? "ready" : "timed_out";
  } catch {
    return "timed_out";
  }
}

function overallFileStatus(states: readonly FileDiagnosticStatus[]): DiagnosticSnapshot["status"] {
  if (states.includes("timed_out")) return "timed_out";
  if (states.length > 0 && states.every((state) => state === "no_checker")) return "no_checker";
  return "ready";
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
  const opened: Array<{ uri: vscode.Uri; key: string; version: number | undefined }> = [];
  let activatedFiles = 0;

  if (uris) {
    for (const uri of uris) {
      const display = identity.fromUri(uri);
      const key = display.ok ? `${display.value.rootId}:${display.value.path}` : uri.toString();
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        documentVersions[key] = doc.version;
        opened.push({ uri, key, version: doc.version });
        activatedFiles += 1;
      } catch {
        /* invalid paths are rejected by callers; a disappearing file stays unactivated */
        opened.push({ uri, key, version: undefined });
      }
    }
  }

  const wait = opts.waitForChange && uris?.length
    ? await waitForDiagnosticQuiescence(uris, {
        timeoutMs: opts.timeoutMs ?? 1_500,
        quietMs: opts.quietMs ?? 180,
        signal: opts.signal,
      })
    : { observed: false, timedOut: false, cancelled: false, waitedMs: 0, changed: new Set<string>() };

  /* Per file, for an explicit file request: a publish during the wait settles it, and otherwise the
     publish history says whether what VS Code holds is current. Only with the tracker running —
     without it there is no history, and the old reading (a quiet wait is a timeout) stands. */
  let files: Record<string, FileDiagnosticStatus> | undefined;
  if (trackerStarted && opts.scope === "file" && opts.waitForChange && opened.length > 0 && !wait.cancelled) {
    files = {};
    for (const entry of opened) {
      files[entry.key] = wait.changed.has(entry.uri.toString())
        ? (wait.timedOut ? "timed_out" : "ready")
        : fileStatusFromHistory(entry.uri, entry.version);
    }
  }

  const rawEntries = uris ? entriesForUris(uris) : vscode.languages.getDiagnostics();
  const inWorkspace = rawEntries.filter(([uri]) => identity.contains(uri));
  const roots = workspaceRootPaths(workspaceRoot);
  const workspaceEntries = inWorkspace.filter(([uri]) => !isStaleDiagnosticUri(uri, roots));
  const deletedFilesSkipped = inWorkspace.filter(([, diagnostics]) => diagnostics.length > 0).length
    - workspaceEntries.filter(([, diagnostics]) => diagnostics.length > 0).length;
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
      : files
        ? overallFileStatus(Object.values(files))
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
      ...(files ? { files } : {}),
    },
    coverage: {
      requestedFiles: uris?.length,
      activatedFiles: uris ? activatedFiles : undefined,
      diagnosticUris: workspaceEntries.filter(([, diagnostics]) => diagnostics.length > 0).length,
      capped: opts.coverageCapped || undefined,
      deletedFilesSkipped: deletedFilesSkipped || undefined,
    },
    delta,
  };
}

/** The workspace folders on disk, plus the root the caller works in. */
export function workspaceRootPaths(workspaceRoot: string): string[] {
  return [...new Set([workspaceRoot, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)])];
}

/**
 * True for diagnostics VS Code still holds for a file that is gone from disk.
 *
 * Language servers retire them on their own schedule. A document the harness opened (every
 * mutation collects diagnostics for the file it wrote) stays in memory after the file is deleted,
 * and its server keeps publishing against that buffer, so a temporary script the agent wrote and
 * removed went on reporting errors in the workspace state and in code_diagnostics — and the agent
 * spent its closing turns trying to fix or verify a file that no longer existed.
 *
 * Absence is only judged inside a workspace folder that is itself on disk, and an unsaved open
 * buffer is kept: its diagnostics describe text the user can still save.
 */
export function isStaleDiagnosticUri(uri: vscode.Uri, roots: readonly string[]): boolean {
  if (uri.scheme !== "file") return false;
  const file = uri.fsPath;
  if (fs.existsSync(file)) return false;
  const key = pathKey(file);
  if ((vscode.workspace.textDocuments ?? []).some((doc) => doc.isDirty && doc.uri.scheme === "file" && pathKey(doc.uri.fsPath) === key)) return false;
  return roots.some((root) => {
    const relative = path.relative(root, file);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(root);
  });
}

/** A file path in one comparable form: resolved separators, and case-folded where the file system is. */
function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Workspace-relative paths VS Code holds diagnostics for that no longer exist on disk. */
export function staleDiagnosticFiles(workspaceRoot: string): string[] {
  const roots = workspaceRootPaths(workspaceRoot);
  return vscode.languages.getDiagnostics()
    .filter(([uri, diagnostics]) => diagnostics.length > 0 && isStaleDiagnosticUri(uri, roots))
    .map(([uri]) => path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/"));
}

export async function waitForDiagnosticQuiescence(
  uris: vscode.Uri[],
  opts: { timeoutMs: number; quietMs: number; signal?: AbortSignal },
): Promise<{ observed: boolean; timedOut: boolean; cancelled: boolean; waitedMs: number; changed: Set<string> }> {
  const started = Date.now();
  const changed = new Set<string>();
  if (opts.signal?.aborted) return { observed: false, timedOut: false, cancelled: true, waitedMs: 0, changed };
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
      resolve({ observed, timedOut, cancelled, waitedMs: Date.now() - started, changed });
    };
    const onAbort = (): void => finish(false, true);
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      const hits = event.uris.filter((uri) => keys.has(uri.toString()));
      if (hits.length === 0) return;
      for (const uri of hits) changed.add(uri.toString());
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
