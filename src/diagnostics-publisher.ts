import * as vscode from "vscode";
import * as path from "path";

export interface ProblemInput {
  path: string;
  line: number;        // 1-based
  endLine?: number;    // 1-based
  column?: number;     // 1-based
  endColumn?: number;  // 1-based
  severity?: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

export type ReportResult =
  | { ok: true; count: number; files: number }
  | { ok: false; error: string };

/** Callback surface used by the agent's report_problems tool (keeps vscode types out of AgentSession). */
export interface DiagnosticsProvider {
  report(problems: ProblemInput[], clear: boolean): ReportResult;
}

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  error:   vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info:    vscode.DiagnosticSeverity.Information,
  hint:    vscode.DiagnosticSeverity.Hint,
};

export class DiagnosticsPublisher implements DiagnosticsProvider {
  private readonly _collection: vscode.DiagnosticCollection;

  constructor(private readonly _workspaceRoot: string) {
    this._collection = vscode.languages.createDiagnosticCollection("blacksite");
  }

  /** Replace all Blacksite-reported problems with the supplied set (or clear them). */
  report(problems: ProblemInput[], clear: boolean): ReportResult {
    try {
      this._collection.clear();
      if (clear || problems.length === 0) return { ok: true, count: 0, files: 0 };

      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const p of problems) {
        if (!p || typeof p.path !== "string" || !p.path || typeof p.message !== "string") continue;
        const abs = path.isAbsolute(p.path) ? p.path : path.join(this._workspaceRoot, p.path);
        const list = byFile.get(abs) ?? [];
        list.push(this._toDiagnostic(p));
        byFile.set(abs, list);
      }

      let count = 0;
      for (const [file, diags] of byFile) {
        this._collection.set(vscode.Uri.file(file), diags);
        count += diags.length;
      }
      return { ok: true, count, files: byFile.size };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private _toDiagnostic(p: ProblemInput): vscode.Diagnostic {
    const startLine = Math.max(0, (p.line || 1) - 1);
    const startCol  = Math.max(0, (p.column ?? 1) - 1);
    const endLine   = Math.max(startLine, (p.endLine ?? p.line ?? 1) - 1);
    const endCol    = p.endColumn != null ? Math.max(0, p.endColumn - 1) : Number.MAX_SAFE_INTEGER;
    const range = new vscode.Range(startLine, startCol, endLine, endCol);
    const diag = new vscode.Diagnostic(range, p.message, SEVERITY_MAP[p.severity ?? "warning"] ?? vscode.DiagnosticSeverity.Warning);
    diag.source = p.source ? `Blacksite · ${p.source}` : "Blacksite";
    return diag;
  }

  clear(): void {
    this._collection.clear();
  }

  dispose(): void {
    this._collection.dispose();
  }
}
