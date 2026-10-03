/* Mermaid's parser, outside a browser.
 *
 * The agent writes diagram source, and a mistake in it used to be found only by the user, as an
 * error panel under the reply. This runs Mermaid's own parser — the same code the webview draws
 * with — so the mistake is found before the reply is sent. It checks syntax, not layout: a
 * diagram that parses can still be too large or too tangled to read, which is for the agent's
 * judgement, not a parser's.
 *
 * Mermaid expects a DOM (DOMPurify sanitises the text it parses), so this installs linkedom's
 * `window` and `document` as globals. That is fine in a worker thread and wrong anywhere
 * else; the extension host must only reach this through diagram-checker.ts.
 */

import * as fs from "node:fs";
import * as vm from "node:vm";
import { parseHTML } from "linkedom";

export interface ParseOutcome {
  ok: boolean;
  /** Mermaid's name for the detected diagram, e.g. "flowchart-v2". */
  diagramType?: string;
  /** The parser's message, trimmed. */
  error?: string;
  /** One-based line the parser blames, within the source it was given. */
  line?: number;
}

export interface MermaidParser {
  parse(source: string): Promise<ParseOutcome>;
}

interface MermaidGlobal {
  initialize(config: Record<string, unknown>): void;
  parse(source: string, options?: { suppressErrors?: boolean }): Promise<false | { diagramType: string }>;
}

const MAX_ERROR_CHARS = 700;

/** The line a Mermaid error names — "Parse error on line 3:", "Lexer error on line 3, column 4" —
 *  or undefined when the message does not carry one. */
export function errorLine(message: string): number | undefined {
  const match = /\bline (\d+)/i.exec(message);
  const line = match ? Number.parseInt(match[1]!, 10) : NaN;
  return Number.isFinite(line) && line > 0 ? line : undefined;
}

/** Mermaid's error text without the ASCII-art pointer it draws under the source line. */
export function tidyError(message: string): string {
  const trimmed = message.replace(/\r/g, "").trim();
  if (!trimmed) return "Mermaid could not parse this diagram.";
  return trimmed.length > MAX_ERROR_CHARS ? `${trimmed.slice(0, MAX_ERROR_CHARS)}…` : trimmed;
}

/** Load Mermaid's standalone build (the file the Markdown-preview fallback already ships) and
 *  return a parser over it. Installs DOM globals; see the file comment. */
export function loadMermaidParser(libraryPath: string): MermaidParser {
  // linkedom's return value is the window itself, which also names itself as `window`.
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>") as unknown as { document: unknown };
  const target = globalThis as Record<string, unknown>;
  target.window = dom;
  target.document = dom.document;
  // Mermaid checks a `box` colour by assigning it to `new Option().style.color`.
  target.Option ??= class Option { style: Record<string, string> = {}; };

  vm.runInThisContext(fs.readFileSync(libraryPath, "utf8"), { filename: libraryPath });
  const mermaid = target.mermaid as MermaidGlobal | undefined;
  if (!mermaid) throw new Error("The Mermaid library did not load.");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });

  return {
    async parse(source: string): Promise<ParseOutcome> {
      try {
        const result = await mermaid.parse(source, { suppressErrors: false });
        return result ? { ok: true, diagramType: result.diagramType } : { ok: false, error: "Mermaid could not parse this diagram." };
      } catch (error) {
        const message = tidyError(error instanceof Error ? error.message : String(error ?? ""));
        const line = errorLine(message);
        return { ok: false, error: message, ...(line ? { line } : {}) };
      }
    },
  };
}
