import * as vscode from "vscode";
import { langOf } from "./graph-model.js";
import { fromNodeId, type WorkspaceRoot } from "./workspace-roots.js";

export type LanguageSupportState = "available" | "limited" | "missing" | "unknown";

export interface LanguageSupportStatus {
  lang: string;
  fileCount: number;
  status: LanguageSupportState;
  recommendation?: string;
  detail: string;
}

const SOURCE_LANGS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "rb", "php", "cs", "c", "h", "cpp", "hpp"]);

const RECOMMENDATIONS: Record<string, string> = {
  py: "ms-python.python",
  go: "golang.go",
  rs: "rust-lang.rust-analyzer",
  java: "redhat.java",
  cs: "ms-dotnettools.csharp",
  c: "ms-vscode.cpptools",
  h: "ms-vscode.cpptools",
  cpp: "ms-vscode.cpptools",
  hpp: "ms-vscode.cpptools",
  rb: "Shopify.ruby-lsp",
  php: "bmewburn.vscode-intelephense-client",
};

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Language server timed out.")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}

function isDocumentSymbol(value: vscode.DocumentSymbol | vscode.SymbolInformation): value is vscode.DocumentSymbol {
  return (value as vscode.DocumentSymbol).selectionRange !== undefined;
}

function firstSymbolPosition(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): vscode.Position | null {
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) return symbol.selectionRange.start;
    if (symbol.location) return symbol.location.range.start;
  }
  return null;
}

export function recommendationForLanguage(lang: string): string | undefined {
  return RECOMMENDATIONS[lang];
}

export async function inspectLanguageSupport(
  roots: WorkspaceRoot[],
  files: readonly string[],
  timeoutMs = 1200,
): Promise<LanguageSupportStatus[]> {
  const byLang = new Map<string, string[]>();
  for (const file of files) {
    const lang = langOf(file);
    if (!SOURCE_LANGS.has(lang)) continue;
    const list = byLang.get(lang);
    if (list) list.push(file);
    else byLang.set(lang, [file]);
  }

  const statuses: LanguageSupportStatus[] = [];
  for (const [lang, langFiles] of [...byLang.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sample = langFiles.slice(0, 3);
    let sawSymbols = false;
    let sawReferences = false;
    let timedOut = false;
    for (const rel of sample) {
      const absolute = fromNodeId(roots, rel);
      if (!absolute) continue;
      const uri = vscode.Uri.file(absolute);
      try {
        const symbols = (await withTimeout(
          vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>("vscode.executeDocumentSymbolProvider", uri),
          timeoutMs,
        )) ?? [];
        if (symbols.length === 0) continue;
        sawSymbols = true;
        const pos = firstSymbolPosition(symbols);
        if (!pos) continue;
        const refs = await withTimeout(
          vscode.commands.executeCommand<vscode.Location[] | undefined>("vscode.executeReferenceProvider", uri, pos),
          timeoutMs,
        );
        if (Array.isArray(refs)) sawReferences = true;
      } catch (err) {
        if (err instanceof Error && /timed out/i.test(err.message)) timedOut = true;
      }
      if (sawSymbols && sawReferences) break;
    }
    const status: LanguageSupportState = sawSymbols && sawReferences
      ? "available"
      : sawSymbols
        ? "limited"
        : timedOut
          ? "unknown"
          : "missing";
    statuses.push({
      lang,
      fileCount: langFiles.length,
      status,
      recommendation: recommendationForLanguage(lang),
      detail: status === "available"
        ? "Symbols and references are available."
        : status === "limited"
          ? "Symbols are available, but references are limited."
          : status === "unknown"
            ? "The language server did not answer quickly."
            : "No symbol provider answered for sampled files.",
    });
  }
  return statuses;
}
