/* The agent's diagram tools: check, read, save, edit.
 *
 * What they add over file_write and file_edit is validation before the write. A diagram that
 * does not parse is refused with the parser's line and a numbered excerpt around it, so the
 * agent fixes the one line instead of the user finding a red error panel later. An edit is
 * all-or-nothing, and a failed check leaves the saved file exactly as it was.
 */

import * as path from "node:path";
import { chartSeriesNames, describeChart, parseChartSpec } from "../shared/chart-spec.js";
import { MAX_DIAGRAM_SOURCE_CHARS, describeMermaid } from "../shared/mermaid-source.js";
import { applyDiagramEdits, excerptAround, normalizeSource, numberedLines, type DiagramEdit } from "./diagram-edit.js";
import type { DiagramCheck } from "./diagram-checker.js";
import { DIAGRAMS_DIR, type DiagramStore } from "./diagram-store.js";

export interface DiagramToolDeps {
  store: DiagramStore;
  checker: { check(source: string): Promise<DiagramCheck> };
  /** Show a saved diagram in the viewer, which then follows the file as it changes. */
  openInViewer?: (absolutePath: string) => void | Promise<void>;
}

type Payload = Record<string, unknown>;
type Result = Record<string, unknown>;

/** Past this many links dagre's layout gets tangled enough to hurt; ELK copes with more. */
const ELK_LINK_THRESHOLD = 35;
const SPLIT_LINK_THRESHOLD = 140;

const LINK = /(?:<-->|-->|==>|-\.->|---|--[ox]|~~~|<-\.->|<==>)/g;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function flag(value: unknown): boolean {
  return value === true;
}

/** The size facts that decide how a diagram should be drawn and maintained. */
export function diagramStats(source: string): { lines: number; chars: number; links: number } {
  const body = normalizeSource(source);
  return { lines: body.split("\n").length, chars: body.length, links: (body.match(LINK) ?? []).length };
}

/** Advice the parser cannot give: the diagram is valid but will not read well. */
export function diagramAdvice(source: string, kind: string): string[] {
  const { links } = diagramStats(source);
  const advice: string[] = [];
  const flowLike = kind === "Flowchart" || kind === "State diagram" || kind === "Class diagram";
  if (flowLike && links > SPLIT_LINK_THRESHOLD) {
    advice.push(`About ${links} links is more than one diagram can show legibly. Split it: an overview with one node per subsystem, then a diagram per subsystem.`);
  }
  if (kind === "Flowchart" && links > ELK_LINK_THRESHOLD && !/\blayout\s*:\s*elk\b|flowchart-elk/i.test(source)) {
    // Measured on 60-70 node graphs: ELK untangles a flat, dense graph (layered, orthogonal
    // routes) but stacks subgraphs into a tall column with long detours, which dagre does not.
    advice.push(/^\s*subgraph\b/m.test(source)
      ? "This flowchart has enough links to get busy. It uses subgraphs, which the default layout handles better than ELK; reduce cross-links between subgraphs, or draw an overview and one diagram per subgraph."
      : "This flowchart has enough links that the default layout will tangle. Add front matter (a `---` block on the first lines) with `config:` then `  layout: elk` for layered, orthogonal routing; look at the result in the viewer before keeping it.");
  }
  return advice;
}

function describeFailure(source: string, check: DiagramCheck): Result {
  return {
    ok: false,
    error: check.error ?? "The diagram does not parse.",
    ...(check.line
      ? {
        line: check.line,
        context: excerptAround(source, check.line),
        lineNote: "Mermaid reports the line where parsing gave up, which is sometimes the line after the real mistake (an unclosed bracket or quote). Read the excerpt, not just the number.",
      }
      : {}),
  };
}

function parseEdits(value: unknown): DiagramEdit[] | string {
  if (!Array.isArray(value) || value.length === 0) return "`edits` must be a non-empty array.";
  const edits: DiagramEdit[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `Edit ${index + 1} is not an object.`;
    const record = raw as Record<string, unknown>;
    const edit: DiagramEdit = {};
    if (typeof record["find"] === "string") edit.find = record["find"];
    if (typeof record["replace"] === "string") edit.replace = record["replace"];
    if (typeof record["insert"] === "string") edit.insert = record["insert"];
    if (record["all"] === true) edit.all = true;
    for (const key of ["fromLine", "toLine", "afterLine"] as const) {
      if (record[key] !== undefined) {
        const number = typeof record[key] === "string" ? Number(record[key]) : record[key];
        if (typeof number === "number") edit[key] = number;
      }
    }
    edits.push(edit);
  }
  return edits;
}

export class DiagramToolService {
  constructor(private readonly _deps: DiagramToolDeps) {}

  async dispatch(op: string, payload: Payload): Promise<Result> {
    switch (op) {
      case "check": return this._check(payload);
      case "read": return this._read(payload);
      case "save": return this._save(payload);
      case "edit": return this._edit(payload);
      default: return { ok: false, error: `Unknown diagram operation: ${op}` };
    }
  }

  private async _verdict(source: string): Promise<{ check: DiagramCheck; kind: string; title?: string }> {
    const { kind, title } = describeMermaid(source);
    return { check: await this._deps.checker.check(source), kind, ...(title ? { title } : {}) };
  }

