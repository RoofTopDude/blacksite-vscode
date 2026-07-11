import * as vscode from "vscode";
import * as path from "path";

// ── Auto-attached post-edit diagnostics ──────────────────────────────────────
// After a mutating op, give the language servers a beat to re-lint the touched
// files, then collect the resulting errors/warnings so the agent sees whether it
// broke anything — closing the edit → diagnose → fix loop without an extra hop.

export interface ChangedDiagnostics {
  errors: number;
  warnings: number;
  problems: Array<{
    path: string;
    line: number;
    column: number;
    severity: string;
    message: string;
    source?: string;
  }>;
}

const SEVERITY_NAMES = ["error", "warning", "info", "hint"];

export async function collectForUris(
  uris: vscode.Uri[],
  workspaceRoot: string,
  opts: { timeoutMs?: number; limit?: number } = {},
): Promise<ChangedDiagnostics> {
  const unique = dedupe(uris);
  if (unique.length) await waitForDiagnosticChange(unique, opts.timeoutMs ?? 1200);

  const limit = opts.limit ?? 20;
  let errors = 0;
  let warnings = 0;
  const problems: ChangedDiagnostics["problems"] = [];

  for (const uri of unique) {
    for (const d of vscode.languages.getDiagnostics(uri)) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      if (d.severity <= vscode.DiagnosticSeverity.Warning && problems.length < limit) {
        problems.push({
          path: rel(uri, workspaceRoot),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY_NAMES[d.severity] ?? "info",
          message: d.message,
          source: typeof d.source === "string" ? d.source : undefined,
        });
      }
    }
  }

  return { errors, warnings, problems };
}

/** Exported for LspService's code_diagnostics op — same "give a just-opened file's
    language server a beat to publish" wait, reused for a direct diagnostics read
    rather than only after an edit. */
export function waitForDiagnosticChange(uris: vscode.Uri[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const keys = new Set(uris.map((u) => u.toString()));
    const cleanup = (): void => { sub.dispose(); clearTimeout(timer); };
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => keys.has(u.toString()))) { cleanup(); resolve(); }
    });
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
  });
}

function dedupe(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  for (const u of uris) {
    const key = u.toString();
    if (!seen.has(key)) { seen.add(key); out.push(u); }
  }
  return out;
}

function rel(uri: vscode.Uri, workspaceRoot: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const base = folder?.uri.fsPath ?? workspaceRoot;
  const r = path.relative(base, uri.fsPath).replace(/\\/g, "/");
  return r && !r.startsWith("..") ? r : uri.fsPath.replace(/\\/g, "/");
}
