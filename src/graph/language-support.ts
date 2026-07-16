import * as vscode from "vscode";
import { langOf } from "./graph-model.js";
import { fromNodeId, type WorkspaceRoot } from "./workspace-roots.js";
import { documentSymbols, execProvider } from "../lsp-queries.js";

export type LanguageSupportState = "available" | "limited" | "missing" | "unknown";

export interface LanguageSupportStatus {
  lang: string;
  fileCount: number;
  status: LanguageSupportState;
  recommendation?: string;
  detail: string;
}

const SOURCE_LANGS = new Set([
  "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "kt", "kts", "scala", "sc", "dart",
  "rb", "php", "cs", "lua", "ex", "exs", "sh", "bash", "zsh", "ksh", "fish",
  "c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh",
  "vue", "svelte", "cshtml", "razor",
]);

const RECOMMENDATIONS: Record<string, string> = {
  py: "ms-python.python",
  go: "golang.go",
  rs: "rust-lang.rust-analyzer",
  java: "redhat.java",
  cs: "ms-dotnettools.csharp",
  cshtml: "ms-dotnettools.csharp",
  razor: "ms-dotnettools.csharp",
  c: "ms-vscode.cpptools",
  h: "ms-vscode.cpptools",
  cpp: "ms-vscode.cpptools",
  hpp: "ms-vscode.cpptools",
  cc: "ms-vscode.cpptools",
  cxx: "ms-vscode.cpptools",
  hxx: "ms-vscode.cpptools",
  hh: "ms-vscode.cpptools",
  rb: "Shopify.ruby-lsp",
  php: "bmewburn.vscode-intelephense-client",
  vue: "Vue.volar",
  svelte: "svelte.svelte-vscode",
  /* Previously tracked in SOURCE_LANGS but absent here, which meant these
     languages could reach status "missing" and never get an install
     recommendation — the onboarding panel had no path to help their users. */
  dart: "Dart-Code.dart-code",
  kt: "fwcd.kotlin",
  kts: "fwcd.kotlin",
  scala: "scalameta.metals",
  sc: "scalameta.metals",
  lua: "sumneko.lua",
  ex: "JakeBecker.elixir-ls",
  exs: "JakeBecker.elixir-ls",
};

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

export interface MissingExtension {
  lang: string;
  extensionId: string;
}

/** Cheap, synchronous check for whether a language's recommended extension is
    installed — reuses the same signal `inspectLanguageSupport` computes via
    empirical probing, without running its per-file warmup/probe loop. Lets
    lsp-service.ts explain an empty code_* result instead of running a
    second, expensive detection pass per failed tool call. */
export function missingExtensionFor(path: string): MissingExtension | undefined {
  const lang = langOf(path);
  const rec = recommendationForLanguage(lang);
  if (!rec || vscode.extensions.getExtension(rec)) return undefined;
  return { lang, extensionId: rec };
}

export async function inspectLanguageSupport(
  roots: WorkspaceRoot[],
  files: readonly string[],
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
    const recommendation = recommendationForLanguage(lang);
    // The definitive "is this LSP on the user's machine" signal — no server round-trip needed.
    // If the recommended extension is installed, the language IS supported here even when its
    // server hasn't warmed up enough to answer the probe below, so we must never report it
    // "missing" or nag the user to install what they already have.
    const extensionInstalled = recommendation !== undefined && vscode.extensions.getExtension(recommendation) !== undefined;

    const sample = langFiles.slice(0, 3);
    let sawSymbols = false;
    let sawReferences = false;
    for (const rel of sample) {
      const absolute = fromNodeId(roots, rel);
      if (!absolute) continue;
      const uri = vscode.Uri.file(absolute);
      // Open the document so its language extension activates (onLanguage:*): the symbol
      // provider frequently isn't registered until a file of that language has been opened,
      // which is exactly the state the Map is in at startup before the user touches one.
      try { await vscode.workspace.openTextDocument(uri); } catch { continue; }
      // Reuse the shared LSP layer (same 9s timeout + cold-server warmup the working "Trace
      // relationships" path uses) so detection can't be more impatient than the feature it
      // gates — the old bespoke 1200ms/no-retry probe was the reason installed-but-cold
      // servers looked absent.
      const symbolOutcome = await documentSymbols(uri, { maxAttempts: 4, delayMs: 300 });
      if (symbolOutcome.status !== "ok" || symbolOutcome.value.length === 0) continue;
      const symbols = symbolOutcome.value;
      sawSymbols = true;
      const pos = firstSymbolPosition(symbols);
      if (!pos) continue;
      const refs = await execProvider<vscode.Location[]>("vscode.executeReferenceProvider", [uri, pos]);
      if (refs.status === "ok" && Array.isArray(refs.value)) sawReferences = true;
      if (sawSymbols && sawReferences) break;
    }

    const status: LanguageSupportState = sawSymbols && sawReferences
      ? "available"
      : sawSymbols
        ? "limited"
        : extensionInstalled
          ? "unknown"   // installed but not answering yet (large project still indexing, etc.)
          : "missing";  // no provider answered and no known extension is installed
    statuses.push({
      lang,
      fileCount: langFiles.length,
      status,
      // Suppress the install recommendation once the extension is present, so neither the
      // onboarding panel nor the toast ever nags to install an LSP the user already has.
      recommendation: extensionInstalled ? undefined : recommendation,
      detail: status === "available"
        ? "Symbols and references are available."
        : status === "limited"
          ? "Symbols are available, but references are limited."
          : status === "unknown"
            ? "The language extension is installed but its server hasn't answered yet."
            : "No symbol provider answered for sampled files.",
    });
  }
  return statuses;
}