  private async _check(payload: Payload): Promise<Result> {
    let source = text(payload["source"]);
    let file: string | undefined;
    if (!source) {
      const name = text(payload["name"]);
      if (!name) return { ok: false, error: "Give `source`, or the `name` of a saved diagram." };
      const saved = this._deps.store.read(name);
      if (!saved.ok) return saved;
      source = saved.source;
      file = saved.file;
    }
    const language = text(payload["language"]);
    if (language === "chart" || (language === undefined && !file && source.trimStart().startsWith("{"))) {
      return this._checkChart(source);
    }
    if (source.length > MAX_DIAGRAM_SOURCE_CHARS) {
      return { ok: false, error: `The diagram is ${source.length.toLocaleString()} characters; Mermaid draws at most ${MAX_DIAGRAM_SOURCE_CHARS.toLocaleString()}. Split it.` };
    }
    const { check, kind, title } = await this._verdict(source);
    const stats = diagramStats(source);
    if (!check.ok) return { ...describeFailure(source, check), kind, ...stats, ...(file ? { file } : {}) };
    const advice = diagramAdvice(source, kind);
    return {
      ok: true,
      checked: check.checked,
      ...(check.checked ? {} : { note: `Not verified: ${check.note ?? "the checker is unavailable"}. The diagram was not shown to be wrong.` }),
      kind,
      ...(title ? { title } : {}),
      ...stats,
      ...(file ? { file } : {}),
      ...(advice.length ? { advice } : {}),
    };
  }

  /** A `chart` block's JSON, checked by the parser the chat draws it with. */
  private _checkChart(source: string): Result {
    const parsed = parseChartSpec(source);
    if (!parsed.ok) return { ok: false, language: "chart", error: parsed.error };
    const { spec } = parsed;
    return {
      ok: true,
      checked: true,
      language: "chart",
      kind: describeChart(spec),
      type: spec.type,
      rows: spec.rows.length,
      series: chartSeriesNames(spec).length || undefined,
    };
  }

  private _read(payload: Payload): Result {
    const name = text(payload["name"]);
    if (!name) {
      const diagrams = this._deps.store.list();
      return { ok: true, directory: DIAGRAMS_DIR.split(path.sep).join("/"), count: diagrams.length, diagrams };
    }
    const saved = this._deps.store.read(name);
    if (!saved.ok) return saved;
    const from = typeof payload["fromLine"] === "number" ? payload["fromLine"] : 1;
    const to = typeof payload["toLine"] === "number" ? payload["toLine"] : undefined;
    const view = numberedLines(saved.source, from, to);
    const { kind, title } = describeMermaid(saved.source);
    return {
      ok: true,
      name: saved.name,
      file: saved.file,
      kind,
      ...(title ? { title } : {}),
      totalLines: view.total,
      fromLine: view.from,
      toLine: view.to,
      ...(view.to < view.total ? { more: `Lines ${view.to + 1}–${view.total} follow; read them with fromLine: ${view.to + 1}.` } : {}),
      lines: view.text,
    };
  }

  private async _save(payload: Payload): Promise<Result> {
    const name = text(payload["name"]);
    const source = text(payload["source"]);
    if (!name) return { ok: false, error: "`name` is required." };
    if (!source) return { ok: false, error: "`source` is required." };
    const body = normalizeSource(source);
    const { check, kind, title } = await this._verdict(body);
    if (!check.ok && !flag(payload["allowInvalid"])) {
      return { ...describeFailure(body, check), saved: false, hint: "Nothing was saved. Fix the diagram and save again." };
    }
    const written = this._deps.store.write(name, body, { overwrite: flag(payload["overwrite"]) });
    if (!written.ok) return written;
    await this._open(written.name, payload);
    const advice = check.ok ? diagramAdvice(body, kind) : [];
    return {
      ok: true,
      saved: true,
      created: written.created,
      name: written.name,
      file: written.file,
      kind,
      ...(title ? { title } : {}),
      ...diagramStats(body),
      checked: check.checked,
      ...(check.ok ? {} : { warning: `Saved although it does not parse: ${check.error ?? "unknown error"}` }),
      ...(advice.length ? { advice } : {}),
      next: "Change it later with diagram_edit (exact text, line ranges, or insertions) instead of saving the whole diagram again.",
    };
  }

  private async _edit(payload: Payload): Promise<Result> {
    const name = text(payload["name"]);
    if (!name) return { ok: false, error: "`name` is required." };
    const edits = parseEdits(payload["edits"]);
    if (typeof edits === "string") return { ok: false, error: edits };

    const current = this._deps.store.read(name);
    if (!current.ok) return current;
    const applied = applyDiagramEdits(current.source, edits);
    if (!applied.ok) return { ok: false, error: applied.error };

    const { check, kind, title } = await this._verdict(applied.source);
    if (!check.ok && !flag(payload["allowInvalid"])) {
      return {
        ...describeFailure(applied.source, check),
        saved: false,
        hint: "The edits were not saved; the file is unchanged. Line numbers above are in the diagram as the edits would leave it.",
      };
    }
    const written = this._deps.store.write(current.name, applied.source, { overwrite: true });
    if (!written.ok) return written;
    await this._open(written.name, payload);
    const advice = check.ok ? diagramAdvice(applied.source, kind) : [];
    return {
      ok: true,
      saved: true,
      name: written.name,
      file: written.file,
      kind,
      ...(title ? { title } : {}),
      edits: applied.summary,
      ...diagramStats(applied.source),
      checked: check.checked,
      ...(check.ok ? {} : { warning: `Saved although it does not parse: ${check.error ?? "unknown error"}` }),
      ...(advice.length ? { advice } : {}),
      undo: `The previous version is kept as ${path.basename(written.name)}.bak next to the file.`,
    };
  }

  private async _open(name: string, payload: Payload): Promise<void> {
    if (!flag(payload["open"]) || !this._deps.openInViewer) return;
    const absolute = this._deps.store.resolve(name);
    if (absolute) await this._deps.openInViewer(absolute);
  }
}
