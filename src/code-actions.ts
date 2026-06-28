import * as vscode from "vscode";

export class BlacksiteCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (diag.severity === vscode.DiagnosticSeverity.Error || diag.severity === vscode.DiagnosticSeverity.Warning) {
        const label = diag.message.length > 60 ? diag.message.slice(0, 57) + "…" : diag.message;
        const fix = new vscode.CodeAction(`Blacksite: Fix "${label}"`, vscode.CodeActionKind.QuickFix);
        fix.command = {
          command: "blacksite.fixDiagnostic",
          title: "Fix with Blacksite",
          arguments: [document.uri, diag],
        };
        fix.diagnostics = [diag];
        actions.push(fix);
      }
    }

    if (!(range instanceof vscode.Range ? range : range).isEmpty) {
      const explain = new vscode.CodeAction("Blacksite: Explain selection", vscode.CodeActionKind.RefactorRewrite);
      explain.command = { command: "blacksite.explainSelection", title: "Explain selection" };
      actions.push(explain);
    }

    return actions;
  }
}
